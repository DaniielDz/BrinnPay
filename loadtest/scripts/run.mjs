#!/usr/bin/env node
/**
 * Phase 19 load-test runner — the single documented entry point (D1, AC1).
 *
 * Usage (from the repository root):
 *
 *   pnpm loadtest                 # full catalog, fresh stack, collect results
 *   pnpm loadtest -- --list       # show the catalog order and profiles
 *   pnpm loadtest -- --scenario s3-payments-read
 *   pnpm loadtest -- --no-reset   # reuse the current load stack volumes
 *   pnpm loadtest -- --keep-stack # leave stack + receiver up after the run
 *
 * What it does, in order:
 *
 *  1. preflight (docker, pinned images: grafana/k6:2.3.0, node:22-alpine);
 *  2. brings up a **dedicated compose project** (`brinnpay-loadtest`) on its
 *     own ports (3100/5543/6380/3201) with documented rate-limit overrides
 *     for the load stack — AC7: configuration of the local stack, catalog
 *     and algorithm untouched;
 *  3. starts the local webhook receiver on the stack network;
 *  4. seeds per D9 (`scripts/seed.mjs` — API scaffold + contract-valid bulk
 *     corpus) and waits for a quiet sweep;
 *  5. runs the catalog in the §16-informed order (S8 first, then S1–S4,
 *     settle, S5, settle, S6, S7, final settle) through containerized k6;
 *  6. samples worker/DB indicators every 5 s (`results/<run>/samples.jsonl`)
 *     and collects per-scenario k6 JSON + text summaries;
 *  7. writes `results/<run>/manifest.json` and `SUMMARY.txt`;
 *  8. tears down with `down -v` (the documented reset) unless told otherwise.
 *
 * Security properties (§8): secrets are read from `apps/api/.env` into the
 * compose child environment only — never printed, never passed as CLI args;
 * results and logs are checked for leakage by the operator before commit;
 * scenarios run against the local stack exclusively (fixed service DNS).
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADTEST_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(LOADTEST_DIR, '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker', 'compose.yml');
const APP_ENV_FILE = path.join(REPO_ROOT, 'apps', 'api', '.env');
const STATE_PATH = path.join(LOADTEST_DIR, '.state', 'state.json');

const COMPOSE_PROJECT = process.env.LOADTEST_COMPOSE_PROJECT ?? 'brinnpay-loadtest';
const NETWORK = `${COMPOSE_PROJECT}_default`;
const K6_IMAGE = 'grafana/k6:2.3.0';
const NODE_IMAGE = 'node:22-alpine';

/** Load-stack ports — dedicated so a dev stack may keep running alongside. */
const PORTS = { api: '3100', postgres: '5543', redis: '6380', web: '3201' };

/**
 * Documented rate-limit overrides for the load stack (AC7). The class
 * catalog, the algorithm and the *account* scope (ADR-0037 AR-3) are
 * untouched; only local IP/general scopes are raised so scenarios measure
 * the runtime instead of tripping the limiter. Values are recorded verbatim
 * in the run manifest and the baseline artifact.
 */
const RATE_LIMIT_OVERRIDES = {
  RATE_LIMIT_READ_MAX: '200000',
  RATE_LIMIT_WRITE_MAX: '200000',
  RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX: '1000',
  AUTH_RATE_LIMIT_IP_LOGIN_MAX: '100000',
  AUTH_RATE_LIMIT_IP_READ_MAX: '100000',
};

/**
 * Catalog execution order (committed, fixed): §16 suggests S8 first (both
 * planes reveal the dominant bottleneck class); S2 leaves its open-payment
 * backlog for S3 (deliberately no settle between them); a settle prepares
 * S5's fairness evidence; S6's request-log amplification then feeds S7's
 * log viewers; the final settle records the end state.
 */
