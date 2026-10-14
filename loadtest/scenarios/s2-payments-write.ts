/**
 * S2 — Payments write throughput (phase 19 §4 S2).
 *
 * Payment creates against the primary project through its API key — the
 * write path that feeds the advancement sweep and, with 3 registered
 * endpoints on the project, the in-transaction event/delivery fan-out the
 * catalog asks this scenario to observe. The mix is committed and fixed:
 *
 * - **60% plain creates** (no `Idempotency-Key`);
 * - **40% idempotent create + retry** (phase 8 §4.2 semantics): the same
 *   body is sent twice with the same key; the second response must replay
 *   the first — same `201`, same payment id — and is counted in
 *   `s2_idempotent_replays`.
 *
 * **No settle runs after S2** (catalog decision): S3 is deliberately
 * pointed at the open-payment backlog S2 produced, so read-time catch-up
 * cost shows up in S3's latency instead of being absorbed silently by the
 * runner.
 *
 * Each created payment becomes due at `created + 1s` (pending → processing)
 * and terminal at `created + 3s` (payment-simulation schedule), so the
 * worker's 100-row/5s sweep drains roughly 20/s while S2 creates ~20/s —
 * the residual backlog is S3's input.
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
    s2: { executor: 'constant-vus', vus: 10, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.3);

const created = new Counter('s2_payments_created');
const rateLimited = new Counter('s2_rate_limited');
const rejected = new Counter('s2_rejected');
const idempotentReplays = new Counter('s2_idempotent_replays');
const createMs = new Trend('s2_create_ms', true);

const client = createClient();

const CREATE_EXPECTED = [201, 400, 404, 422, 429];

/** Committed mix: 40% of iterations run the idempotent create+retry pair. */
const IDEMPOTENT_SHARE = 0.4;

function randomAmount(): string {
  const dollars = 1 + Math.floor(Math.random() * 99);
  const cents = Math.floor(Math.random() * 100);
  return `${dollars}.${String(cents).padStart(2, '0')}`;
}

interface PaymentResponse {
  id: string;
}

export interface SetupData {
  state: LoadtestState;
}

export function setup(): SetupData {
  return { state: requireState() };
}

export default function (data: SetupData): void {
  const s = data.state;
  const customers = s.customerIds.primary;
  const customerId = customers[Math.floor(Math.random() * customers.length)];
  const path = `/projects/${s.primary.id}/payments`;
  const body = {
    environment: 'test',
    customer_id: customerId,
    amount: randomAmount(),
    currency: 'usd',
    description: 'S2 loadtest payment',
  };

  const idempotent = Math.random() < IDEMPOTENT_SHARE;
  const idempotencyKey = idempotent
    ? `s2-${__VU}-${__ITER}-${Math.floor(Math.random() * 1e9).toString(36)}`
    : undefined;

  const first = client.post(path, body, {
    name: idempotent ? 's2_create_idempotent' : 's2_create_payment',
    token: s.keys.primaryTest,
    expected: CREATE_EXPECTED,
    durationMetric: createMs,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  check(first, {
    'create → 201 or contract-rejected': (r: ApiResponse) => CREATE_EXPECTED.includes(r.status),
  });
  if (first.status === 201) created.add(1);
  else if (first.status === 429) rateLimited.add(1);
  else if (first.status >= 400) rejected.add(1);

  if (idempotent && first.status === 201) {
    // Phase 8 §4.2: same project + operation scope + key + body ⇒ replay of
    // the original stored response (same 201, same payment id, no second
    // payment, no second event).
    const retry = client.post(path, body, {
      name: 's2_idempotent_retry',
      token: s.keys.primaryTest,
      expected: CREATE_EXPECTED,
      durationMetric: createMs,
      idempotencyKey,
    });
    check(retry, {
      'retry replays the original payment': (r: ApiResponse) => {
        if (r.status !== 201) return false;
        return r.json<PaymentResponse>().id === first.json<PaymentResponse>().id;
      },
    });
    if (retry.status === 201) idempotentReplays.add(1);
    else if (retry.status === 429) rateLimited.add(1);
    else rejected.add(1);
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's2-payments-write',
      profile: {
        vus: 10,
        duration: '60s',
        sleep: SLEEP,
        project: 'primary',
        auth: 'api-key',
        mix: '60% plain / 40% idempotent create+retry',
        endpoints: 3,
      },
      notes: 'No settle after S2 — S3 measures the open-payment backlog this run produces.',
    },
    data,
  );
}
