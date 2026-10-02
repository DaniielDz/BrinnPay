import { randomUUID } from 'node:crypto';

/**
 * Queue topology (phase 10 §5.3, ADR-0013, D14).
 *
 * The API process only **enqueues**; a separate worker process consumes. That
 * keeps delivery latency and failure modes off the request-serving path and lets
 * a second API replica run without duplicating consumers.
 *
 * One queue carries every job, discriminated by `name`. BullMQ repeatable jobs
 * drive the three periodic passes; the delivery jobs are plain one-shot jobs,
 * and a retry is a new job with a delay rather than a re-run of the same one, so
 * `next_attempt_at` on the delivery row is the authoritative schedule.
 */

/** Queue name (a single queue keeps the local Compose topology minimal). */
export const WEBHOOK_QUEUE_NAME = 'brinnpay-webhooks';

/** Job names. */
export const WEBHOOK_JOBS = {
  /** Perform one HTTP attempt of one delivery aggregate. */
  DELIVER: 'webhook.deliver',
  /**
   * Create the deliveries an event implies but does not have yet, and re-queue
   * pending deliveries whose job was lost. The safety net for "enqueue failed"
   * and for "endpoint created/enabled after the event" (D2).
   */
  RECONCILE: 'webhook.reconcile',
  /**
   * Ask the payments module to apply due terminal edges so `payment.succeeded` /
   * `payment.failed` fire without any read (D3, F2).
   */
  ADVANCE_PAYMENTS: 'webhook.advance-payments',
  /** Drop events (and their deliveries) past the retention window (D9). */
  CLEANUP: 'webhook.cleanup',
} as const;

export type WebhookJobName = (typeof WEBHOOK_JOBS)[keyof typeof WEBHOOK_JOBS];

/** Payload of a `webhook.deliver` job. */
export interface DeliverJobData {
  delivery_id: string;
}

/** Data-carrying jobs. The three periodic passes take no arguments: they read
 *  their own scope from the database. */
export type WebhookJobData = Record<string, never>;

/**
 * `jobId` for a delivery attempt.
 *
 * The id is **unique per enqueue**: the delivery id and the attempt number are
 * kept for debuggability, and a random component makes the whole id fresh. The
 * attempt number alone is *not* sufficient — BullMQ deduplicates on the full
 * `jobId`, so a deterministic id makes a job that ended in the `failed` set
 * unre-queueable: its key still exists, the re-add is silently dropped, the
 * enqueue reports success, and the delivery stays `pending` forever while being
 * counted as requeued. A random component removes that class of stall and leaves
 * the aggregate's `status`/`attempts` CAS as the single authority on what has
 * already happened.
 *
 * The separators are `-`, never `:`: BullMQ builds its Redis keys as
 * `prefix:queue:jobId`, so a custom id containing `:` is rejected outright
 * (`Custom Id cannot contain :`). An id shaped like the one this function used to
 * return (`webhook.deliver:<id>:<attempt>:<uuid>`) makes every `queue.add` throw,
 * which the best-effort enqueue swallows — delivery silently never happens and
 * only reconciliation hides it, at one attempt per pass, behind the horizon.
 */
export function deliverJobId(deliveryId: string, attempt: number): string {
  return `${WEBHOOK_JOBS.DELIVER}-${deliveryId}-${attempt}-${randomUUID()}`;
}
