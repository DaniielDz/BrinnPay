import type { Prisma } from '../../generated/prisma/client';
import type { Environment } from '../projects/environment';
import { PAYMENT_EVENTS } from '../payments/payment-events';
import { REFUND_EVENTS } from '../refunds/refund-events';

/**
 * The webhook event catalog and the inbound emission port (phase 10 §4.1/§4.2).
 *
 * **Catalog ownership.** The payments and refunds modules own their event
 * types; this module never declares an event of its own (phase 10 adds no event
 * type). The catalog below is *derived* from those constants rather than
 * duplicated, so endpoint validation and delivery matching cannot drift from the
 * emitters.
 *
 * **The port.** Payments and refunds call {@link WebhookEventPort} and never
 * touch a `webhook_*` table (phase 1 §6.3/§6.4). The port is the single inbound
 * boundary that (a) durably records the event in the *emitting* module's
 * transaction and (b) schedules delivery. D2 makes the write transactional, so a
 * rolled-back mutation can never leave a phantom event and a crash between commit
 * and enqueue can never lose one; enqueue itself stays best-effort (§4.3.7) with
 * the reconciliation job as the safety net.
 */

/** Every event type BrinnPay emits, in catalog order. */
export const WEBHOOK_EVENT_TYPES = [...PAYMENT_EVENTS, ...REFUND_EVENTS] as const;

/** Union of the owning modules' event types. */
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** D1: the catalog is **closed** — unknown types are rejected, not stored. */
export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * A domain event as the owning module produces it, before persistence.
 *
 * The shape is already the phase 1 §9.5 outbound envelope: `data` is a
 * point-in-time snapshot, so later changes to the payment or refund never rewrite
 * a stored event (§4.3.3).
 */
export interface DomainEvent {
  /** UUIDv7, supplied by the emitter: re-persisting it is a no-op (§4.3.5). */
  id: string;
  type: WebhookEventType;
  created_at: Date;
  data: unknown;
  environment: Environment;
  project_id: string;
  /**
   * The API request that produced the event, when there is one. Recorded on the
   * delivery rows the event produces (phase 1 §7.7, F4) — it is **not** part of
   * the envelope and is never sent to the destination.
   */
  request_id?: string | null;
}

/** The stored envelope: exactly what is delivered, byte for byte (§4.3.2). */
export interface WebhookEnvelope {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: unknown;
  environment: Environment;
  project_id: string;
}

/**
 * The transaction handle the port writes through. A cross-cutting idempotency
 * transaction is structurally compatible, which is what lets an event commit
 * atomically with the mutation that produced it.
 */
export type WebhookEventTransaction = Prisma.TransactionClient;

/** Nest DI token for the inbound port the payments/refunds modules call. */
export const WEBHOOK_EVENT_PORT = 'WEBHOOK_EVENT_PORT';

/**
 * The emission boundary (phase 10 §4.1). Implemented once by the webhooks
 * module; the payments and refunds modules only depend on this interface.
 */
export interface WebhookEventPort {
  /**
   * Records the event and the deliveries it implies **inside the caller's
   * transaction**, so the event exists if and only if the business transaction
   * committed (§4.3.4). Idempotent in the event `id`.
   */
  persist(tx: WebhookEventTransaction, event: DomainEvent): Promise<void>;

  /**
   * Queues the pending deliveries of an already-persisted event. Called
   * **after** the transaction commits. Best-effort by design: a Redis or queue
   * failure is logged and swallowed, never surfaced to the domain request
   * (§4.3.7); the reconciliation job creates the missing deliveries later.
   */
  dispatch(eventId: string): Promise<void>;
}

/** Serializes an envelope once, so every attempt and replay sends the same bytes. */
export function serializeEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}

/** Builds the canonical envelope stored in `webhook_events.payload` (§4.3.2). */
export function toEnvelope(event: DomainEvent): WebhookEnvelope {
  return {
    id: event.id,
    type: event.type,
    created_at: event.created_at.toISOString(),
    data: event.data,
    environment: event.environment,
    project_id: event.project_id,
  };
}
