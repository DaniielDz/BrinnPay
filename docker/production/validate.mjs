#!/usr/bin/env node
/**
 * Phase 21 production runtime validation — the single documented entry point
 * for §6 M5 (D5(a), ADR-0046). Runnable from a clean checkout with only
 * Docker and this repository; CI wiring is Phase 23's (§12).
 *
 * Usage (from the repository root):
 *
 *   node docker/production/validate.mjs              # build + full validation
 *   node docker/production/validate.mjs --no-build   # reuse existing images
 *   node docker/production/validate.mjs --keep-stack # leave the stack up
 *
 * What it does, in order:
 *
 *  1. preflight (docker + compose present);
 *  2. builds both production images with local tags `brinnpay/{api,web}:
 *     <version>-<sha>` (D6(a): local tags only — no registry, no push);
 *  3. NEGATIVE secret runs: the API image must refuse to boot without
 *     JWT_SECRET, with a weak JWT_SECRET, and without WEBHOOK_ENCRYPTION_KEY —
 *     with no secret material in any refusal output (§6 M4, AC4);
 *  4. provisions throwaway PostgreSQL/Redis (compose project
 *     `brinnpay-production`, isolated from dev and load-test projects);
 *  5. NEGATIVE pre-migration run: the API boots against the unmigrated
 *     database, reports /health/ready 200 (reachability only — Phase 2 D9,
 *     F16) and fails the domain smoke call, proving readiness ≠ schema;
 *  6. applies migrations (D3(a)/Q1: explicit pre-start step, ADR-0045);
 *  7. starts API + worker + web from the production images with a complete
 *     production environment and the D8(a) run-scoped plain-HTTP overrides
 *     (COOKIE_SECURE=false / WEB_SECURE=false — local validation only);
 *  8. asserts the §6 M5 checklist (see ASSERTIONS below), including
 *     cross-process key equality (F8) and a layer/history secret scan (F11);
 *  9. tears the stack down (`down -v`) unless told otherwise.
 *
 * Security properties (§8): secrets are generated per run (CSPRNG), written
 * only to a mode-600 temp env file that is deleted on exit, injected into
 * containers as environment, never printed, never passed as CLI arguments,
 * and never baked into an image or a committed file.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(DOCKER_DIR, '..');
const COMPOSE_FILE = path.join(DOCKER_DIR, 'compose.production.yml');
const COMPOSE_PROJECT = 'brinnpay-production';

const API_HOST = process.env.API_PORT ?? '3000';
const WEB_HOST = process.env.WEB_PORT ?? '3001';
const API_URL = `http://localhost:${API_HOST}`;
const WEB_URL = `http://localhost:${WEB_HOST}`;

// --- tiny CLI ----------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = { keepStack: false, noBuild: false, help: false };
for (const arg of argv) {
  if (arg === '--') continue;
  else if (arg === '--keep-stack') opts.keepStack = true;
  else if (arg === '--no-build') opts.noBuild = true;
  else if (arg === '--help' || arg === '-h') opts.help = true;
  else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

if (opts.help) {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

function log(message) {
  process.stdout.write(`[production-validate] ${message}\n`);
}

/** Tracks whether the compose stack exists, so a failed run can clean up. */
let stackTouched = false;

