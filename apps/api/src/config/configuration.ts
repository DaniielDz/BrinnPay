import {
  canonicalizeWebhookHost,
} from '../webhooks/webhook-url';
import { resolveWebhookEncryptionKey } from '../webhooks/webhook-crypto';

export interface BrinnPayConfig {
  nodeEnv: string;
  port: number;
  serviceName: string;
  databaseUrl: string;
  redisUrl: string;
  logLevel: string;
  corsOrigins: string[];
  openapiPath: string;
  swaggerPath: string;
  jwt: {
    secret: string;
    accessTokenTtlSeconds: number;
  };
  auth: {
    cookieName: string;
    cookieSecure: boolean;
    cookieSameSite: 'lax' | 'strict';
    refreshSessionTtlDays: number;
    rateLimits: {
      windowSeconds: number;
      ipLoginRegisterMax: number;
      accountLoginRegisterMax: number;
      ipRefreshMax: number;
      ipReadMax: number;
    };
  };
  payments: {
    pendingDelayMs: number;
    settlementDelayMs: number;
  };
  idempotency: {
    retentionHours: number;
  };
  webhooks: {
    /**
     * AES-256-GCM key protecting endpoint signing secrets at rest (D8). Validated
     * at boot: a missing/short key fails fast exactly like `JWT_SECRET`
     * (phase 3 §7.7).
     */
    secretEncryptionKey: Buffer;
    /** Total HTTP attempts per delivery, first attempt included (D5). */
    maxAttempts: number;
    /** Ceiling of the exponential backoff between attempts, in ms (D5). */
    maxBackoffMs: number;
    /** Base of the exponential backoff (attempt 1 is immediate) (D5). */
    baseBackoffMs: number;
    /** Connect timeout of an outbound delivery request, in ms (§5.4). */
    connectTimeoutMs: number;
    /** Total timeout of an outbound delivery request, in ms (§5.4). */
    requestTimeoutMs: number;
    /** Retention window for stored events, in days (D9). */
    eventRetentionDays: number;
    /** How often the delivery reconciliation pass runs, in ms (D2, D3). */
    reconciliationIntervalMs: number;
    /**
     * How far back one reconciliation pass may repair, in ms (D2). The pass scans
     * `created_at >= now - horizon` and `created_at <= now - minAge`, so it never
     * walks the retention window and a re-enabled endpoint is backfilled only for
     * recent events. Must be greater than the pass's minimum age; validated when
     * the delivery policy is built.
     */
    reconciliationHorizonMs: number;
    /**
     * How long a **failed** queue job's hash is kept in Redis, in ms. Completed
     * jobs are removed as soon as they finish, so this is the only job data that
     * outlives the work it did.
     */
    failedJobRetentionMs: number;
    /** How many failed jobs are kept at once, oldest evicted first. */
    retainedFailedJobs: number;
    /** How often the payment advancement sweep runs, in ms (D3, F2). */
    advancementSweepIntervalMs: number;
    /** How often the retention cleanup pass runs, in ms (D9). */
    cleanupIntervalMs: number;
    /**
     * Optional destination policy (D13). Both lists are `null` by default, which
     * is the permissive posture a sandbox needs (`localhost`, container names,
     * tunnel URLs). A deployment that must restrict where BrinnPay may connect
     * sets one of them; the allowlist wins when both are set.
     */
    destinations: {
      /** Exact hosts permitted; empty means "no allowlist". */
      allowlist: readonly string[];
      /** Exact hosts refused; empty means "no denylist". */
      denylist: readonly string[];
    };
  };
  /**
   * Request logging (phase 11 D5). Records are observability data whose loss on
   * a failed write is accepted (D3), so this section carries only the retention
   * window and the cleanup cadence — no endpoint thresholds or sampling rules.
   */
  requestLogging: {
    /** How long a persisted request log row survives, in days (D5). */
    retentionDays: number;
    /** How often the retention cleanup pass runs, in ms (D5). */
    cleanupIntervalMs: number;
  };
}

const DEFAULT_DATABASE_URL = 'postgresql://brinnpay:brinnpay@localhost:5432/brinnpay?schema=public';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

// Non-secret fallback used ONLY under test so suites run without a `.env`
// (CI injects a real secret via the environment).
const TEST_JWT_SECRET = 'brinnpay-test-only-secret-do-not-use-in-production';
const JWT_SECRET_MIN_LENGTH = 32;

// Registrations in tests share one account for some cases; rate-limit values
// are env-driven so tests and sandbox can tighten them (§12).
const DEFAULT_RATELIMIT_WINDOW_SECONDS = 900;
const DEFAULT_IP_LOGIN_REGISTER_MAX = 10;
const DEFAULT_ACCOUNT_LOGIN_REGISTER_MAX = 10;
const DEFAULT_IP_REFRESH_MAX = 60;
const DEFAULT_IP_READ_MAX = 100;

