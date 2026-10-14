/**
 * S8 — Mixed steady-state (phase 19 §4 S8).
 *
 * The standing regression scenario (D3 baseline, Phase 26 re-runs): a
 * representative read/write mix against the primary project **with webhook
 * endpoints registered**, so both planes run together — API writes and
 * reads plus worker fan-out to the local receiver.
 *
 * Committed mix (fixed, documented in the profile):
 *
 * - 40% payments create (write; feeds sweep + 3-endpoint fan-out)
 * - 35% payments cursor list (read; each call runs read-time catch-up)
 * - 25% full refund of a seeded succeeded payment from this VU's slice
 *   (`amount` omitted ⇒ refund the remaining balance; the pool is sized so
 *   a full run stays in `201` territory — conflicts are still expected in
 *   the tail and counted, never hidden)
 *
 * The runner executes S8 **first** (§16): exercising both planes up front
 * reveals the dominant bottleneck class before the narrower scenarios run.
 */

import { check, sleep } from 'k6';
import { vu } from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { createClient, type ApiResponse } from '../lib/api.ts';
import { envSleep } from '../lib/config.ts';
import { requireState, type LoadtestState } from '../lib/state.ts';
import { writeSummary } from '../lib/summary.ts';

export const options: Options = {
  scenarios: {
    s8: { executor: 'constant-vus', vus: 10, duration: '90s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.25);

const created = new Counter('s8_payments_created');
const refundsCreated = new Counter('s8_refunds_created');
const refundConflicts = new Counter('s8_refund_conflicts');
const rateLimited = new Counter('s8_rate_limited');
const createMs = new Trend('s8_create_ms', true);
const listMs = new Trend('s8_list_ms', true);
const refundMs = new Trend('s8_refund_ms', true);

const client = createClient();

const CREATE_EXPECTED = [201, 400, 404, 422, 429];
const LIST_EXPECTED = [200, 400, 422, 429];
const REFUND_EXPECTED = [201, 400, 404, 422, 429];

interface SetupData {
  state: LoadtestState;
}

export function setup(): SetupData {
  return { state: requireState() };
}

// Sharded lazily in VU code: `vu.idInTest` is only meaningful inside an
// iteration (setup runs outside the test VUs).
let slice: string[] | null = null;

function sliceFor(state: LoadtestState): string[] {
  if (slice === null) {
    const ids = state.refundablePaymentIds;
    const perVu = Math.ceil(ids.length / 10);
    const start = (vu.idInTest - 1) * perVu;
    slice = ids.slice(start, start + perVu);
  }
  return slice;
}

function randomAmount(): string {
  const dollars = 1 + Math.floor(Math.random() * 99);
  const cents = Math.floor(Math.random() * 100);
  return `${dollars}.${String(cents).padStart(2, '0')}`;
}

export default function (data: SetupData): void {
  const s = data.state;
  const roll = Math.random();

  if (roll < 0.4) {
    // Write: payment create on the seeded customer pool.
    const customers = s.customerIds.primary;
    const customerId = customers[Math.floor(Math.random() * customers.length)];
    const res = client.post(
      `/projects/${s.primary.id}/payments`,
      {
        environment: 'test',
        customer_id: customerId,
        amount: randomAmount(),
        currency: 'usd',
        description: 'S8 steady-state payment',
      },
      {
        name: 's8_create_payment',
        token: s.keys.primaryTest,
        expected: CREATE_EXPECTED,
        durationMetric: createMs,
      },
    );
    check(res, {
      'create → 201 or contract-rejected': (r: ApiResponse) => CREATE_EXPECTED.includes(r.status),
    });
    if (res.status === 201) created.add(1);
    else if (res.status === 429) rateLimited.add(1);
  } else if (roll < 0.75) {
    // Read: cursor list (runs read-time catch-up first).
    const res = client.get(`/projects/${s.primary.id}/payments?limit=20`, {
      name: 's8_payments_list',
      token: s.keys.primaryTest,
      expected: LIST_EXPECTED,
      durationMetric: listMs,
    });
    check(res, {
      'list → 200': (r: ApiResponse) => r.status === 200,
    });
  } else {
    // Write: full refund of one seeded succeeded payment (this VU's slice).
    const ids = sliceFor(s);
    if (ids.length === 0) {
      sleep(SLEEP);
      return;
    }
    const id = ids[__ITER % ids.length];
    const res = client.post(
      `/payments/${id}/refunds`,
      { reason: 'loadtest phase 19' },
      {
        name: 's8_refund_create',
        token: s.keys.primaryTest,
        expected: REFUND_EXPECTED,
        durationMetric: refundMs,
      },
    );
    check(res, {
      'refund → 201 or contract-rejected': (r: ApiResponse) => REFUND_EXPECTED.includes(r.status),
    });
    if (res.status === 201) refundsCreated.add(1);
    else if (res.status === 422 || res.status === 409) refundConflicts.add(1);
    else if (res.status === 429) rateLimited.add(1);
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's8-mixed-steady-state',
      profile: {
        vus: 10,
        duration: '90s',
        sleep: SLEEP,
        mix: '40% create / 35% list / 25% refund',
        auth: 'api-key',
        project: 'primary',
        endpoints: 3,
      },
      notes:
        'Run first (§16): exercises API + worker planes together; standing regression scenario for D3 baselines and Phase 26 re-runs.',
    },
    data,
  );
}
