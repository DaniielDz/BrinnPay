import { Inject, Injectable, Logger } from '@nestjs/common';

import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventService } from './webhook-event.service';
import {
  RECONCILIATION_BATCH,
  RECONCILIATION_MIN_AGE_MS,
  WebhookQueueService,
  WEBHOOK_DELIVERY_POLICY,
  type WebhookDeliveryPolicy,
} from './webhook-queue.service';

/** Events deleted per statement by the retention pass (D9). */
const CLEANUP_BATCH = 500;

/**
 * How many pages one retention pass will delete. Bounds the pass's runtime: a
 * backlog larger than this carries over to the next one, and a project that is
 * genuinely expiring at scale gets a bounded amount of work per hour rather than
 * one statement that never finishes.
 */
const CLEANUP_MAX_PAGES = 20;

/**
 * The periodic maintenance passes (phase 10 §5.3, D2/D3/D9).
 *
 * Three passes, all driven by repeatable BullMQ jobs so they survive a restart and
 * run in the worker process rather than on the request path:
 *
 * 1. **Reconciliation** — creates the deliveries an event implies but does not
 *    have. This is the safety net for both "enqueue failed" and "the endpoint was
 *    created or enabled after the event", which is exactly what the post-commit
 *    best-effort enqueue (D2) can leave behind.
 * 2. **Advancement sweep** — asks the payments module to apply the due terminal
 *    edges, so `payment.succeeded`/`payment.failed` are emitted and delivered
 *    without anybody reading the payment (D3, F2). It adds a *driver*, not
 *    lifecycle rules: the payments module's compare-and-set still guards every
 *    edge, so the sweep cannot double-advance a payment.
 * 3. **Retention cleanup** — deletes events past the retention window, which
 *    cascades their delivery rows (D9). After it runs, a replay of an expired
 *    event is a 404 and the event is absent from listings.
 *
 * Every pass is bounded (a batch limit, never an unbounded scan) and swallows
 * per-item failures so one poisoned row cannot stall the schedule; the next pass
 * retries it.
 */
@Injectable()
export class WebhookMaintenanceService {
  private readonly logger = new Logger(WebhookMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: WebhookEventService,
    private readonly queue: WebhookQueueService,
    private readonly payments: PaymentsService,
    @Inject(WEBHOOK_DELIVERY_POLICY) private readonly policy: WebhookDeliveryPolicy,
  ) {}

  /**
   * D2: repair the fan-out and re-queue any pending delivery whose job was lost.
   * Returns how many delivery rows were created, for the worker's own log line.
   *
   * This is the pass's only log statement: one structured line, emitted only when
   * the pass actually repaired something, carrying the window bounds so a
   * surprising `created: 0` is diagnosable. Never a URL, a credential, or a
   * response body.
   */
  async reconcile(): Promise<{ created: number; requeued: number }> {
    const created = await this.events.reconcile();
    const requeued = await this.events.requeueDueDeliveries();
    if (created > 0 || requeued > 0) {
      this.logger.log(
        {
          repaired_deliveries: created,
          requeued_deliveries: requeued,
          horizon_ms: this.policy.reconciliationHorizonMs,
          min_age_ms: RECONCILIATION_MIN_AGE_MS,
          batch_limit: RECONCILIATION_BATCH,
        },
        'Webhook reconciliation pass completed.',
      );
    }
    return { created, requeued };
  }

  /**
   * D3/F2: the driver for terminal payment events. A failure here is logged and
   * swallowed — the payment itself is unaffected, and the next pass retries.
   */
  async advancePayments(): Promise<number> {
    try {
      return await this.payments.advanceDuePayments(new Date());
    } catch (error) {
      this.logger.warn(
        { reason: messageOf(error) },
        'Payment advancement sweep failed; the next pass retries.',
      );
      return 0;
    }
  }

  /**
   * D9: drop events (and, by cascade, their deliveries) older than the retention
   * window. Deliveries whose endpoint still exists but whose event has expired
   * cannot be listed or replayed any more, which is the documented behavior.
   *
   * **Batched, not a single unbounded `deleteMany`.** A pass that has been off
   * for a week — or a project that stopped being read long before retention
   * elapsed — hands one `DELETE` the entire backlog. Cascading into
   * `webhook_deliveries` inside a single statement holds row locks for the whole
   * set and runs as one long transaction, which is exactly the lock pressure the
   * other two passes deliberately avoid. Ids are therefore selected in bounded
   * pages and deleted per page, so each statement is short and a failure loses at
   * most one page. The loop stops on a partial page (nothing older is left) or
   * after {@link CLEANUP_MAX_PAGES} pages, so a very large backlog carries over
   * to the next pass instead of monopolizing the worker.
   *
   * A failure is logged and the count already removed is returned truthfully;
   * the next pass resumes from the cutoff.
   */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.policy.eventRetentionMs);
    let removed = 0;
    for (let page = 0; page < CLEANUP_MAX_PAGES; page += 1) {
      try {
        // Only the ids are read; the payloads are not fetched just to delete the
        // rows. `created_at` leads the selection so the cutoff is an index range
        // scan on `webhook_events_created_at_idx`.
        const expired = await this.prisma.webhookEvent.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { createdAt: 'asc' },
          take: CLEANUP_BATCH,
          select: { id: true },
        });
        if (expired.length === 0) {
          break;
        }

        const { count } = await this.prisma.webhookEvent.deleteMany({
          where: { id: { in: expired.map((event) => event.id) } },
        });
        removed += count;

        if (expired.length < CLEANUP_BATCH) {
          break; // the last page; nothing older remains
        }
      } catch (error) {
        this.logger.warn(
          { reason: messageOf(error), removed },
          'Retention cleanup failed; the next pass retries.',
        );
        return removed;
      }
    }
    if (removed > 0) {
      this.logger.log({ removed, cutoff: cutoff.toISOString() }, 'Expired events removed.');
    }
    return removed;
  }

  /** Registered once at worker boot so the schedule survives a restart. */
  async registerSchedule(): Promise<void> {
    await this.queue.ensureRepeatables();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
