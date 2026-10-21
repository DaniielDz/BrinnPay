/**
 * S6 — Unmatched-route 404 flood (phase 19 §4 S6).
 *
 * Hammers paths that match no route under `/api/v1`. Two things are
 * measured (D6: measure amplification, then presume the acceptance with
 * exit criteria — the logging exclusion is forbidden):
 *
 * 1. **Rate-limit bypass (F3 premise)**: `s6_missing_rate_limit_headers`
 *    counts responses without any `RateLimit-*` header. If it equals
 *    `s6_unmatched_requests`, the unmatched-path limiter gap is still open
 *    (finding stays open, ADR/security-review unchanged until dispositioned).
 * 2. **Amplification**: each 404 is still request-logged (ingress + async
 *    row), so 10 VUs × 20 rps ≈ 12 000 requests/min become 12 000
 *    `request_logs` rows — the write volume S7 then pays to page through.
 *
 * All responses are expected `404` (via the response callback), so
 * `http_req_failed` measures transport errors only; a non-404 (e.g. a 500
 * under load) fails both the check and the threshold.
 */

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { createClient, hasRateLimitHeaders, type ApiResponse } from '../lib/api.ts';
import { envSleep } from '../lib/config.ts';
import { writeSummary } from '../lib/summary.ts';

export const options: Options = {
  scenarios: {
    s6: { executor: 'constant-vus', vus: 10, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.05);

const unmatched = new Counter('s6_unmatched_requests');
const missingRateLimitHeaders = new Counter('s6_missing_rate_limit_headers');
const unmatchedMs = new Trend('s6_unmatched_ms', true);

const client = createClient();

const EXPECTED = [404];

export default function (): void {
  const path = `/loadtest-nonexistent-${__VU}-${__ITER}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const res = client.get(path, { name: 's6_unmatched', expected: EXPECTED, durationMetric: unmatchedMs });

  unmatched.add(1);
  check(res, {
    'unmatched path → 404': (r: ApiResponse) => r.status === 404,
  });
  if (!hasRateLimitHeaders(res)) {
    missingRateLimitHeaders.add(1);
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's6-unmatched-404',
      profile: { vus: 10, duration: '60s', sleep: SLEEP, target: 'unmatched /api/v1 routes' },
      notes:
        's6_missing_rate_limit_headers == s6_unmatched_requests ⇒ F3 limiter gap open (D6: measure, then presume acceptance with exit criteria; no logging exclusion).',
    },
    data,
  );
}