const CATALOG = [
  { phase: 'scenario', id: 's8-mixed-steady-state', file: 'scenarios/s8-mixed-steady-state.ts', profile: '10 VUs × 90s, 40/35/25 create/list/refund' },
  { phase: 'scenario', id: 's1-auth-session', file: 'scenarios/s1-auth-session.ts', profile: '5 VUs × 60s, fresh accounts + AR-3 probe' },
  { phase: 'scenario', id: 's2-payments-write', file: 'scenarios/s2-payments-write.ts', profile: '10 VUs × 60s, 60% plain / 40% idempotent' },
  { phase: 'scenario', id: 's3-payments-read', file: 'scenarios/s3-payments-read.ts', profile: '10 VUs × 60s, 50% list / 50% get' },
  { phase: 'scenario', id: 's4-customers-search', file: 'scenarios/s4-customers-search.ts', profile: '10 VUs × 60s, 60% search / 40% list' },
  { phase: 'settle', label: 'settle-before-s5' },
  { phase: 'scenario', id: 's5-webhook-plane', file: 'scenarios/s5-webhook-plane.ts', profile: '5 VUs × 60s, 4:1 uneven split' },
  { phase: 'settle', label: 'settle-after-s5' },
  { phase: 'scenario', id: 's6-unmatched-404', file: 'scenarios/s6-unmatched-404.ts', profile: '10 VUs × 60s, unmatched paths' },
  { phase: 'scenario', id: 's7-dashboard-session', file: 'scenarios/s7-dashboard-session.ts', profile: '5 VUs × 60s, session mix' },
  { phase: 'settle', label: 'settle-final' },
];

// --- tiny CLI ----------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { scenarios: null, noReset: false, keepStack: false, list: false, help: false };
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--') continue; // pnpm may forward the flag separator verbatim
  if (arg === '--list') opts.list = true;
  else if (arg === '--no-reset') opts.noReset = true;
  else if (arg === '--keep-stack') opts.keepStack = true;
  else if (arg === '--help' || arg === '-h') opts.help = true;
  else if (arg === '--scenario' || arg === '-s') opts.scenarios = argv[++i];
  else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

if (opts.help) {
  process.stdout.write(fs.readFileSync(path.join(HERE, 'run.mjs'), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}
if (opts.list) {
  process.stdout.write('phase 19 catalog (execution order):\n');
  for (const step of CATALOG) {
    process.stdout.write(
      step.phase === 'scenario' ? `  ${step.id.padEnd(26)} ${step.profile}\n` : `  [${step.label}]\n`,
    );
  }
  process.exit(0);
}

function log(message) {
  process.stdout.write(`[loadtest] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[loadtest] ERROR: ${message}\n`);
  process.exit(1);
}

function composeArgs(...extra) {
  // `--profile worker` is a *global* compose flag (the `up` subcommand does
  // not accept it); harmless on down/exec and required so the payment-sweep
  // and webhook workers run on the load stack.
  return ['compose', '--profile', 'worker', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...extra];
}

function runSync(cmd, args, extra = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...extra });
  return result;
}

/**
 * Async variant for long-lived children (the k6 containers). `spawnSync`
 * blocks the event loop for the child's whole lifetime, which starves the
 * 5 s worker/DB sampler for the entire scenario — the first fixed runs
 * recorded zero in-scenario samples that way. Resolves like `runSync`.
 */
