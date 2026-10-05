import { BlockList, isIP } from 'node:net';

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
  /**
   * Rate limiting (phase 13 §5/§6.2). Every number is a configured value so
   * tests, the sandbox, staging and production can differ without a rebuild
   * (D6). The `auth.*` classes keep their Phase 3 values in `auth.rateLimits`
   * under their unchanged `AUTH_RATE_LIMIT_*` names (D9) — this section only
   * owns what did not exist before. No secret is involved: rate-limit
   * configuration is non-secret operational tuning.
   */
  rateLimit: {
    /** Window shared by the generic `read` and `write` classes (§6.2). */
    windowSeconds: number;
    /** Per-IP budget of the `read` class. */
    readMax: number;
    /** Per-IP and per-API-key budget of the `write` class. */
    writeMax: number;
    webhookReplay: {
      max: number;
      windowSeconds: number;
    };
    webhookEndpointCreate: {
      max: number;
      windowSeconds: number;
    };
    /**
     * Redis-unavailability posture (D8): `open` degrades enforcement to a
     * bounded in-process store (a sandbox must not trade availability for
     * enforcement), `closed` rejects with 429 instead. Either way a Redis error
     * never becomes a 5xx and never fails readiness.
     */
    failMode: RateLimitFailMode;
    /**
     * Proxy trust (D1). `0` means "the socket peer is the client": forwarded
     * headers are then ignored for limit purposes. A deployment behind a load
     * balancer sets an explicit bounded trust here — a CIDR allowlist with
     * {@link trustedProxyCidrs}, plus a hop count bounding how much of the chain
     * is read. Boot refuses a hop count without an allowlist, because a hop
     * count bounds how much of the chain is read, never who wrote it.
     */
    trustedProxyHops: number;
    /** CIDR allowlist of proxies whose forwarded headers may be honored. */
    trustedProxyCidrs: readonly string[];
  };
}

export type RateLimitFailMode = 'open' | 'closed';

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

// Phase 13 rate-limit defaults (D6): the confirmed sandbox numbers of §6.2.
// Generous by design — a sandbox whose own developer cannot run a
// payment/retry/replay loop is not usable. Raising one is an environment
// change, never a code change.
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_READ_MAX = 600;
const DEFAULT_RATE_LIMIT_WRITE_MAX = 120;
const DEFAULT_RATE_LIMIT_WEBHOOK_REPLAY_MAX = 20;
const DEFAULT_RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX = 10;
const DEFAULT_RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS = 3600;

/**
 * Ceiling on the trusted proxy hop count (D1/§8). The chain length read out of
 * `X-Forwarded-For` is attacker-influenced input: an unbounded hop count is how
 * a forged header chain becomes a forged client identity, so a value past this
 * fails at boot instead of silently trusting an arbitrary chain.
 */
const MAX_TRUST_PROXY_HOPS = 10;

/**
 * Floor on a trusted proxy entry's prefix length (D1). A private range is at
 * most a /8 in IPv4 (`10.0.0.0/8`), so anything shorter — `0.0.0.0/0` above
 * all — trusts publicly routable space instead of a fleet of proxies, which is
 * the same failure as trusting nothing at all.
 *
 * An IPv6 entry needs a much stricter floor than its IPv4 equivalent: an IPv6
 * block is 4 billion times larger per prefix bit, so `::/8` and `2000::/8` are
 * the whole routing table, not a fleet. `/32` is a site allocation — a proxy
 * tier is narrower still (`fd00:1234::/48`, a `/64`, or a `/128` per address).
 */
const MIN_TRUSTED_PROXY_PREFIX = 8;
const MIN_TRUSTED_PROXY_PREFIX_V6 = 32;

/**
 * The IPv4-mapped IPv6 range (`::ffff:0:0/96`): every IPv4 address spelled as
 * IPv6. An entry there is an IPv4 range in disguise, so it has to satisfy the
 * IPv4 floor too — `::ffff:0:0/96` is `0.0.0.0/0` in another notation and would
 * put every IPv4 peer behind the proxy gate.
 */
