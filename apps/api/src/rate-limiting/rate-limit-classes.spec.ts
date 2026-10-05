import type { BrinnPayConfig } from '../config/configuration';
import {
  buildRateLimitPolicy,
  isRateLimitClass,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPES,
  scopesForClass,
} from './rate-limit-classes';

/**
 * The class catalog is the endpoint-specific policy (phase 13 §4.2 rule 2, D6),
 * so its shape and its numbers are asserted here rather than spread across the
 * guards that consume it.
 */
describe('rate limit class catalog (phase 13 §4.2, D6)', () => {
  const config = {
    auth: {
      rateLimits: {
        windowSeconds: 900,
        ipLoginRegisterMax: 10,
        accountLoginRegisterMax: 10,
        ipRefreshMax: 60,
        ipReadMax: 100,
      },
    },
    rateLimit: {
      windowSeconds: 60,
      readMax: 600,
      writeMax: 120,
      webhookReplay: { max: 20, windowSeconds: 300 },
      webhookEndpointCreate: { max: 10, windowSeconds: 3600 },
    },
  } as unknown as Pick<BrinnPayConfig, 'auth' | 'rateLimit'>;

  it('exposes exactly the seven confirmed classes', () => {
    expect([...RATE_LIMIT_CLASSES]).toEqual([
      'auth.session-creation',
      'auth.refresh',
      'auth.read',
      'read',
      'write',
      'webhook.replay',
      'webhook.endpoint-create',
    ]);
    expect([...RATE_LIMIT_SCOPES]).toEqual(['ip', 'api_key', 'account']);
  });

  it.each([...RATE_LIMIT_CLASSES])('resolves a budget for every class (%s)', (routeClass) => {
    const buckets = buildRateLimitPolicy(config)[routeClass];
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      expect(Number.isInteger(bucket.limit)).toBe(true);
      expect(bucket.limit).toBeGreaterThan(0);
      expect(Number.isInteger(bucket.windowSeconds)).toBe(true);
      expect(bucket.windowSeconds).toBeGreaterThan(0);
      expect(RATE_LIMIT_SCOPES).toContain(bucket.scope);
    }
  });

  it('keeps the Phase 3 auth classes on the unchanged AUTH_RATE_LIMIT_* values (D9)', () => {
    const policy = buildRateLimitPolicy(config);

    // Phase 3 numbers, unchanged: 10/10/60/100 over a 900 s window.
    expect(policy['auth.session-creation']).toEqual([
      { scope: 'ip', limit: 10, windowSeconds: 900 },
      { scope: 'account', limit: 10, windowSeconds: 900 },
    ]);
    expect(policy['auth.refresh']).toEqual([{ scope: 'ip', limit: 60, windowSeconds: 900 }]);
    expect(policy['auth.read']).toEqual([{ scope: 'ip', limit: 100, windowSeconds: 900 }]);
  });

  it('honours overridden legacy auth values, so a deployment is not re-tuned', () => {
    const overridden = {
      ...config,
      auth: {
        rateLimits: {
          ...config.auth.rateLimits,
          ipLoginRegisterMax: 3,
          accountLoginRegisterMax: 4,
        },
      },
    } as unknown as Pick<BrinnPayConfig, 'auth' | 'rateLimit'>;

    const policy = buildRateLimitPolicy(overridden);
    expect(policy['auth.session-creation']).toEqual([
      { scope: 'ip', limit: 3, windowSeconds: 900 },
      { scope: 'account', limit: 4, windowSeconds: 900 },
    ]);
  });

  it('scopes ip everywhere, api_key only on mutations, account only on session creation (D5/D10)', () => {
    for (const routeClass of RATE_LIMIT_CLASSES) {
      const scopes = scopesForClass(routeClass);
      expect(scopes).toContain('ip');
    }

    expect(scopesForClass('read')).toEqual(['ip']);
    expect(scopesForClass('auth.refresh')).toEqual(['ip']);
    expect(scopesForClass('auth.read')).toEqual(['ip']);
    expect(scopesForClass('write')).toEqual(['ip', 'api_key']);
    expect(scopesForClass('webhook.replay')).toEqual(['ip', 'api_key']);
    expect(scopesForClass('webhook.endpoint-create')).toEqual(['ip', 'api_key']);
    expect(scopesForClass('auth.session-creation')).toEqual(['ip', 'account']);

    // There is no session-user and no organization dimension (D5).
    const allScopes = RATE_LIMIT_CLASSES.flatMap((routeClass) => [...scopesForClass(routeClass)]);
    expect([...new Set(allScopes)].sort()).toEqual(['account', 'api_key', 'ip']);
  });

  it('maps the confirmed §6.2 numbers onto the generic classes', () => {
    const policy = buildRateLimitPolicy(config);

    expect(policy.read).toEqual([{ scope: 'ip', limit: 600, windowSeconds: 60 }]);
    expect(policy.write).toEqual([
      { scope: 'ip', limit: 120, windowSeconds: 60 },
      { scope: 'api_key', limit: 120, windowSeconds: 60 },
    ]);
    expect(policy['webhook.replay']).toEqual([
      { scope: 'ip', limit: 20, windowSeconds: 300 },
      { scope: 'api_key', limit: 20, windowSeconds: 300 },
    ]);
    expect(policy['webhook.endpoint-create']).toEqual([
      { scope: 'ip', limit: 10, windowSeconds: 3600 },
      { scope: 'api_key', limit: 10, windowSeconds: 3600 },
    ]);
  });

  it('orders buckets so the D4 tie-break is deterministic', () => {
    const policy = buildRateLimitPolicy(config);
    // `ip` first, then the second dimension: on equal remaining units the ip
    // bucket is the reported one, every time.
    expect(policy.write.map((bucket) => bucket.scope)).toEqual(['ip', 'api_key']);
    expect(policy['auth.session-creation'].map((bucket) => bucket.scope)).toEqual(['ip', 'account']);
  });

  it('rejects anything outside the closed catalog', () => {
    expect(isRateLimitClass('write')).toBe(true);
    expect(isRateLimitClass('admin.write')).toBe(false);
    expect(isRateLimitClass('auth.none')).toBe(false);
    expect(isRateLimitClass(undefined)).toBe(false);
    expect(isRateLimitClass(7)).toBe(false);
  });
});