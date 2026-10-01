import type { Environment } from '../projects/environment';
import type { PaymentResponse } from './payment-types';

/**
 * Payment event catalog (phase 7 §4.7, D10 — phase 1 §9.1/§9.4/§9.5 ownership).
 *
 * Naming follows `<resource>.<past-tense-verb>`: `payment.created`,
 * `payment.succeeded`, `payment.failed`. There is deliberately no
 * `payment.processing` event (past-tense convention; noise — Phase 16 may
 * revisit). The outbound envelope is the phase 1 §9.5 shape with a UUIDv7
 * event id and the payment's `environment`/`project_id`.
 *
 * The payments module emits through the webhooks module's inbound
 * `WEBHOOK_EVENT_PORT` only, and never touches a `webhook_*` table (phase 10
 * §4.1). This file owns the catalog and the event shape; the webhooks module
 * derives its validation catalog from `PAYMENT_EVENTS` so the two cannot drift.
 *
 * Phase 7 wired a no-op sink here; Phase 10 replaced it with that single durable
 * port (D2), so the emission point — and therefore the event's semantics — is
 * unchanged from Phase 7.
 */
export const PAYMENT_EVENTS = ['payment.created', 'payment.succeeded', 'payment.failed'] as const;
export type PaymentEventType = (typeof PAYMENT_EVENTS)[number];

export interface PaymentEvent {
  id: string;
  type: PaymentEventType;
  created_at: Date;
  data: PaymentResponse;
  environment: Environment;
  project_id: string;
  /**
   * The API request that produced the event, when there is one (phase 10 §4.3.11,
   * F4 — phase 1 §7.7). The webhooks port records it on the delivery rows the
   * event produces; it is **not** part of the envelope and is never sent to a
   * destination. The sweep and the CAS have no request, so it is `null` there.
   */
  request_id?: string | null;
}