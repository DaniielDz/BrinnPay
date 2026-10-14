/**
 * Shared run configuration for the k6 scenarios (D1).
 *
 * The base URL points at the Docker host mapping by default: k6 itself runs
 * in a container (`grafana/k6:2.3.0`, pinned) on the Compose network, so it
 * reaches the API through `host.docker.internal`. Host-side runs (or CI-less
 * manual runs) override it with `K6_BASE_URL=http://localhost:3000/api/v1`.
 *
 * Scenarios must only ever target this local stack — the runner refuses to
 * start when the URL does not resolve to a loopback/host-gateway address.
 */

/** Base URL of the sandbox API, no trailing slash. */
export const BASE_URL: string = (__ENV.K6_BASE_URL ?? 'http://host.docker.internal:3000/api/v1').replace(
  /\/+$/,
  '',
);

/** k6 rate-limit headers observed on responses (F6 evidence collection). */
export const RATE_LIMIT_HEADERS = ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'] as const;

/** Sleep granularity helper: coerces an env override into a positive float. */
export function envSleep(name: string, fallback: number): number {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
