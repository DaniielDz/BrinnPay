import type { BrinnPayConfig } from '../config/configuration';

/**
 * The route-class catalog and the policy it resolves to (phase 13 §4.2, D6).
 *
 * **The catalog is the endpoint-specific policy.** Every contracted operation
 * maps to exactly one class of this closed list; there is no per-operation limit
 * table and no ad hoc per-controller limit. Adding a class is an amendment to
 * this file (and to the phase specification), never a one-off.
 *
 * Domain modules declare a class and nothing else — never a limit, a window, a
 * Redis key or a header. All four come from {@link buildRateLimitPolicy}, which
 * reads configuration.
 */

/** The closed catalog of route classes (§4.2). */
export const RATE_LIMIT_CLASSES = [
  'auth.session-creation',
  'auth.refresh',
  'auth.read',
  'read',
  'write',
  'webhook.replay',
  'webhook.endpoint-create',
] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/**
 * The limit dimensions (scopes, §4.2 rule 1). There is no session-user and no
 * organization dimension (D5): a shared NAT egress would throttle unrelated
 * dashboard users, and credential guessing is already covered per account.
 */
export const RATE_LIMIT_SCOPES = ['ip', 'api_key', 'account'] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

/**
 * Which scopes apply to which class, **in order**. The order is the D4 tie-break
 * for the reported bucket: when two buckets are equally close to exhaustion the
 * earlier scope wins, so the reported budget is always deterministic.
 */
const CLASS_SCOPES: Record<RateLimitClass, readonly RateLimitScope[]> = {
  // Credential stuffing: already proven in phase 3, unchanged (D9/D10).
  'auth.session-creation': ['ip', 'account'],
  // Refresh/logout: the cookie-bound credential already limits abuse.
  'auth.refresh': ['ip'],
  'auth.read': ['ip'],
  // Deliberately generous: the dashboard paginates and Phase 19 load-tests it.
  read: ['ip'],
  // Mutations are the expensive, state-changing operations.
  write: ['ip', 'api_key'],
  // Replay is a deliberate outbound amplifier (D11).
  'webhook.replay': ['ip', 'api_key'],
  // Each endpoint adds an in-transaction fan-out row (D11).
  'webhook.endpoint-create': ['ip', 'api_key'],
};

/** One dimension's configured budget. */
export interface RateLimitBucketPolicy {
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The resolved catalog: every class with its buckets, in D4 tie-break order. */
export type RateLimitPolicy = {
  readonly [K in RateLimitClass]: readonly RateLimitBucketPolicy[];
};

export function isRateLimitClass(value: unknown): value is RateLimitClass {
  return typeof value === 'string' && (RATE_LIMIT_CLASSES as readonly string[]).includes(value);
}

/** The scopes a class applies, in D4 tie-break order. */
export function scopesForClass(routeClass: RateLimitClass): readonly RateLimitScope[] {
  return CLASS_SCOPES[routeClass];
}

/**
 * Resolves the whole catalog from configuration (§6.2).
 *
 * The `auth.*` classes read the **unchanged** Phase 3 `AUTH_RATE_LIMIT_*` values
 * (D9) — renaming them would break deployed configuration, which `AGENTS.md`
 * forbids without a specification change. Only the classes that did not exist
 * before this phase read the new `RATE_LIMIT_*` variables.
 */
export function buildRateLimitPolicy(
  config: Pick<BrinnPayConfig, 'auth' | 'rateLimit'>,
): RateLimitPolicy {
  const auth = config.auth.rateLimits;
  const rateLimit = config.rateLimit;

  return {
    'auth.session-creation': [
      { scope: 'ip', limit: auth.ipLoginRegisterMax, windowSeconds: auth.windowSeconds },
      {
        scope: 'account',
        limit: auth.accountLoginRegisterMax,
        windowSeconds: auth.windowSeconds,
      },
    ],
    'auth.refresh': [{ scope: 'ip', limit: auth.ipRefreshMax, windowSeconds: auth.windowSeconds }],
    'auth.read': [{ scope: 'ip', limit: auth.ipReadMax, windowSeconds: auth.windowSeconds }],
    read: [{ scope: 'ip', limit: rateLimit.readMax, windowSeconds: rateLimit.windowSeconds }],
    write: [
      { scope: 'ip', limit: rateLimit.writeMax, windowSeconds: rateLimit.windowSeconds },
      { scope: 'api_key', limit: rateLimit.writeMax, windowSeconds: rateLimit.windowSeconds },
    ],
    'webhook.replay': [
      {
        scope: 'ip',
        limit: rateLimit.webhookReplay.max,
        windowSeconds: rateLimit.webhookReplay.windowSeconds,
      },
      {
        scope: 'api_key',
        limit: rateLimit.webhookReplay.max,
        windowSeconds: rateLimit.webhookReplay.windowSeconds,
      },
    ],
    'webhook.endpoint-create': [
      {
        scope: 'ip',
        limit: rateLimit.webhookEndpointCreate.max,
        windowSeconds: rateLimit.webhookEndpointCreate.windowSeconds,
      },
      {
        scope: 'api_key',
        limit: rateLimit.webhookEndpointCreate.max,
        windowSeconds: rateLimit.webhookEndpointCreate.windowSeconds,
      },
    ],
  };
}