import type { PaymentStatus } from './payment-types';

/**
 * Payment state machine and default-success simulation (phase 7 §4.6, D2).
 *
 * Legal transitions (only these edges exist):
 *
 * ```text
 * pending ──► processing ──► succeeded   (default simulation)
 *                      └──► failed       (defined; no public trigger in
 *                                        Phase 7 — decline/timeout are Phase 16)
 * ```
 *
 * Terminal states are absorbing. There are no user-initiated transitions (the
 * contract has no payment update/cancel endpoints); the simulation is the only
 * driver.
 *
 * The schedule is deterministic from `created_at` and the two delay constants
 * (pending delay, settlement delay) — no transition-time columns in the DB, so
 * a restart never strands a payment because advancement always derives from the
 * elapsed time (read-time catch-up). A `failed` outcome is supported by the
 * engine so service tests can exercise the edge and the event catalog without a
 * public trigger.
 */
export interface SimulationDelays {
  /** `pending → processing` fires at `created_at + pendingDelayMs`. */
  pendingDelayMs: number;
  /** `processing → succeeded|failed` fires at `created_at + pendingDelayMs +
   *  settlementDelayMs`. */
  settlementDelayMs: number;
}

export const DEFAULT_SIMULATION_DELAYS: SimulationDelays = {
  pendingDelayMs: 1_000,
  settlementDelayMs: 2_000,
};

/** Nest DI token for the (env-configurable) simulation delays. */
export const PAYMENT_DELAYS = 'PAYMENT_DELAYS';

export type SimulationOutcome = 'succeeded' | 'failed';

export interface LegalTransition {
  from: PaymentStatus;
  to: 'processing' | 'succeeded' | 'failed';
  /** Assigned only to the terminal edge: `payment.succeeded`/`payment.failed`
   *  (there is no `payment.processing` event, D10). */
  event: 'payment.succeeded' | 'payment.failed' | null;
}

/**
 * Computes the transition due for a payment at `now` (null when none is due).
 * Never returns a transition out of a terminal state.
 */
export function scheduledTransition(
  payment: { status: PaymentStatus; createdAt: Date },
  now: Date,
  delays: SimulationDelays,
  outcome: SimulationOutcome = 'succeeded',
): LegalTransition | null {
  const elapsed = now.getTime() - payment.createdAt.getTime();

  if (payment.status === 'pending') {
    if (elapsed >= delays.pendingDelayMs) {
      return { from: 'pending', to: 'processing', event: null };
    }
    return null;
  }

  if (payment.status === 'processing') {
    if (elapsed >= delays.pendingDelayMs + delays.settlementDelayMs) {
      return outcome === 'failed'
        ? { from: 'processing', to: 'failed', event: 'payment.failed' }
        : { from: 'processing', to: 'succeeded', event: 'payment.succeeded' };
    }
    return null;
  }

  // Terminal (succeeded/failed): absorbing.
  return null;
}