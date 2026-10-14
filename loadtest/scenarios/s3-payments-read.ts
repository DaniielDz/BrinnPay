/**
 * S3 — Payments read + cursor pagination + read-time catch-up (phase 19 §4 S3).
 *
 * Half the iterations walk the cursor pages of the payments list, half
 * retrieve a payment by id from the seeded sample. Every list call runs
 * `catchUpEnvironment` first — an **unbounded** pass over all open payments
 * of (project, environment) — which is exactly what this scenario measures:
 * S2 left a backlog of not-yet-due/due payments and the first list calls pay
 * for advancing it (P1).
 *
 * Latency is read through the per-call `name` tag: k6 reports
 * `http_req_duration{name="s3_payments_list"}` as its own summary line, so
 * list cost and retrieve cost stay separable in the baseline.
 */

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { createClient, type ApiResponse } from '../lib/api.ts';
import { envSleep } from '../lib/config.ts';
import { requireState, type LoadtestState } from '../lib/state.ts';
import { writeSummary } from '../lib/summary.ts';

export const options: Options = {
  scenarios: {
    s3: { executor: 'constant-vus', vus: 10, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.1);

const listCalls = new Counter('s3_list_calls');
const retrieveCalls = new Counter('s3_retrieve_calls');
const exhaustedWalks = new Counter('s3_cursor_walks_exhausted');
const listMs = new Trend('s3_payments_list_ms', true);
const getMs = new Trend('s3_payments_get_ms', true);

const client = createClient();

const LIST_EXPECTED = [200, 400, 422, 429];
const GET_EXPECTED = [200, 404, 429];

interface CursorPage {
  data: Array<{ id: string }>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface SetupData {
  state: LoadtestState;
}

export function setup(): SetupData {
  return { state: requireState() };
}

// Cursor state lives at module scope — one walk per VU across iterations.
let cursor: string | undefined;

export default function (data: SetupData): void {
  const s = data.state;

  if (Math.random() < 0.5) {
    const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : '?limit=20';
    const res = client.get(`/projects/${s.primary.id}/payments${query}`, {
      name: 's3_payments_list',
      token: s.keys.primaryTest,
      expected: LIST_EXPECTED,
      durationMetric: listMs,
    });
    listCalls.add(1);
    check(res, {
      'list → 200': (r: ApiResponse) => r.status === 200,
    });
    if (res.status === 200) {
      const page = res.json<CursorPage>();
      if (page.next_cursor) {
        cursor = page.next_cursor;
      } else {
        cursor = undefined;
        exhaustedWalks.add(1);
      }
    }
  } else {
    const sample = s.samplePaymentIds;
    const id = sample[Math.floor(Math.random() * sample.length)];
    const res = client.get(`/projects/${s.primary.id}/payments/${id}`, {
      name: 's3_payments_get',
      token: s.keys.primaryTest,
      expected: GET_EXPECTED,
      durationMetric: getMs,
    });
    retrieveCalls.add(1);
    check(res, {
      'retrieve → 200': (r: ApiResponse) => r.status === 200,
    });
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's3-payments-read',
      profile: { vus: 10, duration: '60s', sleep: SLEEP, mix: '50% cursor list / 50% retrieve' },
      notes:
        'List latency includes unbounded read-time catch-up (P1) over S2 leftover backlog; no settle before this scenario.',
    },
    data,
  );
}