/** Removes the temp env file holding the generated secrets (exit-safe). */
function cleanupEnvFile() {
  try {
    fs.rmSync(path.dirname(ENV_FILE), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on('exit', cleanupEnvFile);

function fail(message) {
  process.stderr.write(`[production-validate] ERROR: ${message}\n`);
  // A failed run must not leave containers holding run secrets behind.
  if (stackTouched && !opts.keepStack) {
    compose('down', '-v', '--remove-orphans');
  }
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------

/** Runs a command, returns { status, stdout, stderr }. Never throws. */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** compose invocation with the isolated project and the generated env file. */
function compose(...extra) {
  return run('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, '--env-file', ENV_FILE, ...extra]);
}

function composeOrDie(...extra) {
  const result = compose(...extra);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail(`docker compose ${extra.join(' ')} failed (exit ${result.status})`);
  }
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, probe, { timeoutMs = 120_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never ran';
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  fail(`timed out waiting for ${description} (${lastError})`);
}

async function fetchStatus(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

/** True when the container health is "healthy" (or it has no healthcheck). */
async function serviceHealthy(service) {
  const id = compose('ps', '-q', service).stdout.trim();
  if (!id) return false;
  const inspected = run('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id]);
  return inspected.stdout.trim() === 'healthy';
}

// --- assertion bookkeeping ---------------------------------------------------

const results = [];

async function check(id, description, assertion) {
  try {
    await assertion();
    results.push({ id, description, passed: true });
    log(`[PASS] ${id} ${description}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    results.push({ id, description, passed: false, reason });
    log(`[FAIL] ${id} ${description} — ${reason}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --- secrets (generated per run, never printed) ------------------------------

const secrets = {
  JWT_SECRET: randomBytes(48).toString('base64'),
  WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  METRICS_SCRAPE_TOKEN: randomBytes(48).toString('base64'),
  // Hex, not base64: this value is embedded in DATABASE_URL, so it must be
  // URL-safe (a `/` or `+` in the authority would break the connection string).
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
};
const REAL_SECRETS = Object.values(secrets);

/** Refuses to continue if a secret value ever appears in command output. */
function assertNoSecretLeak(text, context) {
  for (const secret of REAL_SECRETS) {
    expect(!text.includes(secret), `a generated secret leaked into ${context}`);
  }
}

// --- environment file --------------------------------------------------------

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const gitSha = run('git', ['rev-parse', '--short', 'HEAD']).stdout.trim();
const TAG_SUFFIX = gitSha || `local-${Date.now()}`;
const IMAGES = {
  api: `brinnpay/api:${VERSION}-${TAG_SUFFIX}`,
  web: `brinnpay/web:${VERSION}-${TAG_SUFFIX}`,
  migrate: `brinnpay/migrate:${VERSION}-${TAG_SUFFIX}`,
};

const ENV_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brinnpay-prod-validate-')), 'production.env');
const WEBHOOK_ALLOW = randomBytes(16).toString('hex');

function writeEnvFile() {
  // D8(a): COOKIE_SECURE/WEB_SECURE=false are RUN-SCOPED plain-HTTP overrides
  // for this validation environment only — production expectations remain
  // true (Phase 18 §5); nothing here writes a default back into the code.
  const lines = [
    `POSTGRES_USER=brinnpay`,
    `POSTGRES_PASSWORD=${secrets.POSTGRES_PASSWORD}`,
    `POSTGRES_DB=brinnpay`,
    `DATABASE_URL=postgresql://brinnpay:${secrets.POSTGRES_PASSWORD}@postgres:5432/brinnpay?schema=public`,
    `REDIS_URL=redis://redis:6379`,
    `CORS_ORIGINS=${WEB_URL}`,
    `NEXT_PUBLIC_API_BASE_URL=${API_URL}/api/v1`,
    `JWT_SECRET=${secrets.JWT_SECRET}`,
    `WEBHOOK_ENCRYPTION_KEY=${secrets.WEBHOOK_ENCRYPTION_KEY}`,
    `METRICS_SCRAPE_TOKEN=${secrets.METRICS_SCRAPE_TOKEN}`,
    `COOKIE_SECURE=false`,
    `WEB_SECURE=false`,
    `API_IMAGE=${IMAGES.api}`,
    `WEB_IMAGE=${IMAGES.web}`,
    `MIGRATE_IMAGE=${IMAGES.migrate}`,
  ];
  fs.writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// --- phases ------------------------------------------------------------------

function preflight() {
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.status !== 0) fail('docker is not available (is the daemon running?)');
  const composeVersion = run('docker', ['compose', 'version']);
  if (composeVersion.status !== 0) fail('docker compose v2 is required');
  log(`docker ${docker.stdout.trim()}, compose ok`);
}

function buildImages() {
  if (opts.noBuild) {
    log('skipping image build (--no-build)');
    return;
  }
  log(`building production images (tags: ${IMAGES.api}, ${IMAGES.web})`);
  composeOrDie(
    'build',
    '--build-arg',
    `NEXT_PUBLIC_API_BASE_URL=${API_URL}/api/v1`,
    'api',
    'worker',
    'web',
    'migrate',
  );
}

async function negativeSecretRuns() {
  // The production image must refuse to boot on missing/weak secrets (§6 M4,
  // AC4) — and the refusal must never echo a secret value.
  await check('M5-2', 'API refuses to boot on missing/weak secrets (negative runs)', async () => {
    const baseEnv = [
      '-e', 'NODE_ENV=production',
      '-e', 'DATABASE_URL=postgresql://brinnpay:invalid@postgres:5432/brinnpay?schema=public',
      '-e', 'REDIS_URL=redis://redis:6379',
      '-e', 'CORS_ORIGINS=http://localhost:3001',
    ];

    const missingJwt = run('docker', ['run', '--rm', ...baseEnv, IMAGES.api]);
    expect(missingJwt.status !== 0, 'API booted without JWT_SECRET');
    expect(
      `${missingJwt.stdout}${missingJwt.stderr}`.includes('JWT_SECRET is required'),
      'refusal message does not name JWT_SECRET',
    );
    assertNoSecretLeak(`${missingJwt.stdout}${missingJwt.stderr}`, 'the missing-JWT refusal output');

    const weakJwt = run('docker', ['run', '--rm', ...baseEnv, '-e', 'JWT_SECRET=too-short', IMAGES.api]);
    expect(weakJwt.status !== 0, 'API booted with a weak JWT_SECRET');
    expect(
      `${weakJwt.stdout}${weakJwt.stderr}`.includes('at least 32'),
      'weak-JWT refusal does not mention the length floor',
    );

    const missingKey = run('docker', [
      'run', '--rm', ...baseEnv, '-e', `JWT_SECRET=${secrets.JWT_SECRET}`, IMAGES.api,
    ]);
    expect(missingKey.status !== 0, 'API booted without WEBHOOK_ENCRYPTION_KEY');
    expect(
      `${missingKey.stdout}${missingKey.stderr}`.includes('WEBHOOK_ENCRYPTION_KEY is required'),
      'refusal message does not name WEBHOOK_ENCRYPTION_KEY',
    );
    assertNoSecretLeak(`${missingKey.stdout}${missingKey.stderr}`, 'the missing-key refusal output');

    // Same refusal for the worker process (same image, same module graph).
    const workerMissingJwt = run('docker', ['run', '--rm', ...baseEnv, IMAGES.api, 'node', 'dist/src/worker.js']);
    expect(workerMissingJwt.status !== 0, 'the worker booted without JWT_SECRET');
  });
}

async function startDependencies() {
  log('starting throwaway PostgreSQL/Redis');
  composeOrDie('up', '-d', 'postgres', 'redis');
  stackTouched = true;
  await waitFor('postgres to be healthy', () => serviceHealthy('postgres'));
  await waitFor('redis to be healthy', () => serviceHealthy('redis'));
}

async function preMigrationNegativeRun() {
  // F16: readiness checks reachability only, so an unmigrated database still
  // answers /health/ready 200 while every domain call fails. This negative
  // run proves it — and proves why migrations must precede traffic (D3(a)).
  log('negative run: API against the unmigrated database');
  composeOrDie('up', '-d', '--no-deps', 'api');
  await waitFor('the API to answer /health/ready', async () => {
    const response = await fetchStatus(`${API_URL}/health/ready`);
    return response.status === 200;
  });

  const ready = await fetchStatus(`${API_URL}/health/ready`);
  expect(ready.status === 200, 'readiness was not 200 on an unmigrated database');
  const readyJson = JSON.parse(ready.body);
  expect(readyJson.status === 'ok', 'readiness payload was not ok');
  expect(readyJson.checks?.database?.status === 'up', 'readiness did not report database up');
  expect(readyJson.checks?.redis?.status === 'up', 'readiness did not report redis up');

  const register = await fetchStatus(`${API_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `premigrate-${Date.now()}@example.test`, password: 'validation-only-pw-1' }),
  });
  expect(register.status >= 500, `domain call unexpectedly succeeded pre-migration (status ${register.status})`);

  composeOrDie('rm', '-sf', 'api');
}

async function applyMigrations() {
  log('applying migrations (pre-start step, D3(a))');
  const result = compose('run', '--rm', 'migrate');
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assertNoSecretLeak(`${result.stdout}${result.stderr}`, 'the migration output');
  expect(result.status === 0, `prisma migrate deploy failed (exit ${result.status})`);
}

async function startStack() {
  log('starting API + worker + web from the production images');
  composeOrDie('up', '-d', 'api', 'worker', 'web');
  await waitFor('the API to answer /health/ready', async () => {
    const response = await fetchStatus(`${API_URL}/health/ready`);
    return response.status === 200;
  });
  await waitFor('the worker healthcheck', () => serviceHealthy('worker'));
  await waitFor('the web healthcheck', () => serviceHealthy('web'));
}

// --- the §6 M5 checklist -----------------------------------------------------

async function runAssertions() {
  let accessToken = null;

  await check('M5-1', 'API probes answer with the documented Phase 2 payloads', async () => {
    const live = await fetchStatus(`${API_URL}/health/live`);
    expect(live.status === 200, `/health/live status ${live.status}`);
    expect(live.body === '{"status":"ok"}', `/health/live payload ${live.body}`);

    const ready = await fetchStatus(`${API_URL}/health/ready`);
    expect(ready.status === 200, `/health/ready status ${ready.status}`);
    const json = JSON.parse(ready.body);
    expect(json.status === 'ok', 'readiness status not ok');
    expect(json.checks?.database?.status === 'up', 'database not up');
    expect(json.checks?.redis?.status === 'up', 'redis not up');
  });

  // (M5-2 negative secret refusals ran before boot, from the image directly.)

  await check('M5-3', 'post-migration domain smoke: register + authenticated organization read', async () => {
    const email = `validate-${Date.now()}@example.test`;
    const register = await fetchStatus(`${API_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'validation-only-pw-1' }),
    });
    expect(register.status === 201, `register status ${register.status}: ${register.body.slice(0, 200)}`);
    const session = JSON.parse(register.body);
    accessToken = session.access_token;
    expect(typeof accessToken === 'string' && accessToken.length > 0, 'no access_token in the register response');

    const organizations = await fetchStatus(`${API_URL}/api/v1/organizations`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(organizations.status === 200, `organizations status ${organizations.status}`);
    const list = JSON.parse(organizations.body);
    expect(Array.isArray(list.data) && list.data.length >= 1, 'the default organization is missing');
  });

  await check('M5-4', 'worker is running and liveness answers on WORKER_METRICS_PORT', async () => {
    const exec = run('docker', [
      'compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, '--env-file', ENV_FILE,
      'exec', '-T', 'api', 'node', '-e',
      "fetch('http://worker:9464/health/live').then(async (r) => { const b = await r.text(); process.stdout.write(`${r.status} ${b}`); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))",
    ]);
    expect(exec.status === 0, `worker liveness probe failed: ${exec.stdout} ${exec.stderr}`);
    expect(exec.stdout.includes('{"status":"ok"}'), `worker liveness payload: ${exec.stdout}`);
  });

  await check('M5-5', 'web serves the home page and the API reference from the canonical contract', async () => {
    const home = await fetchStatus(`${WEB_URL}/`);
    expect(home.status === 200, `home status ${home.status}`);

    const reference = await fetchStatus(`${WEB_URL}/docs/api-reference`);
    expect(reference.status === 200, `api-reference status ${reference.status}`);
    // Contract-derived content (ADR-0030): the reference is generated from
    // docs/openapi.yaml, so a known operation path/title must be present.
    expect(reference.body.includes('/auth/register'), 'reference does not contain a contract operation');
    expect(reference.body.includes('BrinnPay'), 'reference does not contain the contract title');
  });

  await check('M5-6', 'metrics exposition is off by default; enabled mode enforces the token posture', async () => {
    const off = await fetchStatus(`${API_URL}/metrics`);
    expect(off.status === 404, `metrics answered ${off.status} under production defaults`);

    const workerOff = run('docker', [
      'compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, '--env-file', ENV_FILE,
      'exec', '-T', 'api', 'node', '-e',
      "fetch('http://worker:9464/metrics').then((r) => process.exit(r.status === 404 ? 0 : 1)).catch(() => process.exit(1))",
    ]);
    expect(workerOff.status === 0, 'worker exposition answered under production defaults');
  });

  // The M5-6 enabled-mode proof needs a token-gated recreate; done as its own
  // step so the failure of the previous assertion cannot mask it.
  await check('M5-6b', 'when deliberately enabled, /metrics requires the bearer token', async () => {
    const recreated = run(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'up', '-d', '--force-recreate', 'api'],
      { METRICS_ENABLED: 'true', METRICS_SCRAPE_TOKEN: secrets.METRICS_SCRAPE_TOKEN },
    );
    expect(recreated.status === 0, `recreate failed: ${recreated.stderr}`);
    await waitFor('the recreated API', async () => {
      const response = await fetchStatus(`${API_URL}/health/ready`);
      return response.status === 200;
    });

    const unauthorized = await fetchStatus(`${API_URL}/metrics`);
    expect(unauthorized.status === 401, `unauthenticated scrape answered ${unauthorized.status}`);

    const authorized = await fetchStatus(`${API_URL}/metrics`, {
      headers: { authorization: `Bearer ${secrets.METRICS_SCRAPE_TOKEN}` },
    });
    expect(authorized.status === 200, `authenticated scrape answered ${authorized.status}`);
    expect(authorized.body.includes('brinnpay_'), 'exposition does not carry the documented metric names');
  });

  await check('M5-7', 'neither image contains a secret, an .env file, or the dev toolchain (layer/history scan)', async () => {
    for (const image of [IMAGES.api, IMAGES.web]) {
      const history = run('docker', ['history', '--no-trunc', image]);
      expect(history.status === 0, `docker history failed for ${image}`);
      assertNoSecretLeak(history.stdout, `docker history of ${image}`);
      // Committed-artifact hygiene: no secret-shaped layer commands.
      expect(!/JWT_SECRET=[A-Za-z0-9+/=]{16,}/.test(history.stdout), `JWT_SECRET baked into a layer of ${image}`);
      expect(!/WEBHOOK_ENCRYPTION_KEY=[A-Za-z0-9+/=]{16,}/.test(history.stdout), `encryption key baked into a layer of ${image}`);

      const probe = run('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c',
        // No env dotfiles, no dev toolchain binaries, non-root user.
        'find /app -name ".env*" 2>/dev/null | grep -q . && { echo ENV-FILE-PRESENT; exit 1; }; ' +
        'test -e /app/node_modules/.bin/tsc -o -e /app/node_modules/.bin/nest -o -e /app/node_modules/.bin/eslint && { echo DEV-TOOLCHAIN-PRESENT; exit 1; }; ' +
        'test "$(id -u)" = "0" && { echo RUNNING-AS-ROOT; exit 1; }; ' +
        'echo OK',
      ]);
      expect(probe.status === 0, `image hygiene probe failed for ${image}: ${probe.stdout} ${probe.stderr}`);
      expect(probe.stdout.includes('OK'), `image hygiene probe did not pass for ${image}`);
    }

    // The API runtime layer additionally carries no TypeScript sources, test
    // suites, or generated-source tree (§6 M1/§8 rule 3).
    const apiPayload = run('docker', ['run', '--rm', '--entrypoint', 'sh', IMAGES.api, '-c',
      'test -d /app/apps/api/src && { echo SRC-PRESENT; exit 1; }; ' +
      'test -d /app/apps/api/test && { echo TEST-PRESENT; exit 1; }; ' +
      'test -d /app/apps/api/generated && { echo GENERATED-SOURCE-PRESENT; exit 1; }; ' +
      'test -f /app/apps/api/dist/src/main.js -a -f /app/apps/api/dist/src/worker.js -a -f /app/docs/openapi.yaml || exit 1; ' +
      'echo OK',
    ]);
    expect(apiPayload.status === 0 && apiPayload.stdout.includes('OK'), `API runtime payload probe failed: ${apiPayload.stdout} ${apiPayload.stderr}`);

    // In-container content scan of both runtime payloads for the run's
    // secrets (they were only ever runtime environment — F11/§8 rule 1).
    for (const image of [IMAGES.api, IMAGES.web]) {
      for (const [name, value] of Object.entries(secrets)) {
        const scan = run('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c',
          `grep -rF --exclude-dir=.pnpm ${JSON.stringify(value)} /app 2>/dev/null | head -1`,
        ]);
        expect(scan.stdout.trim() === '', `${name} found inside the filesystem of ${image}`);
      }
    }
  });

  await check('M5-8', 'D8(a) posture: plain-HTTP run with run-scoped overrides, authenticated flow works', async () => {
    const home = await fetchStatus(`${WEB_URL}/`);
    expect(!home.headers.get('strict-transport-security'), 'HSTS was sent despite WEB_SECURE=false (run-scoped override ignored)');
    expect(home.headers.get('content-security-policy')?.includes("connect-src 'self'"), 'CSP missing connect-src');

    // COOKIE_SECURE=false (run-scoped): the refresh cookie is set without the
    // Secure attribute so the plain-HTTP authenticated flow can be exercised.
    const register = await fetchStatus(`${API_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `tls-${Date.now()}@example.test`, password: 'validation-only-pw-1' }),
    });
    expect(register.status === 201, `register over plain HTTP failed (${register.status})`);
    const setCookie = register.headers.get('set-cookie') ?? '';
    expect(setCookie.length > 0, 'no refresh cookie was set');
    expect(!/;\s*secure/i.test(setCookie), `cookie carried Secure despite the run-scoped override: ${setCookie}`);
  });

  await check('M5-9', 'cross-process key equality: API and worker share JWT_SECRET and WEBHOOK_ENCRYPTION_KEY (F8)', async () => {
    // `compose config` resolves the interpolation, so its output contains the
    // secrets IN MEMORY — it is parsed here and never echoed to any log.
    const config = compose('config', '--format', 'json');
    expect(config.status === 0, 'compose config failed');
    const parsed = JSON.parse(config.stdout);
    const environmentOf = (service) => parsed.services?.[service]?.environment ?? {};
    const apiEnv = environmentOf('api');
    const workerEnv = environmentOf('worker');
    for (const key of ['JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY']) {
      expect(apiEnv[key] === workerEnv[key], `${key} differs between api and worker`);
      expect(typeof apiEnv[key] === 'string' && apiEnv[key].length > 0, `${key} is empty on api`);
    }
  });
}

// --- teardown ----------------------------------------------------------------

function teardown() {
  if (opts.keepStack) {
    log(`keeping the stack up (project ${COMPOSE_PROJECT}); tear down with:`);
    log(`  docker compose -p ${COMPOSE_PROJECT} -f docker/compose.production.yml --env-file <env> down -v`);
    return;
  }
  log('tearing the stack down (down -v)');
  compose('down', '-v', '--remove-orphans');
}

// --- main --------------------------------------------------------------------

async function main() {
  preflight();
  writeEnvFile();
  buildImages();

  log('negative secret-refusal runs (§6 M4)');
  await negativeSecretRuns();

  await startDependencies();
  await preMigrationNegativeRun();
  await applyMigrations();
  await startStack();
  await runAssertions();

  const failed = results.filter((result) => !result.passed);
  log(`— ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  for (const failure of failed) {
    process.stderr.write(`[production-validate] FAILED ${failure.id}: ${failure.description} — ${failure.reason}\n`);
  }

  teardown();
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    process.stderr.write(`[production-validate] ERROR: ${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The env file holds every generated secret: remove it whatever happens.
    try {
      fs.rmSync(path.dirname(ENV_FILE), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
