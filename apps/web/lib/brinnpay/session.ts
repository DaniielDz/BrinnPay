/**
 * Single place where the API client may recover an expired session (phase 14
 * §7.3, row "Unauthenticated (401)").
 *
 * `apiFetch` answers a mid-session `401` by attempting the existing refresh
 * flow once and retrying the original request with the new access token. If
 * the refresh fails, `AuthProvider` clears the session and the existing
 * `AuthGuard` redirects to `/login`, so an expired session is never presented
 * as a generic failure (phase 3 §4.4, phase 1 §11.5).
 *
 * Concurrent `401`s (a `Promise.all` batch) **share a single in-flight
 * refresh**: the refresh cookie is single-use and rotated on every refresh, so
 * two parallel refreshes with the same cookie would trip the API's reuse
 * detection (theft response) and revoke every session of the user. Coalescing
 * makes N simultaneous `401`s perform exactly one refresh and share its token.
 *
 * The handler is registered by `AuthProvider` (the owner of the in-memory
 * access token) and removed on unmount; without a handler — public pages, unit
 * tests rendering a page without a provider — a `401` is surfaced as-is.
 */

type UnauthorizedRecovery = () => Promise<string | null>;

let recovery: UnauthorizedRecovery | null = null;
let inFlight: Promise<string | null> | null = null;

/** Registers the session-recovery handler; `null` removes it. */
export function setUnauthorizedRecovery(handler: UnauthorizedRecovery | null): void {
  recovery = handler;
}

/**
 * Runs the registered handler, returning the fresh access token on success or
 * `null` when the session could not be recovered. Never throws. While a
 * recovery is already running, callers await that same run instead of starting
 * another refresh.
 */
export function recoverSession(): Promise<string | null> {
  if (!recovery) return Promise.resolve(null);
  if (inFlight !== null) return inFlight;

  const handler = recovery;
  const run = (async (): Promise<string | null> => {
    try {
      return await handler();
    } catch {
      return null;
    }
  })();
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}
