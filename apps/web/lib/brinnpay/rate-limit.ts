/**
 * Browser-side rate-limit surfacing (phase 14 §7.4, D8; phase 13 §7 handover).
 *
 * `apiFetch` hands every response's `RateLimit-*`/`Retry-After` headers to
 * `captureRateLimit`; the dashboard shell subscribes to the store to render the
 * compact budget indicator, and the client consults the throttle record so a
 * throttled action honours the API-indicated delay instead of hammering the
 * limit (phase 13 §9 "well-mannered client").
 *
 * Only budget *numbers* live here: the API's rate-limit class, scope,
 * discriminator, bucket key and Redis key never reach the browser (phase 13
 * §4.4 point 5), so nothing in this module can be rendered by mistake.
 *
 * The state is module-level (a single browser tab is a single session) and is
 * exposed through `useSyncExternalStore` semantics: the snapshot object only
 * changes identity when the state changes.
 */

/** The reported bucket's budget, exactly as published in the headers. */
export interface RateLimitBudget {
  limit: number;
  remaining: number;
  /** Seconds until the reported window resets; `null` when not reported. */
  resetSeconds: number | null;
}

export interface RateLimitState {
  /** Latest reported budget; `null` until a response reports one (silent). */
  budget: RateLimitBudget | null;
  /** Request path (query stripped) → epoch ms until which it is throttled. */
  throttledUntil: Readonly<Record<string, number>>;
}

const initialState: RateLimitState = { budget: null, throttledUntil: {} };

let state: RateLimitState = initialState;
const listeners = new Set<() => void>();

/** Subscribes a component to state changes (for `useSyncExternalStore`). */
export function subscribeRateLimitStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current snapshot; also serves as the server snapshot (never throttled). */
export function getRateLimitState(): RateLimitState {
  return state;
}

function publish(next: RateLimitState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Parses a header value as a non-negative integer; invalid values are absent. */
function parseCount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Upper bound for an armed delay: a huge `Retry-After` cannot lock a path for
 *  the tab's lifetime (presentation-only state; clamped, never trusted). */
const MAX_THROTTLE_SECONDS = 86_400;

/** The subset of `Headers` this module needs (also satisfied by test stubs). */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface CaptureOptions {
  /** HTTP status of the response — only `429` arms the throttle (review L-1). */
  status: number;
  /** HTTP method of the request; the throttle is keyed per method + path. */
  method?: string;
}

/** Throttle record key: method + path without the query string. */
function throttleKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${stripQuery(path)}`;
}

/**
 * Records the rate-limit headers of one response.
 *
 * - The budget is updated only when the response reports one; a response
 *   without headers leaves the store untouched, so an indicator that has never
 *   rendered stays silent (phase 14 §7.4).
 * - The path throttle is armed **only by a `429` response** carrying
 *   `Retry-After` (phase 13 §4.4 publishes that header on 429 alone) and is
 *   clamped to `MAX_THROTTLE_SECONDS`; any other status may carry a
 *   `Retry-After` (e.g. `503` from a proxy) and must not mask its real error by
 *   gating the path. Session routes (`/auth/*`) are never throttled
 *   client-side — the refresh flow must always be able to run.
 * - Keying by method keeps a throttled write (POST) from blocking an unrelated
 *   read (GET) of the same path.
 */
export function captureRateLimit(
  path: string,
  headers: HeaderReader,
  options: CaptureOptions,
): void {
  const pathname = stripQuery(path);

  const limit = parseCount(headers.get('RateLimit-Limit'));
  const remaining = parseCount(headers.get('RateLimit-Remaining'));
  const resetSeconds = parseCount(headers.get('RateLimit-Reset'));
  const retryAfter = parseCount(headers.get('Retry-After'));

  const throttledUntil = { ...state.throttledUntil };
  let changed = false;

  if (
    options.status === 429 &&
    retryAfter !== null &&
    retryAfter > 0 &&
    !pathname.startsWith('/auth/')
  ) {
    const key = throttleKey(options.method ?? 'GET', path);
    const until = Date.now() + Math.min(retryAfter, MAX_THROTTLE_SECONDS) * 1000;
    if ((throttledUntil[key] ?? 0) < until) {
      throttledUntil[key] = until;
      changed = true;
    }
  }

  const budget =
    limit !== null && remaining !== null
      ? { limit, remaining, resetSeconds }
      : state.budget;

  if (!changed && budget === state.budget) return;
  publish({ budget, throttledUntil });
}

/**
 * Whole seconds a path (for one method) is still throttled for, or `null` when
 * it may be called. Expired entries are pruned on read, so the record cannot
 * outlive its window.
 */
export function retryAfterSecondsFor(
  path: string,
  options: { now?: number; method?: string } = {},
): number | null {
  const now = options.now ?? Date.now();
  const key = throttleKey(options.method ?? 'GET', path);
  const until = state.throttledUntil[key];
  if (until === undefined) return null;
  const remaining = Math.ceil((until - now) / 1000);
  if (remaining <= 0) {
    const throttledUntil = { ...state.throttledUntil };
    delete throttledUntil[key];
    publish({ ...state, throttledUntil });
    return null;
  }
  return remaining;
}

/** Drops all captured budget and throttle state (test isolation). */
export function resetRateLimitStore(): void {
  publish(initialState);
}

/** Human-readable delay for user-facing messages (never a raw second count
 *  for long waits). Values are presentation only — no budget internals. */
export function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function stripQuery(path: string): string {
  const index = path.indexOf('?');
  return index === -1 ? path : path.slice(0, index);
}