function runAsync(cmd, args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...extra });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function mustRun(cmd, args, extra = {}, label = `${cmd} ${args[0] ?? ''}`) {
  const result = runSync(cmd, args, extra);
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status}): ${(result.stderr ?? '').trim().split('\n').slice(-8).join(' | ')}`);
  }
  return result;
}

/** Reads WEBHOOK_ENCRYPTION_KEY from apps/api/.env into the child env only. */
function readWebhookEncryptionKey() {
  const inProcessEnv = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (inProcessEnv) return inProcessEnv;
  if (fs.existsSync(APP_ENV_FILE)) {
    const content = fs.readFileSync(APP_ENV_FILE, 'utf8');
    const match = content.match(/^WEBHOOK_ENCRYPTION_KEY=(.+)$/m);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      if (value.length > 0) return value;
    }
  }
  fail(
    'WEBHOOK_ENCRYPTION_KEY is not set (checked the environment and apps/api/.env). ' +
      'Set it in apps/api/.env (e.g. `openssl rand -base64 32`) — its value is never printed.',
  );
  return '';
}

function composeEnv() {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
    API_PORT: PORTS.api,
    POSTGRES_PORT: PORTS.postgres,
    REDIS_PORT: PORTS.redis,
    WEB_PORT: PORTS.web,
    WEBHOOK_ENCRYPTION_KEY: readWebhookEncryptionKey(),
    ...RATE_LIMIT_OVERRIDES,
  };
}

function composeExec(...extra) {
  return runSync('docker', composeArgs('exec', '-T', ...extra), { encoding: 'utf8', env: composeEnv() });
}

function composeUp() {
  // Everything except the worker: its payment-advancement sweeps and webhook
  // delivery loops need the schema, so it is started right after `migrate()`.
  mustRun(
    'docker',
    composeArgs('up', '-d', '--build', 'postgres', 'redis', 'api', 'web'),
    { env: composeEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    'compose up',
  );
}

/** Starts the profile-gated worker once the schema exists. */
function composeUpWorker() {
  log('starting webhook/payment worker …');
  mustRun('docker', composeArgs('up', '-d', 'worker'), { env: composeEnv(), stdio: ['ignore', 'pipe', 'pipe'] }, 'compose up worker');
}

/**
 * Applies Prisma migrations to the (always freshly wiped) load database.
 * Runs inside the API container so no host-side pnpm/Prisma install is
 * required — a clean checkout only needs Docker + Node.
 */
function migrate() {
  log('applying database migrations …');
  mustRun(
    'docker',
    composeArgs('exec', '-T', 'api', 'pnpm', 'prisma:migrate:deploy'),
    { env: composeEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    'prisma migrate deploy',
  );
}

function composeDown(withVolumes) {
  const args = composeArgs('down', ...(withVolumes ? ['-v', '--remove-orphans'] : []));
  runSync('docker', args, { env: composeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

// --- database probes ---------------------------------------------------------

/** One-row snapshot of the indicators the baseline needs (P3/§16). */
function dbSnapshotQuery() {
  return [
    "SELECT (SELECT count(*) FROM payments WHERE status IN ('pending','processing'))::text,",
    "       (SELECT count(*) FROM request_logs)::text,",
    "       (SELECT coalesce(pg_total_relation_size('request_logs'), 0))::text,",
    "       (SELECT coalesce(n_tup_ins, 0) FROM pg_stat_user_tables WHERE relname = 'request_logs')::text,",
    "       (SELECT count(*) FROM webhook_deliveries WHERE status = 'pending')::text,",
    "       (SELECT count(*) FROM webhook_deliveries WHERE status = 'delivered')::text,",
    "       (SELECT count(*) FROM webhook_deliveries WHERE status = 'failed')::text,",
    "       (SELECT coalesce(extract(epoch from (now() - min(created_at))), -1)::text FROM webhook_deliveries WHERE status = 'pending');",
  ].join('\n');
}

// SQL string literals need single quotes: in PostgreSQL, double quotes delimit
// identifiers, so `":"` fails with `column ":" does not exist` (which is
// exactly how the empty `pendingByProject` samples of the first fixed run
// manifested). JS strings here are double-quoted to carry the SQL quotes.
const PENDING_BY_PROJECT_QUERY = [
  'SELECT ep.project_id::text || chr(58) || count(*)::text || chr(58) ||',
  "       coalesce(extract(epoch from (now() - min(d.created_at)))::text, '-1')",
  'FROM webhook_deliveries d JOIN webhook_endpoints ep ON ep.id = d.endpoint_id',
  "WHERE d.status = 'pending' GROUP BY ep.project_id;",
].join(' ');

function dbSnapshot() {
  const result = composeExec(
    'postgres',
    'sh',
    '-c',
    'psql -At -F"|" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'sh',
    dbSnapshotQuery(),
  );
  if (result.status !== 0) return null;
  const parts = (result.stdout ?? '').trim().split('|');
  if (parts.length !== 8) return null;
  return {
    openPayments: Number(parts[0]),
    requestLogRows: Number(parts[1]),
    requestLogBytes: Number(parts[2]),
    requestLogInserts: Number(parts[3]),
    deliveriesPending: Number(parts[4]),
    deliveriesDelivered: Number(parts[5]),
    deliveriesFailed: Number(parts[6]),
    oldestPendingAgeSec: Number(parts[7]),
  };
}

function pendingByProject() {
  const result = composeExec(
    'postgres',
    'sh',
    '-c',
    'psql -At -F":" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'sh',
    PENDING_BY_PROJECT_QUERY,
  );
  const out = {};
  if (result.status !== 0) return out;
  for (const line of (result.stdout ?? '').trim().split('\n')) {
    const [projectId, count, oldest] = line.split(':');
    if (!projectId) continue;
    out[projectId] = { count: Number(count), oldestAgeSec: Number(oldest) };
  }
  return out;
}

function queueSnapshot() {
  const result = composeExec(
    'redis',
    'sh',
    '-c',
    [
      'redis-cli --raw LLEN bull:brinnpay-webhooks:wait',
      'redis-cli --raw LLEN bull:brinnpay-webhooks:active',
      'redis-cli --raw ZCARD bull:brinnpay-webhooks:delayed',
    ].join(' && '),
  );
  if (result.status !== 0) return { wait: null, active: null, delayed: null };
  const [wait, active, delayed] = (result.stdout ?? '').trim().split('\n');
  return { wait: Number(wait) || 0, active: Number(active) || 0, delayed: Number(delayed) || 0 };
}

async function receiverSnapshot() {
  try {
    const res = await fetch('http://localhost:4090/stats');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- sampler -----------------------------------------------------------------

const samples = [];
let currentPhase = 'preflight';
let samplerTimer = null;

async function takeSample() {
  const db = dbSnapshot();
  const sample = {
    t: new Date().toISOString(),
    phase: currentPhase,
    ...(db ?? {}),
    pendingByProject: pendingByProject(),
    queue: queueSnapshot(),
    receiver: await receiverSnapshot(),
  };
  samples.push(sample);
}

function startSampler() {
  samplerTimer = setInterval(() => {
    void takeSample();
  }, 5000);
  samplerTimer.unref();
}

function stopSampler() {
  if (samplerTimer) clearInterval(samplerTimer);
  samplerTimer = null;
}

// --- waits -------------------------------------------------------------------

async function waitForApiReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORTS.api}/health/ready`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  fail('API did not become ready on the load stack');
}

