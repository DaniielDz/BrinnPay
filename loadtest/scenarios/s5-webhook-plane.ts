/**
 * S5 — Webhook plane throughput & cross-project fairness (phase 19 §4 S5,
 * D5 evidence).
 *
 * Payment creates with registered endpoints on **two projects under
 * deliberately uneven volume** (§16: fairness defects do not appear with a
 * single project): four VUs flood the primary project while one VU trickles
 * the secondary — same API, same worker, same sweep, same requeue pass,
 * same local receiver. Every iteration also lists its project's payments,
 * so read-time catch-up runs concurrently with the write flood.
 *
 * Each project registers one healthy and one failing receiver endpoint, so:
 *
 * - **queue depth / sweep & requeue lag** — captured by the runner's sampler
 *   (redis queue keys + `webhook_deliveries` rows) during the run;
 * - **cross-project starvation (F2/D5)** — per-project oldest-pending
 *   delivery age in the sampler: secondary's retries waiting behind
 *   primary's backlog is the signal;
 * - **pending-delivery pileup (F2/D5)** — failing endpoints accumulate
 *   pending rows through retries; the bound question is answered from the
 *   same samples (D5: measure, then dispose).
 *
 * Sandbox `decline`/`timeout` simulation is not re-simulated here (§6 P2):
 * the failure path under test is the receiver answering `500`.
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
    s5: { executor: 'constant-vus', vus: 5, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.1);

const createdPrimary = new Counter('s5_created_primary');
const createdSecondary = new Counter('s5_created_secondary');
const rateLimited = new Counter('s5_rate_limited');
const createPrimaryMs = new Trend('s5_create_primary_ms', true);
const createSecondaryMs = new Trend('s5_create_secondary_ms', true);
const listPrimaryMs = new Trend('s5_list_primary_ms', true);
const listSecondaryMs = new Trend('s5_list_secondary_ms', true);

const client = createClient();

const CREATE_EXPECTED = [201, 400, 404, 422, 429];
const LIST_EXPECTED = [200, 400, 422, 429];

function randomAmount(): string {
  const dollars = 1 + Math.floor(Math.random() * 99);
  const cents = Math.floor(Math.random() * 100);
  return `${dollars}.${String(cents).padStart(2, '0')}`;
}

export interface SetupData {
  state: LoadtestState;
}

export function setup(): SetupData {
  return { state: requireState() };
}

export default function (data: SetupData): void {
  const s = data.state;
  // Uneven 4:1 split: VU 5 of 5 writes to the secondary project.
  const secondary = vu.idInTest % 5 === 0;
  const project = secondary ? s.secondary : s.primary;
  const key = secondary ? s.keys.secondaryTest : s.keys.primaryTest;
  const customers = secondary ? s.customerIds.secondary : s.customerIds.primary;

  const customerId = customers[Math.floor(Math.random() * customers.length)];
  const create = client.post(
    `/projects/${project.id}/payments`,
    {
      environment: 'test',
      customer_id: customerId,
      amount: randomAmount(),
      currency: 'usd',
      description: secondary ? 'S5 secondary trickle' : 'S5 primary flood',
    },
    {
      name: secondary ? 's5_create_secondary' : 's5_create_primary',
      token: key,
      expected: CREATE_EXPECTED,
      durationMetric: secondary ? createSecondaryMs : createPrimaryMs,
    },
  );
  check(create, {
    'create → 201 or contract-rejected': (r: ApiResponse) => CREATE_EXPECTED.includes(r.status),
  });
  if (create.status === 201) {
    if (secondary) createdSecondary.add(1);
    else createdPrimary.add(1);
  } else if (create.status === 429) {
    rateLimited.add(1);
  }

  const list = client.get(`/projects/${project.id}/payments?limit=20`, {
    name: secondary ? 's5_list_secondary' : 's5_list_primary',
    token: key,
    expected: LIST_EXPECTED,
    durationMetric: secondary ? listSecondaryMs : listPrimaryMs,
  });
  check(list, {
    'list → 200': (r: ApiResponse) => r.status === 200,
  });

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's5-webhook-plane',
      profile: {
        vus: 5,
        duration: '60s',
        sleep: SLEEP,
        split: '4 primary VUs : 1 secondary VU (deliberately uneven)',
        endpoints: 'each project: healthy + failing receiver paths',
      },
      notes:
        'D5 evidence scenario: pair with the runner sampler (queue depth, per-project oldest pending delivery age) for the F2 starvation/pileup disposition.',
    },
    data,
  );
}