// Phase 7 simulation timing (phase 7 §4.6, D2): the payment state machine
// advances deterministically from `created_at` and these two delay constants.
// Env-driven so tests run with near-zero delays (deterministic, fast CI).
const DEFAULT_PAYMENT_PENDING_DELAY_MS = 1_000;
const DEFAULT_PAYMENT_SETTLEMENT_DELAY_MS = 2_000;

// Phase 8 idempotency retention (ADR-0004): 24 hours is the single constant
// shared by storage and the API documentation. Expressed in hours because the
// documented window is; the capability converts it to milliseconds.
const DEFAULT_IDEMPOTENCY_RETENTION_HOURS = 24;

// Phase 10 webhook delivery defaults (D5/D9). All env-driven so tests run with
// near-zero delays and a short retention window (deterministic CI) and the
// sandbox can shorten the schedule.
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
const DEFAULT_WEBHOOK_BASE_BACKOFF_MS = 30_000;
const DEFAULT_WEBHOOK_MAX_BACKOFF_MS = 3_600_000; // 1 hour
const DEFAULT_WEBHOOK_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_EVENT_RETENTION_DAYS = 30;
const DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_WEBHOOK_RECONCILIATION_HORIZON_MS = 3_600_000; // 1 hour
const DEFAULT_WEBHOOK_FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_WEBHOOK_RETAINED_FAILED_JOBS = 1_000;
const DEFAULT_WEBHOOK_ADVANCEMENT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_WEBHOOK_CLEANUP_INTERVAL_MS = 3_600_000;

// Phase 11 request-log retention (D5): aligned with webhook event retention
// (phase 10 D9) so an operator configures one window for both observability
// stores. The cleanup interval is separate because the request-log pass runs on
// its own schedule, not the webhook sweep's.
const DEFAULT_REQUEST_LOG_RETENTION_DAYS = 30;
const DEFAULT_REQUEST_LOG_CLEANUP_INTERVAL_MS = 3_600_000;
// Ceilings on the two knobs: an unrealistic value must fail at boot instead of
// silently disabling cleanup. An out-of-range cutoff date makes the deletion
// query throw on every pass, which is logged and skipped — retention would then
// never delete anything while looking configured.
const MAX_REQUEST_LOG_RETENTION_DAYS = 3650;
const MAX_REQUEST_LOG_CLEANUP_INTERVAL_MS = 86_400_000;

/**
 * Ceiling on the retry ladder (D5). The ladder tops out at an hour of backoff
 * between attempts, so anything past this is not a delivery policy — it is an
 * unbounded number of outbound requests against a destination that is already
 * failing. Bounded at boot rather than clamped at runtime so the mistake is
 * visible immediately.
 */
const MAX_WEBHOOK_MAX_ATTEMPTS = 20;

function parsePort(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? Number(fallback) : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }
  return value;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin');
  }

  return origins;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (received "${raw}")`);
  }
  return value;
}

/**
 * A positive integer with an explicit ceiling, so a configuration mistake fails
 * at boot instead of becoming runtime behavior. Used for the retry ladder
 * (`WEBHOOK_MAX_ATTEMPTS`): an unbounded value turns a typo into a retry storm
 * against a failing destination, which is a self-inflicted outbound denial of
 * service rather than a safe default.
 */
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const value = parsePositiveInt(raw, fallback, name);
  if (value > max) {
    throw new Error(`${name} must be at most ${max} (received "${raw}")`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`${name} must be "true" or "false" (received "${raw}")`);
}

function resolveJwtSecret(nodeEnv: string): { secret: string; accessTokenTtlSeconds: number } {
  const secret = process.env.JWT_SECRET;
  if (nodeEnv === 'test') {
    // Tests run without secrets; a documented default keeps local suites green.
    if (secret !== undefined && secret !== '') {
      return {
        secret,
        accessTokenTtlSeconds: parsePositiveInt(
          process.env.ACCESS_TOKEN_TTL_SECONDS,
          900,
          'ACCESS_TOKEN_TTL_SECONDS',
        ),
      };
    }
    return {
      secret: TEST_JWT_SECRET,
      accessTokenTtlSeconds: parsePositiveInt(
        process.env.ACCESS_TOKEN_TTL_SECONDS,
        900,
        'ACCESS_TOKEN_TTL_SECONDS',
      ),
    };
  }

  if (secret === undefined || secret === '') {
    throw new Error(
      'JWT_SECRET is required. Generate a strong random value (e.g. `openssl rand -base64 48`) and set it in the environment.',
    );
  }
  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters long.`);
  }

  return {
    secret,
    accessTokenTtlSeconds: parsePositiveInt(
      process.env.ACCESS_TOKEN_TTL_SECONDS,
      900,
      'ACCESS_TOKEN_TTL_SECONDS',
    ),
  };
}

