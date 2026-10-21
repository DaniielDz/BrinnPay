import type { PaymentScenario } from './payment-scenario';
import type { PaymentStatus } from './payment-types';

/**
 * Payment state machine and scenario-capable simulation (phase 7 §4.6, D2;
 * phase 16 §4.3/§4.5/§4.6).
 *
 * Legal transitions (only these edges exist):
 *
 * ```text
 * pending ──► processing ──► succeeded   (default simulation)
 *                      ├──► failed       (scenario: "decline")
 *                      └──► (never)      (scenario: "timeout" — D3 (a))
 * ```
 *
 * Terminal states are absorbing. There are no user-initiated transitions (the
 * contract has no payment update/cancel endpoints); the simulation is the only
 * driver, and a scenario only *configures* which edge the settlement step picks
 * — it never adds an edge (phase 16 §4.3 rule 1).
 *
 * The schedule is deterministic from `created_at` and the two delay constants
 * (pending delay, settlement delay) — no transition-time columns in the DB, so
 * a restart never strands a payment because advancement always derives from the
 * elapsed time (read-time catch-up).
 *
 * The function is deliberately **pure**: the caller (`advance`) passes the
 * persisted scenario in as data, so the engine never touches the DB and the
 * outcome stays a pure function of `(scenario, created_at, delays)` (§16).
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

export interface LegalTransition {
  from: PaymentStatus;
  to: 'processing' | 'succeeded' | 'failed';
  /** Assigned only to the terminal edge: `payment.succeeded`/`payment.failed`
   *  (there is no `payment.processing` event, D10/D7). */
  event: 'payment.succeeded' | 'payment.failed' | null;
}

/**
 * Computes the transition due for a payment at `now` (null when none is due).
 * Never returns a transition out of a terminal state.
 *
 * `scenario` is the persisted intent (phase 16 §4.2). `null` — the value of a
 * payment created before Phase 16, or without the field — behaves exactly like
 * `succeed`, and any unrecognised value is normalized to that default by
 * {@link parseSimulationScenario} before it reaches this function.
 */
export function scheduledTransition(
  payment: { status: PaymentStatus; createdAt: Date },
  now: Date,
  delays: SimulationDelays,
  scenario: PaymentScenario | null = null,
): LegalTransition | null {
  const elapsed = now.getTime() - payment.createdAt.getTime();

  if (payment.status === 'pending') {
    if (elapsed >= delays.pendingDelayMs) {
      return { from: 'pending', to: 'processing', event: null };
    }
    return null;
  }

  if (payment.status === 'processing') {
    // A timeout payment never settles (phase 16 §4.6, D3 (a)): no settlement
    // edge ever becomes due, so it stays `processing` until something else
    // changes it — nothing does, because the simulation is the only driver.
    if (scenario === 'timeout') {
      return null;
    }
    if (elapsed >= delays.pendingDelayMs + delays.settlementDelayMs) {
      return scenario === 'decline'
        ? { from: 'processing', to: 'failed', event: 'payment.failed' }
        : { from: 'processing', to: 'succeeded', event: 'payment.succeeded' };
    }
    return null;
  }

  // Terminal (succeeded/failed): absorbing.
  return null;
}