/**
 * Scenario selection and the `failure_code` catalog (phase 16 §4.2/§4.5,
 * D1/D4; ADR-0031).
 *
 * A payment's simulated outcome is fixed at creation and consumed minutes later
 * by the advancement sweep, which has no request context, so the intent must be
 * readable from the row (F1). Phase 16 §7 allows exactly **one** new nullable
 * column, `payments.simulation_scenario`, and forbids pre-storing the requested
 * code in `failure_code` (that column stays `null` until a payment fails). The
 * intent is therefore persisted as a single closed-enum string that carries the
 * decline code alongside the scenario:
 *
 * ```text
 * null                        absent ⇒ default success (Phase 7 behavior)
 * succeed                     explicit success
 * timeout                     never settles (D3 (a))
 * decline:<catalog code>      fails at the settlement edge with that code
 * ```
 *
 * The value is app-validated on write (phase 4 D10 pattern): the boundary only
 * ever writes {@link PAYMENT_SCENARIOS} and {@link FAILURE_CODES} values, so the
 * parser is the read-side twin of that validation. Anything the parser does not
 * recognize — an unpersisted or corrupted value — is treated as default success
 * (§11.1), which keeps a bad row from silently failing a payment.
 */

/** The closed `scenario` request enum (phase 16 §4.2, D1 (a) confirmed). */
export const PAYMENT_SCENARIOS = ['succeed', 'decline', 'timeout'] as const;

export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

export function isPaymentScenario(value: string): value is PaymentScenario {
  return (PAYMENT_SCENARIOS as readonly string[]).includes(value);
}

/**
 * The `failure_code` catalog (phase 16 §4.5, D4 (a) confirmed) — the values
 * Phase 7 OQ-3 named as examples. This is the single shared constant the
 * contract and the docs are checked against.
 */
export const FAILURE_CODES = ['card_declined', 'insufficient_funds', 'processing_timeout'] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** The catalog default applied when a decline omits `failure_code` (§4.2). */
export const DEFAULT_FAILURE_CODE: FailureCode = 'card_declined';

export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

/** The `simulation_scenario` column width (§7 `varchar(50)`). */
export const MAX_SIMULATION_SCENARIO_LENGTH = 50;

/** The delimiter between the scenario and its decline code. */
const DECLINE_SEPARATOR = ':';

/**
 * The parsed intent a row carries: which edge the settlement step must choose,
 * and — only for a decline — the catalog code that edge writes.
 */
export interface SimulationIntent {
  scenario: PaymentScenario;
  /** Non-null only when {@link SimulationIntent.scenario} is `decline`. */
  failureCode: FailureCode | null;
}

/** The intent of a payment created without the new fields (§4.3 rule 3). */
export const DEFAULT_SIMULATION_INTENT: SimulationIntent = {
  scenario: 'succeed',
  failureCode: null,
};

/**
 * The value persisted for one create request (§7).
 *
 * - absent `scenario` ⇒ `null`, so pre-existing rows and an unflagged create
 *   are the same state and no backfill is needed;
 * - an explicit `decline` always stores its resolved code, so the settlement
 *   edge never has to re-derive a default the request already settled;
 * - a decline code that somehow reaches the service outside the DTO boundary is
 *   normalized to the catalog default rather than persisted (the DTO is the
 *   validation boundary — §4.2).
 */
export function scenarioColumnValue(
  scenario: PaymentScenario | undefined,
  failureCode?: FailureCode | undefined,
): string | null {
  if (scenario === undefined) {
    return null;
  }
  if (scenario !== 'decline') {
    return scenario;
  }
  const code = failureCode !== undefined && isFailureCode(failureCode) ? failureCode : DEFAULT_FAILURE_CODE;
  return `decline${DECLINE_SEPARATOR}${code}`;
}

/**
 * Reads the persisted column back into an intent.
 *
 * `null`, an unknown value, or an unknown embedded code resolve to
 * {@link DEFAULT_SIMULATION_INTENT}: an unrecognized scenario must never decide
 * a payment's fate (§11.1 "invalid/unpersisted scenario treated as default").
 * A bare `decline` is accepted defensively with the catalog default, even
 * though {@link scenarioColumnValue} always writes the resolved form.
 */
export function parseSimulationScenario(raw: string | null | undefined): SimulationIntent {
  if (raw === null || raw === undefined || raw.length === 0) {
    return DEFAULT_SIMULATION_INTENT;
  }
  if (raw === 'decline') {
    return { scenario: 'decline', failureCode: DEFAULT_FAILURE_CODE };
  }
  if (raw.startsWith(`decline${DECLINE_SEPARATOR}`)) {
    const code = raw.slice(`decline${DECLINE_SEPARATOR}`.length);
    if (isFailureCode(code)) {
      return { scenario: 'decline', failureCode: code };
    }
    return DEFAULT_SIMULATION_INTENT;
  }
  if (isPaymentScenario(raw)) {
    return { scenario: raw, failureCode: null };
  }
  return DEFAULT_SIMULATION_INTENT;
}
