import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  buildSignatureHeader,
  decryptWebhookSecret,
  WEBHOOK_SECRET_KEY,
} from './webhook-crypto';
import { serializeEnvelope, type WebhookEnvelope } from './webhook-events';
import {
  classifyResponseStatus,
  classifyTransportError,
  hasAttemptsRemaining,
  nextAttemptDelayMs,
  parseRetryAfter,
  sanitizeErrorSummary,
} from './webhook-retry';
import {
  WebhookQueueService,
  WEBHOOK_DELIVERY_POLICY,
  type WebhookDeliveryPolicy,
} from './webhook-queue.service';
import { assertDestinationAllowed, WEBHOOK_DESTINATIONS, type DestinationPolicy } from './webhook-url';

/** Statuses whose `Retry-After` header is honored (D6). */
const RETRY_AFTER_STATUSES = new Set([429, 503]);

/** What one attempt observed. */
interface SendResult {
  kind: 'delivered' | 'failed' | 'retry';
  reason: string;
  responseStatus: number | null;
  retryAfter: string | null;
}

interface AttemptTarget {
  id: string;
  endpointId: string;
  eventId: string;
  attempts: number;
}

/**
 * The delivery executor (phase 10 §5.2–§5.5, D4/D6/D7).
 *
 * One invocation performs **one** HTTP attempt and records its outcome on the
 * delivery aggregate. The worker calls it; nothing else does.
 *
 * **Idempotent by construction.** The endpoint and the delivery are re-read
 * before the request is made, so a deleted endpoint or a delivery that already
 * reached a terminal state is a safe no-op, and a job removal race is harmless.
 * Delivery is at-least-once (§4.1.8), so a *concurrent* duplicate can still make
 * two requests; a destination deduplicates on `BrinnPay-Delivery-Id` (D7).
 *
 * **The body is serialized once** and reused for every attempt and for a replay,
 * so a signature can never disagree with the bytes it travels with (§5.2). Only
 * the signature timestamp is regenerated per attempt.
 *
 * **Nothing sensitive is retained or logged.** Response bodies are discarded
 * without being read, a bounded sanitized summary is stored instead, and the
 * signing secret never appears in a log line or an error.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WebhookQueueService,
    @Inject(WEBHOOK_SECRET_KEY) private readonly secretKey: Buffer,
    @Inject(WEBHOOK_DELIVERY_POLICY) private readonly policy: WebhookDeliveryPolicy,
    @Inject(WEBHOOK_DESTINATIONS) private readonly destinations: DestinationPolicy,
  ) {}

  /**
   * Performs one attempt of `deliveryId`. Never throws for a destination
   * failure: every outcome is recorded on the row and reflected in the return
   * value, because a failing destination must not crash the worker.
   */
  async attempt(deliveryId: string): Promise<'delivered' | 'failed' | 'skipped' | 'retry'> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true, event: true },
    });
    if (!delivery) {
      // The endpoint (and with it the delivery) was deleted after the job was
      // queued: D11 makes a deleted endpoint a successful no-op.
      this.logger.debug({ delivery_id: deliveryId }, 'Delivery no longer exists; nothing to do.');
      return 'skipped';
    }
    if (delivery.status !== 'pending') {
      // Already terminal, or a duplicate job whose sibling attempt finished first.
      return 'skipped';
    }
    // `enabled` is deliberately **not** re-checked here: D11 makes it a switch on
    // *enqueueing* of new deliveries only, so a delivery that is already queued is
    // still attempted and its outcome recorded. Re-reading the endpoint is what
    // makes a deleted endpoint a no-op, not a disabled one.

    // The destination policy **is** re-checked, unlike `enabled`: it is a
    // deployment control that ADR-0019 relies on as the compensating control for
    // a permissive-by-default destination posture, and it is worthless if it only
    // applies to endpoints registered after it was set. An operator adding a host
    // to the denylist during an incident needs the in-flight deliveries to stop,
    // not just the next registration to fail. A denied host is terminal, not
    // retryable: retrying would keep contacting the very host the operator
    // removed.
    try {
      assertDestinationAllowed(delivery.endpoint.url, this.destinations);
    } catch {
      return this.recordTerminal(
        delivery,
        {
          kind: 'failed',
          reason: 'destination rejected by the configured webhook destination policy',
          responseStatus: null,
          retryAfter: null,
        },
        // `attempts` counts HTTP requests made (§5.1). A policy denial makes none,
        // so it is passed through unchanged: recording an attempt here would show
        // an operator debugging a denylist incident a phantom request.
        delivery.attempts,
      );
    }

    const attemptNumber = delivery.attempts + 1;
    // Serialized once per attempt from the stored envelope: the exact bytes that
    // are transmitted are the exact bytes that were signed.
    // The stored `payload` **is** the envelope (§4.3.2), so serializing it is what
    // the destination receives; the cast is a structural assertion, not a
    // transformation.
    const body = serializeEnvelope(delivery.event.payload as unknown as WebhookEnvelope);
    const timestamp = Math.floor(Date.now() / 1000);

    let outcome: SendResult;
    try {
      const secret = decryptWebhookSecret(
        {
          ciphertext: delivery.endpoint.secretCipher,
          iv: delivery.endpoint.secretIv,
          authTag: delivery.endpoint.secretAuthTag,
        },
        this.secretKey,
      );
      outcome = await this.send(delivery.endpoint.url, body, {
        secret,
        timestamp,
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        eventType: delivery.event.type,
        attempt: attemptNumber,
      });
    } catch (error) {
      // A tampered or undecryptable secret must not retry forever; the record
      // is terminal and the endpoint has to be recreated (D8).
      outcome = {
        kind: 'failed',
        reason: `stored signing secret could not be decrypted: ${sanitizeErrorSummary(error)}`,
        responseStatus: null,
        retryAfter: null,
      };
    }

    if (outcome.kind === 'delivered') {
      return this.recordTerminal(delivery, outcome, attemptNumber);
    }

    const mayRetry =
      outcome.kind === 'retry' && hasAttemptsRemaining(attemptNumber, this.policy.maxAttempts);
    if (!mayRetry) {
      return this.recordTerminal(delivery, outcome, attemptNumber);
    }

    // A `Retry-After` on 429/503 overrides the backoff ceiling, clamped to the
    // configured maximum so a destination cannot postpone a delivery forever. A
    // header that yields no positive delay (absent, malformed, `0`, or a past
    // date) is not an override at all, so the ladder applies.
    const retryAfter =
      outcome.responseStatus !== null && RETRY_AFTER_STATUSES.has(outcome.responseStatus)
        ? parseRetryAfter(outcome.retryAfter, new Date(), this.policy.maxBackoffMs)
        : undefined;
    const delayMs =
      retryAfter !== undefined && retryAfter > 0
        ? retryAfter
        : nextAttemptDelayMs(attemptNumber + 1, this.policy);

    const now = new Date();
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    // Conditional on `pending`: since a retry is a *new* job with a fresh id, a
    // duplicate or concurrent attempt can reach this point for a row that has
    // already moved on. Booking the attempt must not resurrect it, and must not
    // re-queue work the row no longer expects.
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: 'pending' },
      data: {
        attempts: attemptNumber,
        responseStatus: outcome.responseStatus,
        lastError: sanitizeErrorSummary(outcome.reason),
        nextAttemptAt,
        updatedAt: now,
      },
    });
    if (claimed.count === 0) {
      this.logger.debug(
        {
          delivery_id: delivery.id,
          endpoint_id: delivery.endpointId,
          event_id: delivery.eventId,
          attempt: attemptNumber,
        },
        'Delivery already advanced by a concurrent attempt; not scheduling another retry.',
      );
      return 'skipped';
    }

    // A retry is a new job with a delay: `next_attempt_at` on the row is the
    // authoritative schedule and `attempts` conveys progress (§5.5).
    await this.queue.enqueueDelivery(delivery.id, attemptNumber + 1, delayMs);

    this.logger.warn(
      {
        delivery_id: delivery.id,
        endpoint_id: delivery.endpointId,
        event_id: delivery.eventId,
        attempt: attemptNumber,
        next_attempt_at: nextAttemptAt.toISOString(),
        outcome: outcome.reason,
      },
      'Webhook delivery attempt failed; retry scheduled.',
    );
    return 'retry';
  }

  /**
   * Records a terminal outcome (`delivered` or `failed`) and clears the
   * schedule. The write is conditional on the row still being `pending`, so a
   * duplicate or concurrent attempt cannot overwrite an outcome that was already
   * recorded; such a lost race resolves to `skipped` rather than a false report
   * of this attempt's outcome.
   */
  private async recordTerminal(
    delivery: AttemptTarget,
    outcome: SendResult,
    attemptNumber?: number,
  ): Promise<'delivered' | 'failed' | 'skipped'> {
    const status = outcome.kind === 'delivered' ? 'delivered' : 'failed';
    const recorded = await this.prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: 'pending' },
      data: {
        status,
        attempts: attemptNumber ?? delivery.attempts,
        responseStatus: outcome.responseStatus,
        lastError: outcome.kind === 'delivered' ? null : sanitizeErrorSummary(outcome.reason),
        nextAttemptAt: null,
        updatedAt: new Date(),
      },
    });
    if (recorded.count === 0) {
      this.logger.debug(
        {
          delivery_id: delivery.id,
          endpoint_id: delivery.endpointId,
          event_id: delivery.eventId,
        },
        'Delivery already reached a terminal state; discarding this attempt outcome.',
      );
      return 'skipped';
    }

    this.logger.log(
      {
        delivery_id: delivery.id,
        endpoint_id: delivery.endpointId,
        event_id: delivery.eventId,
        status,
        response_status: outcome.responseStatus,
      },
      'Webhook delivery finished.',
    );
    return status;
  }

  /**
   * The outbound request (D6/D7, §5.4/§5.7).
   *
   * Redirects are **never** followed: a `3xx` is recorded as a failed attempt,
   * which closes the redirect-based SSRF and signature-confusion path and keeps
   * the delivered URL equal to the registered URL.
   *
   * The attempt is bounded by a single total timeout, plus a shorter one that
   * also covers the head of the response. `fetch` exposes no separate connect
   * phase, so `connectTimeoutMs` cannot be a connect-only budget: it aborts the
   * whole request, which makes the effective bound `min(connectTimeoutMs,
   * requestTimeoutMs)`. That is the property that matters — a hung destination
   * cannot hold a worker slot indefinitely — and it is why the shipped defaults
   * (5 s / 10 s) yield 5 s. `requestTimeoutMs` only ever shortens the bound;
   * raising `connectTimeoutMs` raises the total timeout, it does not grant extra
   * connect allowance. A real connect-phase budget needs an undici dispatcher
   * hook and is a hardened-mode item, not a v1 claim (ADR-0019).
   *
   * The response body is discarded without being read, so an unbounded or hostile
   * payload is never buffered, stored, or logged.
   */
  private async send(
    url: string,
    body: string,
    context: {
      secret: string;
      timestamp: number;
      deliveryId: string;
      eventId: string;
      eventType: string;
      attempt: number;
    },
  ): Promise<SendResult> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), this.policy.requestTimeoutMs);
    // Both timers abort the same request, so the earlier one wins and the
    // effective bound is the smaller of the two (see the note above).
    const headTimer = setTimeout(() => controller.abort(), this.policy.connectTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BrinnPay-Webhooks/1.0',
          'BrinnPay-Signature': buildSignatureHeader({
            secret: context.secret,
            timestamp: context.timestamp,
            body,
          }),
          'BrinnPay-Event-Id': context.eventId,
          'BrinnPay-Event-Type': context.eventType,
          'BrinnPay-Delivery-Id': context.deliveryId,
          'BrinnPay-Attempt': String(context.attempt),
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      // The response head arrived; the connect phase is done.
      clearTimeout(headTimer);
      await response.body?.cancel().catch(() => undefined);

      const classified = classifyResponseStatus(response.status);
      return {
        kind: classified.kind,
        reason: classified.reason,
        responseStatus: response.status,
        retryAfter: response.headers.get('retry-after'),
      };
    } catch (error) {
      const classified = classifyTransportError(error);
      return {
        kind: classified.kind,
        reason: classified.reason,
        responseStatus: null,
        retryAfter: null,
      };
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(headTimer);
    }
  }
}