const IPV4_MAPPED_PREFIX = 96;
const IPV4_MAPPED_START = '::ffff:0.0.0.0';

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

/**
 * A non-negative integer with a ceiling. Used for the trusted proxy hop count
 * (D1), where `0` is the meaningful "trust nothing forwarded" value and the
 * ceiling keeps an attacker-influenced chain length bounded (§8).
 */
function parseBoundedNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (received "${raw}")`);
  }
  if (value > max) {
    throw new Error(`${name} must be at most ${max} (received "${raw}")`);
  }
  return value;
}

/** Phase 13 D8: the Redis-unavailability posture is a closed enum, not a boolean. */
function parseRateLimitFailMode(raw: string | undefined): RateLimitFailMode {
  if (raw === undefined || raw === '') {
    return 'open';
  }
  if (raw === 'open' || raw === 'closed') {
    return raw;
  }
  throw new Error(`RATE_LIMIT_FAIL_MODE must be "open" or "closed" (received "${raw}")`);
}

/**
 * Validates the trusted proxy allowlist at boot (D1). A malformed CIDR would
 * otherwise become an allowlist entry that can never match — a proxy whose
 * headers are silently ignored while the deployment believes they are trusted.
 * A bare address is normalized to its single-host form (`/32`, `/128`).
 *
 * A prefix shorter than the family floor ({@link MIN_TRUSTED_PROXY_PREFIX} for
 * IPv4, {@link MIN_TRUSTED_PROXY_PREFIX_V6} for IPv6) is refused as well: an
 * entry that trusts the whole internet is not a list of proxies, and it would
 * neutralize the model exactly as trusting nothing forwarded would. IPv6
 * entries covering the IPv4-mapped range are held to the IPv4 floor too.
 */
function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.lastIndexOf('/');
      const address = separator === -1 ? entry : entry.slice(0, separator);
      const version = isIP(address);
      if (!version) {
        throw new Error(`TRUST_PROXY_CIDRS entry "${entry}" is not a valid CIDR address`);
      }
      if (separator === -1) {
        return `${address}/${version === 4 ? 32 : 128}`;
      }
      const prefix = Number(entry.slice(separator + 1));
      const maximum = version === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
        throw new Error(
          `TRUST_PROXY_CIDRS entry "${entry}" must use a prefix length between 0 and ${maximum}`,
        );
      }
      const floor = version === 4 ? MIN_TRUSTED_PROXY_PREFIX : MIN_TRUSTED_PROXY_PREFIX_V6;
      if (prefix < floor) {
        throw new Error(
          `TRUST_PROXY_CIDRS entry "${entry}" must not be shorter than /${floor}: ` +
            'a broader entry trusts the whole internet instead of a list of proxies',
        );
      }
      if (version === 6) {
        assertNarrowerThanIpv4Space(entry, address, prefix);
      }
      return `${address}/${prefix}`;
    });
}

/**
 * Guards an IPv6 entry that includes IPv4-mapped addresses, whose implied IPv4
 * range has to satisfy the IPv4 floor. Membership is delegated to
 * `net.BlockList` rather than hand-written bit arithmetic: this check decides
 * who may speak for a client, and a subtle prefix bug here is an identity bug.
 *
 * The entry covers the mapped space either *partly* (its addresses sit inside
 * `::ffff:0:0/96`, so it implies the IPv4 block `prefix - 96`) or *wholly*
 * (a shorter prefix whose range reaches in, implying all of IPv4).
 */
function assertNarrowerThanIpv4Space(entry: string, address: string, prefix: number): void {
  if (prefix >= IPV4_MAPPED_PREFIX) {
    const mapped = new BlockList();
    mapped.addSubnet('::ffff:0:0', IPV4_MAPPED_PREFIX, 'ipv6');
    if (mapped.check(address, 'ipv6') && prefix - IPV4_MAPPED_PREFIX < MIN_TRUSTED_PROXY_PREFIX) {
      throw new Error(
        `TRUST_PROXY_CIDRS entry "${entry}" is an IPv4 range spelled as IPv6: its ` +
          `implied IPv4 prefix /${prefix - IPV4_MAPPED_PREFIX} must be at least /${MIN_TRUSTED_PROXY_PREFIX}`,
      );
    }
    return;
  }
  const candidate = new BlockList();
  candidate.addSubnet(address, prefix, 'ipv6');
  if (candidate.check(IPV4_MAPPED_START, 'ipv6')) {
    throw new Error(
      `TRUST_PROXY_CIDRS entry "${entry}" spans the IPv4-mapped range ` +
        `${IPV4_MAPPED_START}/${IPV4_MAPPED_PREFIX}: it would trust every IPv4 peer`,
    );
  }
}

/**
 * The rate-limit policy section (phase 13 §5/§6.2), parsed and validated as one
 * unit because its two proxy-trust values constrain each other: a hop count is
 * only meaningful with an allowlist saying *which* proxies may speak for a client.
 */
function loadRateLimitConfiguration(): BrinnPayConfig['rateLimit'] {
  const trustedProxyHops = parseBoundedNonNegativeInt(
    process.env.TRUST_PROXY_HOPS,
    0,
    MAX_TRUST_PROXY_HOPS,
    'TRUST_PROXY_HOPS',
  );
  const trustedProxyCidrs = parseTrustedProxyCidrs(process.env.TRUST_PROXY_CIDRS);

  if (trustedProxyHops > 0 && trustedProxyCidrs.length === 0) {
    // `X-Forwarded-For` is written by the client as far as any deployment that
    // reaches this process directly is concerned, so a hop count on its own would
    // let the caller name its own rate-limit identity and mint a fresh budget per
    // request — defeating every class, including the credential-stuffing one.
    throw new Error(
      'TRUST_PROXY_CIDRS is required when TRUST_PROXY_HOPS is greater than 0. A hop count bounds ' +
        'how much of the forwarded chain is read; only the allowlist decides who may write it. ' +
        'Either set TRUST_PROXY_HOPS=0 (forwarded headers ignored, direct socket peer used) or ' +
        'list the proxies that may speak for a client.',
    );
  }

  return {
    windowSeconds: parsePositiveInt(
      process.env.RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
      'RATE_LIMIT_WINDOW_SECONDS',
    ),
    readMax: parsePositiveInt(
      process.env.RATE_LIMIT_READ_MAX,
      DEFAULT_RATE_LIMIT_READ_MAX,
      'RATE_LIMIT_READ_MAX',
    ),
    writeMax: parsePositiveInt(
      process.env.RATE_LIMIT_WRITE_MAX,
      DEFAULT_RATE_LIMIT_WRITE_MAX,
      'RATE_LIMIT_WRITE_MAX',
    ),
    webhookReplay: {
      max: parsePositiveInt(
        process.env.RATE_LIMIT_WEBHOOK_REPLAY_MAX,
        DEFAULT_RATE_LIMIT_WEBHOOK_REPLAY_MAX,
        'RATE_LIMIT_WEBHOOK_REPLAY_MAX',
      ),
      windowSeconds: parsePositiveInt(
        process.env.RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS,
        DEFAULT_RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS,
        'RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS',
      ),
    },
    webhookEndpointCreate: {
      max: parsePositiveInt(
        process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX,
        DEFAULT_RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX,
        'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX',
      ),
      windowSeconds: parsePositiveInt(
        process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS,
        DEFAULT_RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS,
        'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS',
      ),
    },
    failMode: parseRateLimitFailMode(process.env.RATE_LIMIT_FAIL_MODE),
    trustedProxyHops,
    trustedProxyCidrs,
  };
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
    rateLimit: loadRateLimitConfiguration(),
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