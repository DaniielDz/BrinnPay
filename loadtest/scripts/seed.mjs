#!/usr/bin/env node
/**
 * Phase 19 seed — D9 hybrid fixture strategy.
 *
 * **API-driven (everything security-relevant):** user registration, the
 * default organization, two projects, two test-scoped API keys, five webhook
 * endpoints (healthy + failing receiver paths), plus a handful of scaffold
 * customers/payments. No fixture backdoor: the seeder authenticates and
 * authorizes exactly like any client (§8 rule 1), so every capability the
 * load scenarios rely on is proven by the same public surface.
 *
 * **Direct database (bulk corpus only):** the remaining customers and
 * payments are inserted with contract-valid values (phase 19 §7 / D9) —
 * never to fabricate behavior under test, only corpus. Row shapes come from
 * `lib/corpus.mjs`, which unit-tests the invariants (catalog statuses,
 * `decline:<code>` pairing, bounds, id/created_at alignment).
 *
 * Outputs `loadtest/.state/state.json` (gitignored, mode 600) holding ids,
 * keys, the local run password and sample id pools. **The file is never
 * printed and never committed; this script prints only ids and counts.**
 *
 * Environment (all non-secret defaults; see loadtest/.env.example):
 * - `API_BASE_URL` — API base for the local stack (default http://localhost:3100/api/v1)
 * - `SEED_PRIMARY_CUSTOMERS` / `SEED_PRIMARY_PAYMENTS` — bulk corpus sizes
 * - `SEED_SECONDARY_CUSTOMERS` / `SEED_SECONDARY_PAYMENTS`
 * - `LOADTEST_COMPOSE_PROJECT` — compose project of the load stack
 */

import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, customerInsertSql, paymentInsertSql } from '../lib/corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADTEST_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(LOADTEST_DIR, '..');
const STATE_PATH = path.join(LOADTEST_DIR, '.state', 'state.json');

const API_BASE = (process.env.API_BASE_URL ?? 'http://localhost:3100/api/v1').replace(/\/+$/, '');
const COMPOSE_PROJECT = process.env.LOADTEST_COMPOSE_PROJECT ?? 'brinnpay-loadtest';
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker', 'compose.yml');

const PRIMARY_CUSTOMERS = intEnv('SEED_PRIMARY_CUSTOMERS', 3000);
const PRIMARY_PAYMENTS = intEnv('SEED_PRIMARY_PAYMENTS', 5000);
const SECONDARY_CUSTOMERS = intEnv('SEED_SECONDARY_CUSTOMERS', 100);
const SECONDARY_PAYMENTS = intEnv('SEED_SECONDARY_PAYMENTS', 200);
const SCAFFOLD_CUSTOMERS = intEnv('SEED_SCAFFOLD_CUSTOMERS', 5);
const SCAFFOLD_PAYMENTS = intEnv('SEED_SCAFFOLD_PAYMENTS', 5);
const SAMPLE_SIZE = 50;

const RECEIVER_HOST = process.env.LOADTEST_RECEIVER_HOST ?? 'brinnpay-loadtest-receiver';
const RECEIVER_PORT = intEnv('RECEIVER_PORT', 4090);
const ALL_EVENT_TYPES = ['payment.created', 'payment.succeeded', 'payment.failed', 'refund.created'];

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`seed: ${message}\n`);
  process.exit(1);
}

/** Non-secret local run credential; stored only in the mode-600 state file. */
function generatePassword() {
  return `Lt-${randomBytes(9).toString('base64url')}`;
}

function generateRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `lt-${stamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * Minimal JSON request helper. Error messages carry method/path/status only —
 * response bodies can contain tokens, keys or signing secrets and are never
 * interpolated anywhere.
 *
 * @param {string} method
 * @param {string} pathOrUrl - API path or absolute URL.
 * @param {{ token?: string, body?: unknown, expect?: number[] }} [options]
 */
async function request(method, pathOrUrl, { token, body, expect } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const headers = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (expect && !expect.includes(res.status)) {
    fail(`${method} ${new URL(url).pathname} → HTTP ${res.status} (expected ${expect.join('|')})`);
  }
  return { status: res.status, body: json };
}

async function waitForApi(timeoutMs = 120_000) {
  const origin = new URL(API_BASE).origin;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health/ready`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`API not ready at ${origin}/health/ready within ${timeoutMs}ms (${lastError})`);
}

