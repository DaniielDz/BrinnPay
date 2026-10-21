/**
 * Webhook destination simulation — the documented URL marker (phase 16 §5,
 * D5 (a); ADR-0032).
 *
 * A developer opts in per endpoint by registering a URL whose path contains the
 * exact consecutive segments `/sandbox/<action>`. The marker lives in the
 * already-stored `url`, so it needs no schema change, no control-plane state
 * and no new operation, and it survives restarts and applies to replays and to
 * every catalog event type.
 *
 * The marker **replaces the HTTP attempt only**: it never bypasses endpoint
 * `enabled` gating, subscription filtering, retention, rate limits, or the
 * destination policy (§5.2 rule 6 — policy denial still wins, because that path
 * means "no request may be made at all"). No outbound request is made, so no
 * signature is emitted — signing stays "HMAC over exactly the bytes sent".
 *
 * Detection is exact segment matching, never substring matching (§5.2 rule 7):
 * `/sandbox/fail` matches, while `/failure-handler`, `/sandbox/webhook` and
 * query-string lookalikes never do.
 */

/** The fixed marker actions (phase 16 §5.1). */
export const WEBHOOK_SIMULATION_ACTIONS = ['fail', 'timeout', 'reject'] as const;

export type WebhookSimulationAction = (typeof WEBHOOK_SIMULATION_ACTIONS)[number];

export function isWebhookSimulationAction(value: string): value is WebhookSimulationAction {
  return (WEBHOOK_SIMULATION_ACTIONS as readonly string[]).includes(value);
}

/** The first segment of the marker: `/sandbox/<action>`. */
const MARKER_SEGMENT = 'sandbox';

/**
 * The recorded outcomes (§5.2 rule 3). Fixed, sanitized constants — never
 * formatted from the URL, so a hostile destination cannot influence what is
 * stored in `last_error` or written to the logs.
 */
export const SIMULATED_ATTEMPT_REASONS: Record<WebhookSimulationAction, string> = {
  fail: 'simulated network error (sandbox)',
  timeout: 'simulated request timeout (sandbox)',
  reject: 'simulated rejection (sandbox)',
};

/**
 * What one simulated attempt observes. Shaped exactly like a real attempt's
 * outcome so the delivery service can feed it through the *same* bookkeeping:
 * attempt counting, retry classification and backoff (§5.2 rule 2).
 *
 * `retry` (`fail`, `timeout`) rides the unchanged ladder until
 * `WEBHOOK_MAX_ATTEMPTS` is exhausted; `failed` (`reject`) is terminal on the
 * first attempt. `responseStatus` is always `null` — there was no response.
 */
export interface SimulatedAttempt {
  kind: 'retry' | 'failed';
  reason: string;
  responseStatus: null;
  retryAfter: null;
}

/**
 * Detects the simulation marker in a registered destination URL.
 *
 * Returns the simulated outcome, or `null` when the URL is unmarked and the
 * real HTTP path must run. An unparseable URL is never simulated: URL
 * well-formedness is validated at registration and re-checked here only so a
 * corrupt stored value degrades to "attempt normally" rather than to a
 * simulated failure.
 */
export function simulatedAttempt(url: string): SimulatedAttempt | null {
  const action = simulationAction(url);
  if (action === null) {
    return null;
  }
  return {
    kind: action === 'reject' ? 'failed' : 'retry',
    reason: SIMULATED_ATTEMPT_REASONS[action],
    responseStatus: null,
    retryAfter: null,
  };
}

/**
 * The marker action of a URL, or `null`.
 *
 * Only the path is inspected: the query string and the fragment are excluded
 * by construction, which is what makes `…?action=/sandbox/fail` a non-match.
 * Matching is case-sensitive segment equality — the tokens are documented,
 * lowercase and fixed.
 */
export function simulationAction(url: string): WebhookSimulationAction | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = pathname.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    const candidate = segments[index + 1];
    if (segments[index] === MARKER_SEGMENT && candidate !== undefined && isWebhookSimulationAction(candidate)) {
      return candidate;
    }
  }
  return null;
}
