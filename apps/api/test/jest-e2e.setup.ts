/**
 * e2e bootstrap (phase 6 infra enablement).
 *
 * The e2e suites exercise the full auth surface from a single host
 * (127.0.0.1). The default per-IP auth rate limits (phase 3 D7) would
 * throttle an entire run, so they are raised here. Rate-limit behavior itself
 * remains covered by unit tests (`src/auth/rate-limit.service.spec.ts` and
 * the guard's own specs), so the e2e gate can be deterministic.
 */
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ??= '900';
process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_IP_REFRESH_MAX ??= '100000';
process.env.AUTH_RATE_LIMIT_IP_READ_MAX ??= '100000';

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