import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Phase 17 D1(a) — chromium-only browser end-to-end over the real stack (§12.5).
 *
 * Topology: the **built** apps exactly as the phase requires — API
 * (`dist/src/main.js`), webhook worker (`dist/src/worker.js`), web
 * (`next start`),
 * PostgreSQL and Redis. Run `pnpm build` first (in CI the build step precedes
 * this one); the servers below start built artifacts to match production
 * behavior.
 *
 * Scope: this layer proves only what genuinely needs a browser — cookies,
 * redirects, real security headers, real error envelopes and route
 * protection. The jsdom smokes (§12.4) remain the fast per-area feedback and
 * API e2e (§12.3) owns HTTP-level depth; the set here is the bounded §12.5
 * critical list, nothing more.
 *
 * This run **owns ports 3000/3001** and never reuses an existing server
 * (`reuseExistingServer: false`): a reused environment could carry a different
 * rate-limit posture and silently change what the §12.5 429 case asserts.
 * Close any local dev stack before running `pnpm test:browser`.
 *
 * Non-secret test-only configuration (§8): the JWT/webhook keys are generated
 * per run and never written to disk or output; every rate-limit and timing
 * override in {@link apiEnv} is declared next to the reason it differs from
 * the local defaults.
 */

const API_ORIGIN = 'http://localhost:3000';
const WEB_ORIGIN = 'http://localhost:3001';

/**
 * Test-only secrets, generated per run (AGENTS.md: never committed, never
 * logged). Both the API and the worker receive the same instance from
 * `apiEnv`, so webhook signing stays consistent within the run.
 */
const JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(48).toString('base64');
const WEBHOOK_ENCRYPTION_KEY =
  process.env.WEBHOOK_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');

/**
 * A dedicated Redis database for the browser run. The limiter stores its
 * opaque fixed-window counters in Redis (phase 13), so sharing database 0
 * with the in-process API e2e suites — whose gates are raised to ~100000 —
 * would let leftover counters trip this run's deliberately small budgets.
 * The limiter namespace is also cleared before the API boots (see the web
 * server command), making the run deterministic on rerun.
 */
function browserRedisUrl(): string {
  const raw = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const url = new URL(raw);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/15';
  return url.toString();
}

const apiEnv: Record<string, string> = {
  // Production posture for the **built** API — the artifacts this suite runs
  // are the same ones a deployment starts, so their runtime configuration is
  // production too:
  // - `NODE_ENV=production` is what makes the API enable `Secure` on the
  //   refresh cookie by default (phase 3 §5 / `COOKIE_SECURE`), and
  // - `COOKIE_SECURE: 'true'` states the same decision explicitly, so the
  //   cookie posture this suite exercises (and asserts in
  //   `test/browser/critical-flows.spec.ts`: `HttpOnly` + `SameSite=Lax` +
  //   `Secure`) can never drift with an implicit default.
  // The topology stays plain-HTTP loopback: `http://localhost` is a
  // trustworthy origin, so Chromium stores a `Secure` cookie set from it and
  // the flag under test is real, not relaxed for the test.
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  PORT: '3000',
  CORS_ORIGINS: WEB_ORIGIN,
  REDIS_URL: browserRedisUrl(),
  JWT_SECRET,
  WEBHOOK_ENCRYPTION_KEY,
  LOG_LEVEL: 'info',

  // Rate-limit posture for this run — every value non-secret and declared
  // (§8 "explicitly declared"):
  // - auth/session + read gates are raised: each test builds its own state
  //   through the UI/API (D4) and the dashboard polls, so one shared IP budget
  //   must not couple tests or trip on the polling;
  // - the generic write class stays small **on purpose**: §12.5's 429
  //   presentation case trips it through the UI (organization create) and it
  //   is declared last in the spec file for exactly that reason.
  AUTH_RATE_LIMIT_IP_LOGIN_MAX: '100000',
  AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX: '100000',
  AUTH_RATE_LIMIT_IP_REFRESH_MAX: '100000',
  AUTH_RATE_LIMIT_IP_READ_MAX: '100000',
  RATE_LIMIT_READ_MAX: '100000',
  RATE_LIMIT_WRITE_MAX: '10',
  RATE_LIMIT_WINDOW_SECONDS: '60',

  // Near-zero simulation timing (phase 7 §4.6): the payment journey observes a
  // terminal status through the page's own condition-based polling — no
  // sleep-based waiting anywhere (§4 rule 4).
  PAYMENT_PENDING_DELAY_MS: '100',
  PAYMENT_SETTLEMENT_DELAY_MS: '200',
};

export default defineConfig({
  testDir: './test/browser',
  // The bounded set is serial by design: the final test deliberately exhausts
  // the shared write budget, so nothing may run alongside or after it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_ORIGIN,
    // Failure-only artifacts (§8): traces/screenshots may contain session
    // material — generated, git-ignored, never committed or pasted anywhere.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Clear the limiter namespace (and nothing else — queues, sessions and
      // business data live under other keys) before the API boots, so a rerun
      // within the previous window starts from known rate-limit state. A
      // failed flush aborts the start (`&&`), which fails the run loudly.
      // Note: the build emits `dist/src/*` (the compiled program spans `src/`
      // plus the generated Prisma client), which is where these commands
      // point — `apps/api/package.json`'s `start` script currently names a
      // different path; that pre-existing mismatch is reported, not papered
      // over here.
      command: 'node scripts/clear-rate-limit-state.mjs && node dist/src/main.js',
      cwd: path.resolve(__dirname, '../api'),
      url: `${API_ORIGIN}/health/ready`,
      env: apiEnv,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      // The worker serves no HTTP; readiness is a startup log line. An early
      // exit still fails the run (Playwright rejects on unexpected process
      // exit), so a crashed worker can never read as green (rule 5).
      command: 'node dist/src/worker.js',
      cwd: path.resolve(__dirname, '../api'),
      env: apiEnv,
      wait: { stdout: /.+/ },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm start', // `next start --port 3001` (built app)
      cwd: __dirname,
      url: WEB_ORIGIN,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
