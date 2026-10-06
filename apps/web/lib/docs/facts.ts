/**
 * Published shared facts (phase 15 §9.2 / D8).
 *
 * The small set of numeric and behavioral facts that appear both in the
 * canonical artifacts (`docs/api-conventions.md`, `docs/openapi.yaml`, the
 * API's error-code constant) and in the published guides is declared once here
 * and rendered by the guides. The consistency tests compare this module with
 * its canonical sources, so a drift on either side fails the suite instead of
 * silently publishing a wrong number.
 *
 * Nothing in this module is secret: every value is public documentation.
 */

/** Base error codes (`apps/api` `ErrorCode`, phase 1 §7.6). */
export const BASE_ERROR_CODES: readonly string[] = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'BUSINESS_RULE_VIOLATION',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
];

/** Idempotency retention window (ADR-0004, `api-conventions.md` §4). */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** Idempotency key length bounds (`openapi.yaml` `Idempotency-Key`). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** Operation scopes that accept an `Idempotency-Key`. */
export const IDEMPOTENCY_OPERATION_SCOPES: readonly string[] = [
  'payments.create',
  'refunds.create',
];

/** Total delivery attempts per webhook event (retryable failures). */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff with full jitter, in seconds, as published:
 * approximately 0 s, 30 s, 2 min, 10 min, 1 h (capped).
 */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS: readonly number[] = [0, 30, 120, 600, 3600];

/** Retryable HTTP statuses for webhook delivery attempts. */
export const WEBHOOK_RETRYABLE_STATUSES: readonly string[] = ['408', '425', '429', '5xx'];

/** Webhook event retention in days (cleanup removes older events). */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/** Request-log retention in days. */
export const REQUEST_LOG_RETENTION_DAYS = 30;

/** Signature header and value scheme (`openapi.yaml` delivery description). */
export const WEBHOOK_SIGNATURE_HEADER = 'BrinnPay-Signature';
export const WEBHOOK_SIGNATURE_SCHEME = 't=<unix-seconds>,v1=<lowercase-hex>';
export const WEBHOOK_SIGNED_MESSAGE = '${t}.${rawBody}';

/** Closed webhook event catalog. */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  'payment.created',
  'payment.succeeded',
  'payment.failed',
  'refund.created',
];

/**
 * Rate-limit operation classes with the sandbox default numbers
 * (`docs/api-conventions.md` §10.2, published as §5.11 of the guide inventory;
 * the same table appears in `docs/openapi.yaml` `info.description`).
 */
export interface RateLimitClass {
  /** Class name. */
  name: string;
  /** Operations that belong to the class, as written in the canonical table. */
  operations: string;
  /** Requests allowed per window. */
  limit: number;
  /** Fixed window length in seconds. */
  windowSeconds: number;
  /** Budget scopes charged, in catalog order. */
  scopes: readonly string[];
}

export const RATE_LIMIT_CLASSES: readonly RateLimitClass[] = [
  {
    name: 'auth.session-creation',
    operations: 'POST /auth/register, POST /auth/login',
    limit: 10,
    windowSeconds: 900,
    scopes: ['ip', 'account'],
  },
  {
    name: 'auth.refresh',
    operations: 'POST /auth/refresh, POST /auth/logout',
    limit: 60,
    windowSeconds: 900,
    scopes: ['ip'],
  },
  {
    name: 'auth.read',
    operations: 'GET /auth/me',
    limit: 100,
    windowSeconds: 900,
    scopes: ['ip'],
  },
  {
    name: 'read',
    operations: 'every other GET',
    limit: 600,
    windowSeconds: 60,
    scopes: ['ip'],
  },
  {
    name: 'write',
    operations: 'every other POST/PATCH/DELETE',
    limit: 120,
    windowSeconds: 60,
    scopes: ['ip', 'api_key'],
  },
  {
    name: 'webhook.replay',
    operations:
      'POST /projects/{project_id}/webhook-endpoints/{endpoint_id}/events/{event_id}/replay',
    limit: 20,
    windowSeconds: 300,
    scopes: ['ip', 'api_key'],
  },
  {
    name: 'webhook.endpoint-create',
    operations: 'POST /projects/{project_id}/webhook-endpoints',
    limit: 10,
    windowSeconds: 3600,
    scopes: ['ip', 'api_key'],
  },
];

/** Rate-limit budget scopes (the closed dimension catalog). */
export const RATE_LIMIT_SCOPES: readonly { scope: string; discriminator: string; appliesTo: string }[] =
  [
    {
      scope: 'ip',
      discriminator: 'Normalized client identity',
      appliesTo: 'Every request under the prefix',
    },
    {
      scope: 'api_key',
      discriminator: "The resolved API key's id (never the presented plaintext)",
      appliesTo: "API-key-authenticated operations of a class that declares it",
    },
    {
      scope: 'account',
      discriminator: 'Normalized account email',
      appliesTo: 'POST /auth/register, POST /auth/login',
    },
  ];

/**
 * Rate-limit response headers (`api-conventions.md` §10.4), including the
 * canonical `On` column so the guide cannot drop the `Retry-After`-only fact.
 */
export const RATE_LIMIT_HEADERS: readonly {
  header: string;
  on: string;
  meaning: string;
}[] = [
  {
    header: 'RateLimit-Limit',
    on: 'every response of a limited route',
    meaning: 'Limit of the reported budget',
  },
  {
    header: 'RateLimit-Remaining',
    on: 'every response',
    meaning: 'Units left in the current window',
  },
  {
    header: 'RateLimit-Reset',
    on: 'every response',
    meaning: 'Whole seconds until the window resets',
  },
  {
    header: 'Retry-After',
    on: '429 only',
    meaning: "Whole seconds until the reported budget's window resets",
  },
];
