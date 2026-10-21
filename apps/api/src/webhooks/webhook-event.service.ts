import { Inject, Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { uuidv7 } from '../common/uuid/uuid';
import { PrismaService } from '../prisma/prisma.service';
import type { Environment } from '../projects/environment';
import {
  toEnvelope,
  type DomainEvent,
  type WebhookEventPort,
  type WebhookEventTransaction,
} from './webhook-events';
import {
  RECONCILIATION_BATCH,
  RECONCILIATION_MIN_AGE_MS,
  REQUEUE_GRACE_MS,
  WebhookQueueService,
  WEBHOOK_DELIVERY_POLICY,
  type WebhookDeliveryPolicy,
} from './webhook-queue.service';

/**
 * Event persistence — the inbound port the payments and refunds modules call
 * (phase 10 §4.1/§5.3, D2).
 *
 * **Durability.** The event row is written inside the *emitting* module's
 * transaction, together with one delivery row per matching endpoint, so an event
 * exists if and only if the business transaction committed (§4.3.4) and a
 * crash between commit and enqueue cannot lose it (F3).
 *
 * **Idempotence.** The emitter owns the event id, so re-persisting the same event
 * is a no-op rather than a duplicate row (§4.3.5). The write uses
 * `INSERT … ON CONFLICT DO NOTHING`.
 *
 * **Fan-out.** An event produces at most one delivery per matching endpoint:
 * same project, same environment, `enabled = true`, and the type present in the
 * subscription (§4.3.6). Non-matching endpoints get no row and no job. The
 * partial unique index on `(event_id, endpoint_id) WHERE is_replay = false` is
 * what makes that guarantee hold under concurrency; a lost race is absorbed
 * rather than turned into an error.
 *
 * **Enqueue is best-effort.** It happens after the commit and never fails a
 * domain request (§4.3.7).
 */
@Injectable()
export class WebhookEventService implements WebhookEventPort {
  private readonly logger = new Logger(WebhookEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookQueueService,
    @Inject(WEBHOOK_DELIVERY_POLICY) private readonly policy: WebhookDeliveryPolicy,
  ) {}

  /**
   * Records the event and its implied deliveries inside the caller's
   * transaction. Never enqueues: the caller invokes {@link dispatch} after its
   * transaction commits, because a job that ran before the commit would find no
   * row.
   */
  async persist(tx: WebhookEventTransaction, event: DomainEvent): Promise<void> {
    // ON CONFLICT DO NOTHING: the emitter owns the id, so a repeated
    // persistence is a no-op rather than a second event.
    const inserted = await tx.webhookEvent.createMany({
      data: [
        {
          id: event.id,
          projectId: event.project_id,
          environment: event.environment,
          type: event.type,
          payload: toEnvelope(event) as unknown as Prisma.InputJsonValue,
          createdAt: event.created_at,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      return; // already persisted; the deliveries already exist too
    }

    await this.createDeliveries(tx, event);
  }

  /**
   * Queues the pending deliveries of an already-committed event (§4.3.7). Called
   * after the transaction commits. Best-effort: failures are logged and left to
   * reconciliation.
   */
  async dispatch(eventId: string): Promise<void> {
    try {
      const pending = await this.prisma.webhookDelivery.findMany({
        where: { eventId, status: 'pending' },
        select: { id: true, attempts: true },
        take: 500,
      });
      for (const delivery of pending) {
        await this.queue.enqueueDelivery(delivery.id, delivery.attempts + 1, 0);
      }
    } catch (error) {
      this.logger.warn(
        { event_id: eventId, reason: messageOf(error) },
        'Could not schedule webhook deliveries; reconciliation will recover.',
      );
    }
  }

  /**
   * Reconciliation (D2): creates the deliveries an event implies but does not
   * have, and re-queues pending deliveries whose job was lost. This is the
   * safety net for both "enqueue failed" and "endpoint created or enabled after
   * the event".
   *
   * The pass is deliberately **bounded in both directions**:
   *
   * - it scans **newest first** inside a `[now - horizon, now - minAge]` window,
   *   so the events most likely to be missing a fan-out are always inside the
   *   batch. An ascending scan re-reads a frozen prefix of the oldest rows and
   *   starves every genuinely missed delivery once a project passes the batch
   *   size — permanently and silently;
   * - it never walks the whole retention window, so a re-enabled endpoint is
   *   backfilled for the **recent** past only (the horizon), not for 30 days of
   *   events it was not subscribed to.
   *
   * The repair is per event and idempotent (the partial unique index absorbs a
   * concurrent pass), and each event is handled inside its own try/catch so one
   * poisoned row cannot stall the pass.
   */
  async reconcile(): Promise<number> {
    const now = Date.now();
    const oldest = new Date(now - RECONCILIATION_MIN_AGE_MS);
    const horizonStart = new Date(now - this.policy.reconciliationHorizonMs);
    const events = await this.prisma.webhookEvent.findMany({
      where: { createdAt: { gte: horizonStart, lte: oldest } },
      orderBy: { createdAt: 'desc' },
      take: RECONCILIATION_BATCH,
      select: { id: true, projectId: true, environment: true, type: true, createdAt: true },
    });

    let created = 0;
    for (const event of events) {
      try {
        // Only the identity is needed to recompute the fan-out: the envelope is
        // already stored and must never be rewritten (§5.1).
        //
        // `request_id: null` is deliberate and not a shortcut (D4/F4): the
        // delivery record carries the originating request id, but the specified
        // `webhook_events` row has no request column and the envelope has no
        // request id either, so a delivery *repaired* after the fact cannot name
        // the request that caused the event. Inventing a column here would change
        // the specified schema; the null is the honest answer, and the replay it
        // serves always records its own request id.
        const repaired = await this.prisma.$transaction(
          async (tx) =>
            this.createDeliveries(tx, {
              id: event.id,
              type: event.type as DomainEvent['type'],
              environment: event.environment as Environment,
              project_id: event.projectId,
              request_id: null,
            }),
          { maxWait: 5_000, timeout: 10_000 },
        );
        created += repaired;
        if (repaired > 0) {
          await this.dispatch(event.id);
        }
      } catch (error) {
        this.logger.warn(
          { event_id: event.id, reason: messageOf(error) },
          'Reconciliation pass failed for one event; it will be retried next pass.',
        );
      }
    }
    return created;
  }

  /**
   * Re-queues pending deliveries whose `next_attempt_at` has been due for longer
   * than {@link REQUEUE_GRACE_MS}. Covers a worker restart between "row updated"
   * and "job added", and the (rare) case of a job that BullMQ dropped.
   *
   * The grace window is what keeps this pass from duplicating healthy work: a
   * job that *was* enqueued successfully is waiting in `wait`, and its row looks
   * exactly like a stranded one until the grace elapses. See
   * {@link REQUEUE_GRACE_MS} for the full reasoning.
   *
   * A `next_attempt_at` of `null` is a delivery whose schedule was never booked
   * (the fan-out default before its first dispatch, or a row written by an older
   * build), so it is selected unconditionally: there is no timestamp to age, and
   * nothing was ever enqueued for it on a normal path.
   */
  async requeueDueDeliveries(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - REQUEUE_GRACE_MS);
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'pending',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: staleBefore } }],
      },
      orderBy: { createdAt: 'asc' },
      take: RECONCILIATION_BATCH,
      select: { id: true, attempts: true },
    });

    let queued = 0;
    for (const delivery of due) {
      // A delivery selected here is already due, so the job is added without a
      // delay; `next_attempt_at` remains the authoritative schedule for the
      // retries that are not due yet (§5.5).
      if (await this.queue.enqueueDelivery(delivery.id, delivery.attempts + 1, 0)) {
        queued += 1;
      }
    }
    return queued;
  }

  /**
   * Creates one delivery per matching enabled endpoint. Returns how many rows
   * this call added — a concurrent pass that wins the unique index contributes
   * zero, which is a successful no-op rather than an error.
   */
  private async createDeliveries(
    tx: WebhookEventTransaction,
    event: Pick<DomainEvent, 'id' | 'type' | 'environment' | 'project_id' | 'request_id'>,
  ): Promise<number> {
    const endpoints = await tx.webhookEndpoint.findMany({
      where: {
        projectId: event.project_id,
        environment: event.environment,
        enabled: true,
        eventTypes: { has: event.type },
      },
      select: { id: true },
    });
    if (endpoints.length === 0) {
      return 0;
    }

    const now = new Date();
    const result = await tx.webhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        id: uuidv7(),
        endpointId: endpoint.id,
        eventId: event.id,
        status: 'pending',
        attempts: 0,
        responseStatus: null,
        lastError: null,
        nextAttemptAt: now,
        // Phase 1 §7.7 / F4: the originating request is recorded on the delivery
        // row, never in the envelope and never sent to the destination.
        requestId: event.request_id ?? null,
        isReplay: false,
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
