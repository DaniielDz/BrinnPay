/**
 * e2e bootstrap (phase 6 infra enablement).
 *
 * The e2e suites exercise the full auth surface from a single host
 * (127.0.0.1). The default per-IP rate limits (phase 3 D7, phase 13 §4.2) would
 * throttle an entire run, so they are raised here. Rate-limit behavior itself is
 * covered by dedicated cases — the unit specs under `src/rate-limiting/` and
 * `test/rate-limits.e2e-spec.ts`, which boots its own application with tight
 * limits — so the shared gate stays deterministic without weakening any of the
 * numbered acceptance criteria.
 */
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ??= '900';
process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_IP_REFRESH_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_IP_READ_MAX ??= '100000';

// Phase 13: every request under `/api/v1` now consumes a per-IP bucket, so a
// suite making hundreds of requests from one host needs these raised too.
process.env.RATE_LIMIT_READ_MAX ??= '100000';
process.env.RATE_LIMIT_WRITE_MAX ??= '100000';
process.env.RATE_LIMIT_WINDOW_SECONDS ??= '900';
process.env.RATE_LIMIT_WEBHOOK_REPLAY_MAX ??= '100000';
process.env.RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS ??= '900';
process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX ??= '100000';
process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS ??= '900';

/**
 * Phase 10 (D8): these suites run against a real PostgreSQL, so the API refuses
 * the committed test fallback encryption key and demands an explicit one — the
 * fallback would otherwise protect real rows in a real database with a key that
 * is public in this repository. A fixed non-secret value is correct here: the
 * e2e database is disposable and the key never leaves the machine.
 *
 * Note the refusal is keyed on `DATABASE_URL` being set, which it is in CI, so
 * this file must not reach for `WEBHOOK_ALLOW_INSECURE_TEST_KEY` instead.
 */
process.env.WEBHOOK_ENCRYPTION_KEY ??=
  Buffer.alloc(32, 0x2b).toString('base64');