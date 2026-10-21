/**
 * S7 — Dashboard session emulation (phase 19 §4 S7, D8).
 *
 * API-level emulation of one interactive dashboard session: a single
 * session token (seed user, logged in during setup) driving the request
 * mix the dashboard actually makes, weights derived from the static review
 * of `apps/web` (D8):
 *
 * - payments page polls the list every 3 s while a payment is non-terminal
 *   (`PAYMENT_POLL_MS`) → the heaviest weight is `listPayments`;
 * - customers debounces search 300 ms (`SEARCH_DEBOUNCE_MS`) → search weight;
 * - page mounts fan out `listMembers` / `listOrganizations` / `listProjects`
 *   (they always come together in the UI → they come together here);
 * - environment switching re-scopes list calls exactly like the header
 *   switch does.
 *
 * Session mode passes explicit `environment` on every list (the contract's
 * 400 rule for session-authenticated reads). Only 200/201 are accepted:
 * anything else is a contract breach, not noise.
 */

import { check, sleep } from 'k6';
import { vu } from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { createClient, type ApiClient, type ApiResponse } from '../lib/api.ts';
import { envSleep } from '../lib/config.ts';
import { requireState, type LoadtestState } from '../lib/state.ts';
import { writeSummary } from '../lib/summary.ts';

export const options: Options = {
  scenarios: {
    s7: { executor: 'constant-vus', vus: 5, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.4);

const envSwitches = new Counter('s7_environment_switches');
const creates = new Counter('s7_payments_created');
const readMs = new Trend('s7_read_ms', true);
const createMs = new Trend('s7_create_ms', true);

const client: ApiClient = createClient();

const READ = [200];
const CREATE = [201];

interface AuthResponse {
  access_token: string;
}

interface SetupData {
  token: string;
  state: LoadtestState;
}

export function setup(): SetupData {
  const state = requireState();
  const login = client.post(
    '/auth/login',
    { email: state.user.email, password: state.user.password },
    { name: 's7_setup_login', expected: [200] },
  );
  if (login.status !== 200) {
    // Status only — credentials are never part of an error message.
    throw new Error(`S7 setup login failed with status ${login.status}`);
  }
  return { token: login.json<AuthResponse>().access_token, state };
}

// Per-VU environment view, mirroring the dashboard's environment header.
// Initialized inside VU code: `vu.*` is not readable in the init context
// (k6 rejects it at inspect time).
let currentEnv: 'test' | 'live' | null = null;

/** Weighted mix: [cumulative weight, label] — labels match the catalog. */
const MIX: Array<[number, string]> = [
  [0.3, 'payments-list'],
  [0.44, 'customers-list'],
  [0.54, 'request-logs-list'],
  [0.62, 'audit-logs-list'],
  [0.69, 'webhook-endpoints-list'],
  [0.76, 'webhook-events-list'],
  [0.81, 'project-mount'], // project retrieve + members in one iteration
  [0.86, 'dashboard-home'], // organizations + projects in one iteration
  [0.91, 'payments-get'],
  [0.96, 'customers-search'],
  [0.99, 'environment-switch'],
  [1.0, 'payments-create'],
];

export default function (data: SetupData): void {
  const { token, state } = data;
  const orgId = state.user.orgId;
  const projectId = state.primary.id;
  if (currentEnv === null) {
    currentEnv = vu.idInTest % 2 === 0 ? 'live' : 'test';
  }
  const pick = Math.random();
  const action = (MIX.find(([weight]) => pick < weight) ?? MIX[MIX.length - 1])[1];
  const env = currentEnv;

  const read = (name: string, path: string): ApiResponse =>
    client.get(path, { name: `s7_${name}`, token, expected: READ, durationMetric: readMs });

  switch (action) {
    case 'payments-list': {
      const res = read('payments_list', `/projects/${projectId}/payments?environment=${env}&limit=20`);
      check(res, { 'payments list → 200': (r) => r.status === 200 });
      break;
    }
    case 'customers-list': {
      const res = read('customers_list', `/projects/${projectId}/customers?environment=${env}&limit=20`);
      check(res, { 'customers list → 200': (r) => r.status === 200 });
      break;
    }
    case 'request-logs-list': {
      const res = read('request_logs', `/projects/${projectId}/logs/requests?environment=${env}&limit=20`);
      check(res, { 'request logs → 200': (r) => r.status === 200 });
      break;
    }
    case 'audit-logs-list': {
      const res = read('audit_logs', `/organizations/${orgId}/logs/audit?limit=20`);
      check(res, { 'audit logs → 200': (r) => r.status === 200 });
      break;
    }
    case 'webhook-endpoints-list': {
      const res = read('webhook_endpoints', `/projects/${projectId}/webhook-endpoints?environment=${env}&limit=20`);
      check(res, { 'webhook endpoints → 200': (r) => r.status === 200 });
      break;
    }
    case 'webhook-events-list': {
      const res = read('webhook_events', `/projects/${projectId}/webhook-events?environment=${env}&limit=20`);
      check(res, { 'webhook events → 200': (r) => r.status === 200 });
      break;
    }
    case 'project-mount': {
      const project = read('project_get', `/projects/${projectId}`);
      check(project, { 'project → 200': (r) => r.status === 200 });
      const members = read('members_list', `/organizations/${orgId}/members?limit=20`);
      check(members, { 'members → 200': (r) => r.status === 200 });
      break;
    }
    case 'dashboard-home': {
      const orgs = read('organizations_list', '/organizations?limit=20');
      check(orgs, { 'organizations → 200': (r) => r.status === 200 });
      const projects = read('projects_list', '/projects?limit=20');
      check(projects, { 'projects → 200': (r) => r.status === 200 });
      break;
    }
    case 'payments-get': {
      const sample = state.samplePaymentIds;
      const id = sample[Math.floor(Math.random() * sample.length)];
      const res = read('payments_get', `/projects/${projectId}/payments/${id}`);
      check(res, { 'payment → 200': (r) => r.status === 200 });
      break;
    }
    case 'customers-search': {
      const res = read('customers_search', `/projects/${projectId}/customers?environment=${env}&search=loadtest&limit=20`);
      check(res, { 'search → 200': (r) => r.status === 200 });
      break;
    }
    case 'environment-switch': {
      currentEnv = currentEnv === 'test' ? 'live' : 'test';
      envSwitches.add(1);
      const res = read('payments_list', `/projects/${projectId}/payments?environment=${currentEnv}&limit=20`);
      check(res, { 'switched list → 200': (r) => r.status === 200 });
      break;
    }
    case 'payments-create': {
      const customers = state.customerIds.primary;
      const customerId = customers[Math.floor(Math.random() * customers.length)];
      const res = client.post(
        `/projects/${projectId}/payments`,
        {
          environment: 'test',
          customer_id: customerId,
          amount: '9.99',
          currency: 'usd',
          description: 'S7 dashboard create',
        },
        { name: 's7_payments_create', token, expected: CREATE, durationMetric: createMs },
      );
      check(res, { 'create → 201': (r) => r.status === 201 });
      if (res.status === 201) creates.add(1);
      break;
    }
    default:
      break;
  }

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's7-dashboard-session',
      profile: {
        vus: 5,
        duration: '60s',
        sleep: SLEEP,
        auth: 'session',
        mix: 'weighted from apps/web static review (D8)',
      },
      notes:
        'Weights: payments list .30, customers .14, request logs .10, audit .08, endpoints .07, events .07, project mount .05, home .05, get .05, search .05, env switch .03, create .02.',
    },
    data,
  );
}
