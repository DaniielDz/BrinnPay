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
}

const DEFAULT_DATABASE_URL =
  'postgresql://brinnpay:brinnpay@localhost:5432/brinnpay?schema=public';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

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

/**
 * Environment-driven configuration. Defaults match `apps/api/.env.example` and
 * the local Docker Compose services (D7). No secrets are set here.
 */
export function loadConfiguration(): BrinnPayConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parsePort(process.env.PORT, 3000),
    serviceName: process.env.SERVICE_NAME ?? 'brinnpay-api',
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    redisUrl: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    openapiPath: process.env.OPENAPI_PATH ?? '../../docs/openapi.yaml',
    swaggerPath: process.env.SWAGGER_PATH ?? 'docs',
  };
}

export default loadConfiguration;
