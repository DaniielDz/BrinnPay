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