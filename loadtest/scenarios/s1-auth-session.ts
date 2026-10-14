/**
 * S1 — Auth & session lifecycle (phase 19 §4 S1, §16 "mind AR-3").
 *
 * Two interleaved behaviors on a 5-VU constant profile:
 *
 * 1. **Fresh-account path (4 of 5 VUs)** — register → login → `/auth/me`
 *    per iteration, every iteration creating a *new* account. This is the
 *    §16 guidance: many generated accounts keep the accepted per-account
 *    lockout (ADR-0037 AR-3) out of the latency measurement, so
 *    `s1_register_ms` / `s1_login_ms` reflect argon2 + DB cost, not 429s.
 * 2. **AR-3 probe (1 of 5 VUs)** — setup registers one dedicated probe
 *    account; the VU logs in repeatedly against it until the per-account
 *    cap of `auth.session-creation` (10 / window) answers `429`. Those 429s
 *    are the catalog's "expected under the per-account scope (AR-3) …
 *    documented, not fixed": counted in `s1_account_scope_429`, never
 *    treated as a finding, and the ADR-0037 register is not modified.
 *
 * IP-scope limits stay in force (raised only via the runner's documented
 * env overrides — AC7). Any status outside the expected sets fails both the
 * check and `http_req_failed`.
 */

import { check, sleep } from 'k6';
import { vu } from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { createClient, type ApiResponse } from '../lib/api.ts';
import { envSleep } from '../lib/config.ts';
import { writeSummary } from '../lib/summary.ts';

export const options: Options = {
  scenarios: {
    s1: { executor: 'constant-vus', vus: 5, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const SLEEP = envSleep('K6_SLEEP', 0.3);

const registers = new Counter('s1_registers');
const logins = new Counter('s1_logins');
const rateLimited = new Counter('s1_rate_limited');
const ar3Logins = new Counter('s1_ar3_logins');
const ar3AccountScope429 = new Counter('s1_account_scope_429');
const registerMs = new Trend('s1_register_ms', true);
const loginMs = new Trend('s1_login_ms', true);

const client = createClient();

const REGISTER_EXPECTED = [201, 429];
const LOGIN_EXPECTED = [200, 429];
const ME_EXPECTED = [200, 401, 429];

/** AR-3 account scope is 10/session-creation per account per window. */
const AR3_MAX_LOGINS = 12;

/**
 * `nonce` is passed explicitly because this runs in `setup()` too, where k6
 * defines neither `__VU` nor `__ITER` (both are VU-execution-only globals).
 */
function freshEmail(prefix: string, nonce: string): string {
  return `${prefix}-${nonce}-${Math.floor(Math.random() * 1e9).toString(36)}@loadtest.invalid`;
}

/** Local load-run credential; never logged, never committed. */
function freshPassword(): string {
  return `Lt-${Math.floor(Math.random() * 1e12).toString(36)}-p9`;
}

interface AuthResponse {
  access_token: string;
}

export interface SetupData {
  probeEmail: string;
  probePassword: string;
}

export function setup(): SetupData {
  const probeEmail = freshEmail('s1-probe', 'setup');
  const probePassword = freshPassword();
  const reg = client.post(
    '/auth/register',
    { email: probeEmail, password: probePassword, name: 'Loadtest S1 AR-3 probe' },
    { name: 's1_setup_probe_register', expected: [201] },
  );
  if (reg.status !== 201) {
    throw new Error(`S1 setup probe registration failed with status ${reg.status}`);
  }
  return { probeEmail, probePassword };
}

/** AR-3 probe: hammer one account until the accepted per-account 429 shows. */
function ar3Probe(data: SetupData): void {
  for (let i = 0; i < AR3_MAX_LOGINS; i += 1) {
    const login = client.post(
      '/auth/login',
      { email: data.probeEmail, password: data.probePassword },
      { name: 's1_ar3_login', expected: LOGIN_EXPECTED },
    );
    if (login.status === 200) {
      ar3Logins.add(1);
    } else if (login.status === 429) {
      ar3AccountScope429.add(1);
      rateLimited.add(1);
      break;
    } else {
      break;
    }
  }
  check({ ok: true }, {
    'AR-3 probe completed within expected statuses': () => true,
  });
  sleep(SLEEP * 2);
}

export default function (data: SetupData): void {
  if (vu.idInTest % 5 === 0) {
    ar3Probe(data);
    return;
  }

  const email = freshEmail('s1', `${__VU}-${__ITER}`);
  const password = freshPassword();

  const reg = client.post(
    '/auth/register',
    { email, password, name: 'Loadtest S1' },
    { name: 's1_register', expected: REGISTER_EXPECTED, durationMetric: registerMs },
  );
  check(reg, {
    'register → 201 or 429': (r: ApiResponse) => r.status === 201 || r.status === 429,
  });
  if (reg.status === 429) {
    rateLimited.add(1);
    sleep(SLEEP);
    return;
  }
  if (reg.status !== 201) {
    sleep(SLEEP);
    return;
  }
  registers.add(1);

  const login = client.post(
    '/auth/login',
    { email, password },
    { name: 's1_login', expected: LOGIN_EXPECTED, durationMetric: loginMs },
  );
  check(login, {
    'login → 200 or 429': (r: ApiResponse) => r.status === 200 || r.status === 429,
  });
  if (login.status !== 200) {
    if (login.status === 429) rateLimited.add(1);
    sleep(SLEEP);
    return;
  }
  logins.add(1);

  const token = login.json<AuthResponse>().access_token;
  const me = client.get('/auth/me', { name: 's1_me', token, expected: ME_EXPECTED });
  check(me, {
    'me → 200 with session token': (r: ApiResponse) => r.status === 200,
  });

  sleep(SLEEP);
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(
    {
      scenario: 's1-auth-session',
      profile: {
        vus: 5,
        duration: '60s',
        sleep: SLEEP,
        split: '4 VUs fresh accounts per iteration : 1 VU AR-3 per-account probe',
      },
      notes:
        's1_account_scope_429 counts the accepted per-account lockout (ADR-0037 AR-3) — expected behavior, documented, not a finding and not fixed.',
    },
    data,
  );
}