/**
 * Environment-driven configuration. Defaults match `apps/api/.env.example` and
 * the local Docker Compose services (D7). No secrets are set here; the JWT
 * signing secret is validated at boot so a weak/absent secret fails fast
 * (phase 3 §7.7).
 */
export function loadConfiguration(): BrinnPayConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  return {
    nodeEnv,
    port: parsePort(process.env.PORT, 3000),
    serviceName: process.env.SERVICE_NAME ?? 'brinnpay-api',
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    redisUrl: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    openapiPath: process.env.OPENAPI_PATH ?? '../../docs/openapi.yaml',
    swaggerPath: process.env.SWAGGER_PATH ?? 'docs',
    jwt: resolveJwtSecret(nodeEnv),
    auth: {
      cookieName: process.env.AUTH_COOKIE_NAME ?? 'brinnpay_refresh',
      cookieSecure: parseBoolean(
        process.env.COOKIE_SECURE,
        nodeEnv === 'production',
        'COOKIE_SECURE',
      ),
      cookieSameSite: (process.env.COOKIE_SAME_SITE ?? 'lax') === 'strict' ? 'strict' : 'lax',
      refreshSessionTtlDays: parsePositiveInt(
        process.env.REFRESH_SESSION_TTL_DAYS,
        30,
        'REFRESH_SESSION_TTL_DAYS',
      ),
      rateLimits: {
        windowSeconds: parsePositiveInt(
          process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
          DEFAULT_RATELIMIT_WINDOW_SECONDS,
          'AUTH_RATE_LIMIT_WINDOW_SECONDS',
        ),
        ipLoginRegisterMax: parsePositiveInt(
          process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX,
          DEFAULT_IP_LOGIN_REGISTER_MAX,
          'AUTH_RATE_LIMIT_IP_LOGIN_MAX',
        ),
        accountLoginRegisterMax: parsePositiveInt(
          process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX,
          DEFAULT_ACCOUNT_LOGIN_REGISTER_MAX,
          'AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX',
        ),
        ipRefreshMax: parsePositiveInt(
          process.env.AUTH_RATE_LIMIT_IP_REFRESH_MAX,
          DEFAULT_IP_REFRESH_MAX,
          'AUTH_RATE_LIMIT_IP_REFRESH_MAX',
        ),
        ipReadMax: parsePositiveInt(
          process.env.AUTH_RATE_LIMIT_IP_READ_MAX,
          DEFAULT_IP_READ_MAX,
          'AUTH_RATE_LIMIT_IP_READ_MAX',
        ),
      },
    },
    payments: {
      pendingDelayMs: parsePositiveInt(
        process.env.PAYMENT_PENDING_DELAY_MS,
        DEFAULT_PAYMENT_PENDING_DELAY_MS,
        'PAYMENT_PENDING_DELAY_MS',
      ),
      settlementDelayMs: parsePositiveInt(
        process.env.PAYMENT_SETTLEMENT_DELAY_MS,
        DEFAULT_PAYMENT_SETTLEMENT_DELAY_MS,
        'PAYMENT_SETTLEMENT_DELAY_MS',
      ),
    },
    idempotency: {
      retentionHours: parsePositiveInt(
        process.env.IDEMPOTENCY_RETENTION_HOURS,
        DEFAULT_IDEMPOTENCY_RETENTION_HOURS,
        'IDEMPOTENCY_RETENTION_HOURS',
      ),
    },
    webhooks: {
      secretEncryptionKey: resolveWebhookEncryptionKey(
        process.env.WEBHOOK_ENCRYPTION_KEY,
        // The test fallback key is committed to this repository, so it is only
        // safe where nothing can be stored: see `resolveWebhookEncryptionKey`.
        // The opt-in is refused once a database is in play, because the
        // connection string falls back to a hardcoded localhost default — "no
        // DATABASE_URL exported" is not "no database".
        process.env.WEBHOOK_ALLOW_INSECURE_TEST_KEY === 'true' &&
          (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === ''),
      ),
      maxAttempts: parseBoundedInt(
        process.env.WEBHOOK_MAX_ATTEMPTS,
        DEFAULT_WEBHOOK_MAX_ATTEMPTS,
        MAX_WEBHOOK_MAX_ATTEMPTS,
        'WEBHOOK_MAX_ATTEMPTS',
      ),
      baseBackoffMs: parsePositiveInt(
        process.env.WEBHOOK_BASE_BACKOFF_MS,
        DEFAULT_WEBHOOK_BASE_BACKOFF_MS,
        'WEBHOOK_BASE_BACKOFF_MS',
      ),
      maxBackoffMs: parsePositiveInt(
        process.env.WEBHOOK_MAX_BACKOFF_MS,
        DEFAULT_WEBHOOK_MAX_BACKOFF_MS,
        'WEBHOOK_MAX_BACKOFF_MS',
      ),
      connectTimeoutMs: parsePositiveInt(
        process.env.WEBHOOK_CONNECT_TIMEOUT_MS,
        DEFAULT_WEBHOOK_CONNECT_TIMEOUT_MS,
        'WEBHOOK_CONNECT_TIMEOUT_MS',
      ),
      requestTimeoutMs: parsePositiveInt(
        process.env.WEBHOOK_REQUEST_TIMEOUT_MS,
        DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
        'WEBHOOK_REQUEST_TIMEOUT_MS',
      ),
      eventRetentionDays: parsePositiveInt(
        process.env.WEBHOOK_EVENT_RETENTION_DAYS,
        DEFAULT_WEBHOOK_EVENT_RETENTION_DAYS,
        'WEBHOOK_EVENT_RETENTION_DAYS',
      ),
      reconciliationIntervalMs: parsePositiveInt(
        process.env.WEBHOOK_RECONCILIATION_INTERVAL_MS,
        DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS,
        'WEBHOOK_RECONCILIATION_INTERVAL_MS',
      ),
      reconciliationHorizonMs: parsePositiveInt(
        process.env.WEBHOOK_RECONCILIATION_HORIZON_MS,
        DEFAULT_WEBHOOK_RECONCILIATION_HORIZON_MS,
        'WEBHOOK_RECONCILIATION_HORIZON_MS',
      ),
      failedJobRetentionMs: parsePositiveInt(
        process.env.WEBHOOK_FAILED_JOB_RETENTION_MS,
        DEFAULT_WEBHOOK_FAILED_JOB_RETENTION_MS,
        'WEBHOOK_FAILED_JOB_RETENTION_MS',
      ),
      retainedFailedJobs: parsePositiveInt(
        process.env.WEBHOOK_RETAINED_FAILED_JOBS,
        DEFAULT_WEBHOOK_RETAINED_FAILED_JOBS,
        'WEBHOOK_RETAINED_FAILED_JOBS',
      ),
      advancementSweepIntervalMs: parsePositiveInt(
        process.env.WEBHOOK_ADVANCEMENT_SWEEP_INTERVAL_MS,
        DEFAULT_WEBHOOK_ADVANCEMENT_SWEEP_INTERVAL_MS,
        'WEBHOOK_ADVANCEMENT_SWEEP_INTERVAL_MS',
      ),
      cleanupIntervalMs: parsePositiveInt(
        process.env.WEBHOOK_CLEANUP_INTERVAL_MS,
        DEFAULT_WEBHOOK_CLEANUP_INTERVAL_MS,
        'WEBHOOK_CLEANUP_INTERVAL_MS',
      ),
      destinations: {
        allowlist: parseHostList(process.env.WEBHOOK_DESTINATION_ALLOWLIST),
        denylist: parseHostList(process.env.WEBHOOK_DESTINATION_DENYLIST),
      },
    },
    requestLogging: {
      retentionDays: parseBoundedInt(
        process.env.REQUEST_LOG_RETENTION_DAYS,
        DEFAULT_REQUEST_LOG_RETENTION_DAYS,
        MAX_REQUEST_LOG_RETENTION_DAYS,
        'REQUEST_LOG_RETENTION_DAYS',
      ),
      cleanupIntervalMs: parseBoundedInt(
        process.env.REQUEST_LOG_CLEANUP_INTERVAL_MS,
        DEFAULT_REQUEST_LOG_CLEANUP_INTERVAL_MS,
        MAX_REQUEST_LOG_CLEANUP_INTERVAL_MS,
        'REQUEST_LOG_CLEANUP_INTERVAL_MS',
      ),
    },
  };
}

/**
 * Parses a comma-separated host list.
 *
 * Entries go through {@link canonicalizeWebhookHost} so a configured host is
 * stored in the same form a parsed URL produces. Without it an operator writing
 * `::1` or `localhost.` would configure an entry that can never match the URL
 * form `http://[::1]/` or `http://localhost./` — a denylist that silently fails
 * to deny the host it names, in the one direction that matters.
 */
function parseHostList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map(canonicalizeWebhookHost)
    .filter((entry) => entry.length > 0);
}

export default loadConfiguration;