function composeArgs(...extra) {
  return ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...extra];
}

/** Pipes SQL into the running stack's postgres via docker compose exec. */
function psql(sql) {
  const result = spawnSync(
    'docker',
    composeArgs('exec', '-T', 'postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -q -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB"'),
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    fail(`bulk seed SQL failed: ${(result.stderr ?? '').trim().split('\n').slice(-5).join(' | ')}`);
  }
  return (result.stdout ?? '').trim();
}

function psqlValue(sql) {
  const out = psql(sql);
  return out.split('\n')[0] ?? '';
}

async function main() {
  const runId = generateRunId();
  log(`seed: run id ${runId}`);

  await waitForApi();

  // --- Identity & capability scaffold (public API only) --------------------
  const email = `loadtest-${runId}@loadtest.invalid`;
  const password = generatePassword();
  const registration = await request('POST', '/auth/register', {
    body: { email, password, name: 'Loadtest Runner' },
    expect: [201],
  });
  const token = registration.body.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    fail('registration succeeded but no access token was returned');
  }

  const orgs = await request('GET', '/organizations?limit=20', { token, expect: [200] });
  const orgId = orgs.body?.data?.[0]?.id;
  if (!orgId) fail('no organization after registration');
  log(`seed: organization ${orgId}`);

  const makeProject = async (name) => {
    const res = await request('POST', '/projects', {
      token,
      body: { name, organization_id: orgId },
      expect: [201],
    });
    if (!res.body?.id) fail(`project ${name} was not created`);
    return res.body.id;
  };
  const primaryId = await makeProject('Loadtest Primary');
  const secondaryId = await makeProject('Loadtest Secondary');
  log(`seed: projects primary=${primaryId} secondary=${secondaryId}`);

  const makeKey = async (projectId) => {
    const res = await request('POST', `/projects/${projectId}/api-keys`, {
      token,
      body: { environment: 'test' },
      expect: [201],
    });
    if (typeof res.body?.key !== 'string') fail('api key response missing key');
    return res.body.key; // plaintext once; state file only (mode 600)
  };
  const primaryKey = await makeKey(primaryId);
  const secondaryKey = await makeKey(secondaryId);

  const receiverUrl = (suffix) => `http://${RECEIVER_HOST}:${RECEIVER_PORT}${suffix}`;
  const endpointPlan = [
    { projectId: primaryId, url: receiverUrl('/webhooks/primary-ok') },
    { projectId: primaryId, url: receiverUrl('/webhooks/primary-ok-2') },
    { projectId: primaryId, url: receiverUrl('/webhooks/fail/primary') },
    { projectId: secondaryId, url: receiverUrl('/webhooks/secondary-ok') },
    { projectId: secondaryId, url: receiverUrl('/webhooks/fail/secondary') },
  ];
  const endpoints = { primary: [], secondary: [] };
  for (const plan of endpointPlan) {
    // The 201 response carries the signing secret once — extract nothing
    // beyond the URL we already know; never log the body.
    await request('POST', `/projects/${plan.projectId}/webhook-endpoints`, {
      token,
      body: { environment: 'test', url: plan.url, event_types: ALL_EVENT_TYPES },
      expect: [201],
    });
    (plan.projectId === primaryId ? endpoints.primary : endpoints.secondary).push(plan.url);
  }
  log(`seed: ${endpointPlan.length} webhook endpoints registered`);

  // --- API-driven scaffold rows -------------------------------------------
  const scaffoldCustomerIds = [];
  for (let i = 0; i < SCAFFOLD_CUSTOMERS; i += 1) {
    const res = await request('POST', `/projects/${primaryId}/customers`, {
      token,
      body: { environment: 'test', email: `scaffold-${i}-${runId}@loadtest.invalid`, name: `Scaffold Customer ${i}` },
      expect: [201],
    });
    scaffoldCustomerIds.push(res.body.id);
  }
  for (let i = 0; i < SCAFFOLD_PAYMENTS; i += 1) {
    await request('POST', `/projects/${primaryId}/payments`, {
      token,
      body: {
        environment: 'test',
        customer_id: scaffoldCustomerIds[i % scaffoldCustomerIds.length],
        amount: `${1 + i}.00`,
        currency: 'usd',
        description: 'Scaffold payment (API-created)',
      },
      expect: [201],
    });
  }
  log(`seed: API scaffold ${SCAFFOLD_CUSTOMERS} customers, ${SCAFFOLD_PAYMENTS} payments`);

  // --- Bulk corpus (direct DB, contract-valid values only) -----------------
  const now = Date.now();
  const primary = buildCorpus({
    projectId: primaryId,
    environment: 'test',
    customerCount: PRIMARY_CUSTOMERS - SCAFFOLD_CUSTOMERS,
    paymentCount: PRIMARY_PAYMENTS - SCAFFOLD_PAYMENTS,
    customerSampleSize: SAMPLE_SIZE,
    refundableCount: Number.MAX_SAFE_INTEGER, // every succeeded payment is refundable
    now,
  });
  const secondary = buildCorpus({
    projectId: secondaryId,
    environment: 'test',
    customerCount: SECONDARY_CUSTOMERS,
    paymentCount: SECONDARY_PAYMENTS,
    customerSampleSize: SAMPLE_SIZE,
    refundableCount: 0,
    now,
  });

  const sql = [
    'BEGIN;',
    customerInsertSql(primary.customers),
    paymentInsertSql(primary.payments),
    customerInsertSql(secondary.customers),
    paymentInsertSql(secondary.payments),
    'COMMIT;',
  ]
    .filter(Boolean)
    .join('\n');
  psql(sql);

  const customersInDb = Number(psqlValue('SELECT count(*) FROM customers;'));
  const paymentsInDb = Number(psqlValue('SELECT count(*) FROM payments;'));
  const openInDb = Number(psqlValue(`SELECT count(*) FROM payments WHERE status IN ('pending','processing');`));
  log(`seed: corpus inserted — customers=${customersInDb} payments=${paymentsInDb} (open tail=${openInDb}, sweep settles it)`);

  const expectedCustomers = SCAFFOLD_CUSTOMERS + primary.customers.length + secondary.customers.length;
  const expectedPayments = SCAFFOLD_PAYMENTS + primary.payments.length + secondary.payments.length;
  if (customersInDb !== expectedCustomers || paymentsInDb !== expectedPayments) {
    fail(
      `row-count mismatch (expected customers=${expectedCustomers} payments=${expectedPayments}, got ${customersInDb}/${paymentsInDb})`,
    );
  }

  // --- State file (mode 600; never printed) --------------------------------
  const state = {
    runId,
    seededAt: new Date().toISOString(),
    baseUrl: API_BASE,
    user: { email, password, orgId },
    keys: { primaryTest: primaryKey, secondaryTest: secondaryKey },
    primary: { id: primaryId, name: 'Loadtest Primary' },
    secondary: { id: secondaryId, name: 'Loadtest Secondary' },
    endpoints,
    samplePaymentIds: primary.samplePaymentIds,
    refundablePaymentIds: primary.refundablePaymentIds,
    secondarySamplePaymentIds: secondary.samplePaymentIds,
    customerIds: {
      primary: primary.customers.slice(0, SAMPLE_SIZE).map((row) => row.id),
      secondary: secondary.customers.map((row) => row.id),
    },
    counts: {
      primaryCustomers: primary.customers.length,
      primaryPayments: primary.payments.length,
      secondaryCustomers: secondary.customers.length,
      secondaryPayments: secondary.payments.length,
      refundablePayments: primary.refundablePaymentIds.length,
    },
  };

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(STATE_PATH, 0o600);

  log(
    `seed: state written (primary ${state.counts.primaryCustomers}c/${state.counts.primaryPayments}p, ` +
      `secondary ${state.counts.secondaryCustomers}c/${state.counts.secondaryPayments}p, ` +
      `refundable=${state.counts.refundablePayments})`,
  );
  log('seed: done (credentials and keys are in the state file only — never logged)');
}

// Fail fast on an unreachable compose binary before doing API work.
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  fail('docker compose is not available on PATH');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'unexpected failure');
});
