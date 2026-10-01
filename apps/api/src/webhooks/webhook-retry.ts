/**
 * Delivery retry classification and backoff schedule (phase 10 §5.4/§5.5,
 * D5/D6).
 *
 * These are pure functions, deliberately separated from the HTTP client and the
 * worker so the whole policy is unit-testable without a destination and cannot
 * drift from what the API documents.
 */

/** Terminal state of a delivery aggregate (D4). */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/** The contract's delivery status enum (§5.1) — validated at the boundary. */
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * What the destination's answer means for this delivery. Every outcome carries a
 * bounded `reason` so the caller has one uniform place to take the summary that
 * is written to `last_error` (D4) — and so the "delivered" case still has an
 * audit-worthy line for the structured log.
 */
export type AttemptOutcome =
  | { kind: 'delivered'; reason: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'failed'; reason: string };

/** Response classes that are always worth another attempt (D6). */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

/**
 * Classifies an HTTP response status (D6).
 *
 * - any `2xx` → `delivered`;
 * - network/DNS/TLS errors, timeouts, `408`, `425`, `429`, and any `5xx` →
 *   `retry`;
 * - every other `4xx` (including `401`/`403`/`404`/`410`) and **any** `3xx` →
 *   `failed`.
 *
 * `3xx` is never retried and never followed: following a redirect would let a
 * registered URL point the signed request at a host the developer never
 * registered, which is both an SSRF and a signature-confusion path, and it
 * would break the guarantee that the delivered URL equals the registered URL.
 */
export function classifyResponseStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'delivered', reason: `destination responded ${status}` };
  }
  if (RETRYABLE_STATUS_CODES.has(status) || status >= 500) {
    return { kind: 'retry', reason: `destination responded ${status}` };
  }
  if (status < 100) {
    return { kind: 'failed', reason: `destination responded with an invalid status ${status}` };
  }
  if (status >= 300 && status < 400) {
    return { kind: 'failed', reason: `destination responded ${status} (redirects are never followed)` };
  }
  return { kind: 'failed', reason: `destination responded ${status}` };
}

/**
 * Classifies a transport-level failure (D6). DNS, TCP, TLS, and abort/timeout
 * errors are all retryable: the destination may be temporarily unreachable.
 *
 * `undici` throws a bare `TypeError: fetch failed` for every transport failure
 * and puts the useful part — `connect ECONNREFUSED <host>:<port>`, `ENOTFOUND`,
 * `UND_ERR_CONNECT_TIMEOUT` — on `error.cause`, which the outer error does not
 * expose. The stored summary is therefore the outer message only, so every
 * transport failure currently reads as `delivery request failed: fetch failed`.
 *
 * That is deliberate rather than an oversight. The alternative copies
 * host-and-port text out of `cause` into `last_error`, which is tenant-readable
 * and persists for the retention window; the destination host is already known
 * to the caller from the endpoint, so it adds no information for them while
 * widening what a support export reveals. Diagnosing the cause belongs at the
 * worker's own transport logs, which are not tenant-scoped. Surfacing a
 * classified, non-identifying token (`ENOTFOUND` without the host) is the
 * improvement to make if the operability gap needs closing.
 */
export function classifyTransportError(error: unknown): AttemptOutcome {
  return {
    kind: 'retry',
    reason: `delivery request failed: ${sanitizeErrorSummary(error)}`,
  };
}

