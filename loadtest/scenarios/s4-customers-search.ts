/**
 * S4 — Customers list + search (phase 19 §4 S4).
 *
 * Exercises the customer list and the `search` term path (≤200 chars,
 * substring match over email/name) against the 3 000-row corpus. Search
 * cost here is the evidence for D7 (conditional `pg_trgm` GIN index): if
 * `http_req_duration{name="s4_customers_search"}` p95 is unremarkable
 * relative to plain list p95 at this scale, the index stays off and the
 * finding is dispositioned "accept"; if it degrades, the index becomes a
 * recommendation with these numbers attached.
 *
 * 60% of iterations search, 40% walk plain list pages.
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
    s4: { executor: 'constant-vus', vus: 10, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.1);

const searchCalls = new Counter('s4_search_calls');
const listCalls = new Counter('s4_list_calls');
const searchMs = new Trend('s4_customers_search_ms', true);
const listMs = new Trend('s4_customers_list_ms', true);

const client = createClient();

const LIST_EXPECTED = [200, 400, 422, 429];

/** Contract-valid terms: substrings that exist in the seeded corpus. */
const TERMS = [
  'loadtest',
  'Loadtest Customer 1',
  'cust-0001',
  'cust-00123',
  '@loadtest.invalid',
  'customer 42',
  'LOADTEST',
  'a'.repeat(190), // near the 200-char bound
];

interface CursorPage {
  data: Array<{ id: string }>;
  next_cursor: string | null;
}

export interface SetupData {
  state: LoadtestState;
}

export function setup(): SetupData {
  return { state: requireState() };
}

let cursor: string | undefined;

export default function (data: SetupData): void {
  const s = data.state;
  const base = `/projects/${s.primary.id}/customers`;

  if (Math.random() < 0.6) {
    const term = TERMS[Math.floor(Math.random() * TERMS.length)];
    const res = client.get(`${base}?search=${encodeURIComponent(term)}&limit=20`, {
      name: 's4_customers_search',
      token: s.keys.primaryTest,
      expected: LIST_EXPECTED,
      durationMetric: searchMs,
    });
    searchCalls.add(1);
    check(res, {
      'search → 200': (r: ApiResponse) => r.status === 200,
    });
  } else {
    const query = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : '?limit=20';
    const res = client.get(`${base}${query}`, {
      name: 's4_customers_list',
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
      cursor = page.next_cursor ?? undefined;
    }
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's4-customers-search',
      profile: { vus: 10, duration: '60s', sleep: SLEEP, mix: '60% search / 40% list', corpus: '3000 customers' },
      notes: 'D7 evidence: compare search p95 against plain list p95 before deciding on a pg_trgm index.',
    },
    data,
  );
}