async function waitForQuietSweep(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = dbSnapshot();
    if (snap && snap.openPayments === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail('sweep did not reach a quiet state (open payments > 0) within the timeout');
}

/** Observed settle: let the worker drain open payments; record elapsed ms. */
async function settle(label, timeoutMs = 300_000) {
  currentPhase = label;
  const started = Date.now();
  log(`${label}: waiting for open payments to drain …`);
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await takeSample();
    const snap = samples[samples.length - 1];
    if (snap.openPayments === 0) {
      const elapsedMs = Date.now() - started;
      log(`${label}: quiet after ${(elapsedMs / 1000).toFixed(1)}s`);
      return elapsedMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  fail(`${label}: open payments still present after ${timeoutMs}ms`);
  return -1;
}

// --- k6 ----------------------------------------------------------------------

function ensureImages() {
  for (const image of [K6_IMAGE, NODE_IMAGE]) {
    const inspect = runSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    if (inspect.status !== 0) {
      log(`pulling ${image} …`);
      mustRun('docker', ['pull', image], { stdio: ['ignore', 'pipe', 'pipe'] }, `docker pull ${image}`);
    }
  }
}

function startReceiver() {
  runSync('docker', ['rm', '-f', 'brinnpay-loadtest-receiver'], { stdio: 'ignore' });
  const result = runSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      'brinnpay-loadtest-receiver',
      '--network',
      NETWORK,
      '-p',
      '4090:4090',
      '-v',
      `${path.join(LOADTEST_DIR, 'scripts', 'receiver.mjs')}:/app/receiver.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/app/receiver.mjs',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    fail(`receiver container failed to start (is the load stack up?): ${(result.stderr ?? '').trim()}`);
  }
}

function stopReceiver() {
  runSync('docker', ['rm', '-f', 'brinnpay-loadtest-receiver'], { stdio: 'ignore' });
}

async function runScenario(step, runId, uid, gid) {
  const shortId = step.id;
  const resultsRunDir = path.join(LOADTEST_DIR, 'results', runId);
  const args = [
    'run',
    '--rm',
    '--network',
    NETWORK,
    '--user',
    `${uid}:${gid}`,
    '-v',
    `${LOADTEST_DIR}:/loadtest`,
    '-v',
    `${path.join(LOADTEST_DIR, 'results')}:/results`,
    '-w',
    '/loadtest',
    '-e',
    'K6_BASE_URL=http://api:3000/api/v1',
    '-e',
    `K6_RESULTS_DIR=/results/${runId}`,
    K6_IMAGE,
    'run',
    '--no-color',
    '--summary-export',
    `/loadtest/results/${runId}/${shortId}_k6export.json`,
    step.file,
  ];

  currentPhase = shortId;
  const started = Date.now();
  log(`${shortId}: running (${step.profile}) …`);
  const result = await runAsync('docker', args);
  const elapsedMs = Date.now() - started;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  fs.writeFileSync(path.join(resultsRunDir, `${shortId}.log`), output);
  const exitCode = result.status ?? -1;
  log(
    `${shortId}: exit=${exitCode} in ${(elapsedMs / 1000).toFixed(1)}s` +
      (exitCode === 0 ? '' : ' (threshold breach recorded as evidence)'),
  );
  return { id: shortId, exitCode, elapsedMs };
}

// --- main --------------------------------------------------------------------

async function main() {
  // Preflight.
  const docker = runSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.status !== 0) fail('docker daemon is not reachable');
  mustRun('docker', ['compose', 'version'], { stdio: 'ignore' }, 'docker compose');
  ensureImages();

  const steps = opts.scenarios
    ? CATALOG.filter((step) => step.phase === 'scenario' && opts.scenarios.split(',').includes(step.id))
    : CATALOG;
  if (opts.scenarios && steps.filter((s) => s.phase === 'scenario').length === 0) {
    fail(`--scenario matched nothing (known ids: ${CATALOG.filter((s) => s.phase === 'scenario').map((s) => s.id).join(', ')})`);
  }

  const runId = `run-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  const resultsRunDir = path.join(LOADTEST_DIR, 'results', runId);
  fs.mkdirSync(resultsRunDir, { recursive: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;

  const commit = (() => {
    const res = runSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : 'unknown';
  })();

  log(`run ${runId} (commit ${commit.slice(0, 12)})`);

  // Stack.
  if (!opts.noReset) {
    log('resetting load stack (down -v) …');
    composeDown(true);
  }
  log(`starting compose project ${COMPOSE_PROJECT} (ports api=${PORTS.api} pg=${PORTS.postgres} redis=${PORTS.redis}) …`);
  composeUp();
  startReceiver();
  await waitForApiReady();
  migrate();
  composeUpWorker();

  // Seed + quiet sweep.
  const seed = runSync(process.execPath, [path.join(HERE, 'seed.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, API_BASE_URL: `http://localhost:${PORTS.api}/api/v1` },
  });
  process.stdout.write(seed.stdout ?? '');
  if (seed.status !== 0) {
    process.stderr.write(seed.stderr ?? '');
    fail('seed failed');
  }
  if (!fs.existsSync(STATE_PATH)) fail('seed produced no state file');
  await waitForQuietSweep();

  currentPhase = 'baseline';
  await takeSample();
  const baselineSample = samples[samples.length - 1];
  log(
    `baseline indicators: open=${baselineSample.openPayments} request_logs=${baselineSample.requestLogRows} ` +
      `deliveries pending=${baselineSample.deliveriesPending} delivered=${baselineSample.deliveriesDelivered}`,
  );

  // Catalog.
  startSampler();
  const scenarioResults = [];
  const settleResults = [];
  for (const step of steps) {
    if (step.phase === 'settle') {
      const elapsedMs = await settle(step.label);
      settleResults.push({ label: step.label, elapsedMs });
      continue;
    }
    scenarioResults.push(await runScenario(step, runId, uid, gid));
  }
  stopSampler();
  await takeSample(); // final sample
  const finalSample = samples[samples.length - 1];

  // Artifacts.
  fs.writeFileSync(path.join(resultsRunDir, 'samples.jsonl'), `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`);

  const summaryParts = [];
  for (const result of scenarioResults) {
    const logPath = path.join(resultsRunDir, `${result.id}.log`);
    if (fs.existsSync(logPath)) {
      summaryParts.push(`===== ${result.id} (exit ${result.exitCode}) =====\n${fs.readFileSync(logPath, 'utf8')}`);
    }
  }
  fs.writeFileSync(path.join(resultsRunDir, 'SUMMARY.txt'), summaryParts.join('\n'));

  const manifest = {
    runId,
    date: new Date().toISOString(),
    commit,
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    },
    composeProject: COMPOSE_PROJECT,
    ports: PORTS,
    rateLimitOverrides: RATE_LIMIT_OVERRIDES,
    k6Image: K6_IMAGE,
    seed: JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).counts,
    scenarios: scenarioResults,
    settles: settleResults,
    baselineSample,
    finalSample,
    notes: 'Local dev-machine baseline (D3): regression-relative, not a capacity claim.',
  };
  fs.writeFileSync(path.join(resultsRunDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  log(`results: ${path.relative(REPO_ROOT, resultsRunDir)}`);
  log('summary:');
  for (const result of scenarioResults) {
    log(`  ${result.id}: exit=${result.exitCode} ${(result.elapsedMs / 1000).toFixed(1)}s`);
  }

  // Teardown (documented reset) unless asked to keep.
  if (opts.keepStack) {
    log('leaving stack and receiver up (--keep-stack)');
  } else {
    log('tearing down (down -v) …');
    stopReceiver();
    composeDown(true);
  }
}

main().catch((error) => {
  stopSampler();
  fail(error instanceof Error ? error.message : 'unexpected failure');
});
