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
  };
}

export default loadConfiguration;