/**
 * `Retry-After` handling (D6). Honored on `429`/`503` when it is parseable as a
 * delay in seconds or an HTTP date, then clamped to the configured maximum
 * backoff so a destination cannot postpone a delivery indefinitely.
 *
 * Anything that would produce a **non-positive** delay — `Retry-After: 0`, or an
 * HTTP-date in the past — yields `undefined` rather than `0`, so the backoff
 * ladder always applies. A zero would bypass the ladder entirely and let a
 * destination pull all five attempts into one burst; the same is true of a
 * malformed value, so the two cases are not distinguished.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: Date,
  maxBackoffMs: number,
): number | undefined {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return undefined;
  }
  const raw = headerValue.trim();

  // Delay-seconds form (RFC 9110 §10.2.3).
  if (/^\d+$/.test(raw)) {
    const delay = Number(raw) * 1000;
    return delay > 0 ? clamp(delay, maxBackoffMs) : undefined;
  }

  // HTTP-date form. A date always starts with a weekday name, so anything that
  // does not is malformed: `Date.parse` happily accepts bare numbers as years,
  // which would turn a garbage header into a zero (immediate) retry.
  if (!/^[A-Za-z]/.test(raw)) {
    return undefined;
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    const delay = asDate - now.getTime();
    return delay > 0 ? clamp(delay, maxBackoffMs) : undefined;
  }

  return undefined;
}

/** Bounds a delay to `[0, maxBackoffMs]`. */
export function clamp(delayMs: number, maxBackoffMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return 0;
  }
  return Math.min(Math.round(delayMs), Math.max(0, maxBackoffMs));
}

/**
 * Multiplier of the backoff ladder (D5). It realizes the approved schedule
 * "≈ 0 s, 30 s, 2 min, 10 min, 1 h" from `baseDelayMs = 30 s`:
 * 0 s, 30 s, 2.5 min, 12.5 min, 62.5 min — where the fifth ceiling is the
 * `maxBackoffMs` cap (1 h), so the cap is the term that actually binds on the
 * last attempt instead of a value the ladder never reaches.
 */
const BACKOFF_FACTOR = 5;

/**
 * Deterministic upper bound for the backoff of a given attempt, **before**
 * jitter. Attempt 1 is immediate; each later attempt multiplies the previous
 * ceiling by {@link BACKOFF_FACTOR} (D5 — "exponential backoff"), never exceeding
 * the configured maximum.
 */
export function backoffCeilingMs(
  attempt: number,
  baseDelayMs: number,
  maxBackoffMs: number,
): number {
  if (attempt <= 1) {
    return 0;
  }
  const exponent = Math.min(attempt - 2, 30); // bound the shift, not the policy
  return clamp(baseDelayMs * BACKOFF_FACTOR ** exponent, maxBackoffMs);
}

/**
 * Full-jitter delay for the next attempt (D5). Jitter is applied uniformly in
 * `[0, ceiling]`, which is what stops a batch of deliveries that failed together
 * (a shared outage) from retrying in lockstep against a recovering destination.
 *
 * `random` is injectable so the schedule is deterministic under test.
 */
export function nextAttemptDelayMs(
  attempt: number,
  policy: { baseDelayMs: number; maxBackoffMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, policy.baseDelayMs, policy.maxBackoffMs);
  if (ceiling === 0) {
    return 0;
  }
  return Math.floor(random() * (ceiling + 1));
}

/**
 * Whether another attempt is permitted after `attemptsMade` failed attempts
 * (D5). The final attempt is allowed to be made; only a *failure* of that
 * attempt makes the delivery terminal.
 */
export function hasAttemptsRemaining(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade < maxAttempts;
}

/**
 * The `last_error` summary retained on a delivery (phase 10 §5.1/§5.4). A
 * response body is never stored and never logged in full, and the text is
 * truncated to fit the column, so the record can never carry a secret or an
 * unbounded payload.
 */
export function sanitizeErrorSummary(input: unknown, maxLength = 500): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    const code = (input as NodeJS.ErrnoException).code;
    // The message of a transport error is a system string, not destination
    // content; connection URLs are never included because the URL is the
    // endpoint's own (already known to its owner) and carries no credentials
    // (rejected at validation time).
    text = code ? `${input.message} (${code})` : input.message;
  } else {
    text = String(input);
  }

  // Collapse whitespace and strip control characters so a hostile destination
  // cannot inject newlines into structured logs.
  const sanitized = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length === 0) {
    return 'delivery failed';
  }
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}
