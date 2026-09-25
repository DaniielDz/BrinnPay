import { Injectable } from '@nestjs/common';

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
 * The payments module emits through this seam only; persistence, webhook
 * delivery, and retries are Phase 10 (the webhooks module reuses the sink
 * boundary). Phase 7 wires a no-op implementation.
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
}

/** Nest DI token for the event sink (phase 10 provides the real sink). */
export const PAYMENT_EVENT_SINK = 'PAYMENT_EVENT_SINK';

/** The emission boundary the payments module calls into. */
export interface PaymentEventSink {
  emit(event: PaymentEvent): void | Promise<void>;
}

/** Phase 7 default: events are emitted into a no-op sink. */
@Injectable()
export class NoopPaymentEventSink implements PaymentEventSink {
  emit(event: PaymentEvent): void {
    // Phase 7 intentionally drops events at the seam; Phase 10 provides the
    // persistent/webhook-backed implementation.
    void event;
  }
}