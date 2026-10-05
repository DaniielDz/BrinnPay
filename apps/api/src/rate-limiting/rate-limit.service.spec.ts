import { ConfigService } from '@nestjs/config';

import { ApiError } from '../common/errors/api-error';
import type { BrinnPayConfig } from '../config/configuration';
import type { RateLimitClass, RateLimitScope } from './rate-limit-classes';
import type { RateLimitCounterService } from './rate-limit-counter.service';
import { RATE_LIMIT_HEADERS, RateLimitService } from './rate-limit.service';

/**
 * Enforcement and reporting (phase 13 §4.2 rule 6, §4.4, D3/D4/D13): what is
 * counted, which budget is reported when several scopes apply, and what a
 * throttled caller is told.
 */
describe('RateLimitService (phase 13 §4.3/§4.4)', () => {
  const consumed: { scope: string; discriminator: string; routeClass: string; limit: number; window: number }[] =
    [];
  let counter: { consume: jest.Mock };

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
  } as unknown as BrinnPayConfig;

  function serviceFor(authLimits: Partial<BrinnPayConfig['auth']['rateLimits']> = {}): RateLimitService {
    const resolved = {
      ...config,
      auth: {
        ...config.auth,
        rateLimits: { ...config.auth.rateLimits, ...authLimits },
      },
    } as unknown as BrinnPayConfig;
    return new RateLimitService(
      { getOrThrow: (key: string) => (resolved as unknown as Record<string, unknown>)[key] } as unknown as ConfigService,
      counter as unknown as RateLimitCounterService,
    );
  }

  function responseDouble(): { setHeader: jest.Mock; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    };
  }

  beforeEach(() => {
    consumed.length = 0;
    counter = {
      consume: jest.fn(async (scope: string, discriminator: string, routeClass: string, limit: number, window: number) => {
        consumed.push({ scope, discriminator, routeClass, limit, window });
        return { allowed: true, remaining: limit - consumed.length, resetSeconds: 42 };
      }),
    };
  });

  it('consumes one unit of every staged scope, with the class budget', async () => {
    await serviceFor().enforce({}, responseDouble() as never, 'write', ['ip', 'api_key'], {
      ip: '203.0.113.7',
      api_key: 'key-id',
    });

    expect(consumed).toEqual([
      { scope: 'ip', discriminator: '203.0.113.7', routeClass: 'write', limit: 120, window: 60 },
      { scope: 'api_key', discriminator: 'key-id', routeClass: 'write', limit: 120, window: 60 },
    ]);
  });

  it('counts a request whatever its outcome, because counting precedes the outcome (D10)', async () => {
    // A 400/401/403/404/422/5xx and an idempotent replay all reach the limiter, so
    // the limiter cannot distinguish them: every attempt is one unit.
    for (const routeClass of ['read', 'write', 'webhook.replay'] as RateLimitClass[]) {
      await serviceFor().enforce({}, responseDouble() as never, routeClass, ['ip'], { ip: '203.0.113.7' });
    }
    expect(consumed).toHaveLength(3);
  });

  it('does not count a scope with no discriminator', async () => {
    await serviceFor().enforce({}, responseDouble() as never, 'auth.session-creation', ['account'], {
      account: undefined,
    });
    expect(consumed).toHaveLength(0);
  });

  it('reports the budget on an allowed response', async () => {
    const response = responseDouble();
    await serviceFor().enforce({}, response as never, 'read', ['ip'], { ip: '203.0.113.7' });

    expect(response.headers[RATE_LIMIT_HEADERS.limit]).toBe('600');
    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('599');
    expect(response.headers[RATE_LIMIT_HEADERS.reset]).toBe('42');
    // `Retry-After` is a 429-only header.
    expect(response.headers[RATE_LIMIT_HEADERS.retryAfter]).toBeUndefined();
  });

  it('reports the bucket closest to exhaustion when several scopes apply (D4)', async () => {
    counter.consume.mockImplementation(async (scope: string) => ({
      allowed: true,
      remaining: scope === 'ip' ? 5 : 1,
      resetSeconds: 30,
    }));
    const response = responseDouble();
    await serviceFor().enforce({}, response as never, 'write', ['ip', 'api_key'], {
      ip: '203.0.113.7',
      api_key: 'key-id',
    });

    // The api-key bucket is nearly exhausted, so that is what the developer is
    // told — never a comfortable ip budget on a request about to be rejected.
    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('1');
  });

  it('keeps the earlier stage when it is closer to exhaustion than the later one', async () => {
    counter.consume.mockImplementation(async (scope: string) => ({
      allowed: true,
      remaining: scope === 'ip' ? 0 : 119,
      resetSeconds: 30,
    }));
    const response = responseDouble();
    await serviceFor().enforce({}, response as never, 'write', ['ip', 'api_key'], {
      ip: '203.0.113.7',
      api_key: 'key-id',
    });

    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('0');
  });

  it('breaks a tie on the catalog scope order, not on the staging order', async () => {
    // `auth.session-creation` is the one class whose scopes can carry different
    // configured limits, so it is the only one where a tie is observable in the
    // reported `RateLimit-Limit`. Equal budgets would make this assertion vacuous,
    // which is why the ip and account limits here deliberately differ.
    counter.consume.mockResolvedValue({ allowed: true, remaining: 6, resetSeconds: 30 });

    const catalogOrder = responseDouble();
    const reversedOrder = responseDouble();
    const service = serviceFor({ ipLoginRegisterMax: 100, accountLoginRegisterMax: 7 });

    await service.enforce({}, catalogOrder as never, 'auth.session-creation', ['ip', 'account'], {
      ip: '203.0.113.7',
      account: 'someone@example.com',
    });
    await service.enforce(
      {},
      reversedOrder as never,
      'auth.session-creation',
      ['account', 'ip'],
      { account: 'someone@example.com', ip: '203.0.113.7' },
    );

    // `ip` is first in the catalog, so it is the reported bucket however the caller
    // happened to stage the two scopes: both answer 100, never the account 7.
    expect(catalogOrder.headers[RATE_LIMIT_HEADERS.limit]).toBe('100');
    expect(reversedOrder.headers[RATE_LIMIT_HEADERS.limit]).toBe('100');
  });

  it('lets the earlier scope keep a tie only when the limits are equal too', async () => {
    // Same remaining units and the same configured limit: reporting is still the
    // catalog's first scope, and nothing about the staging order changes that.
    counter.consume.mockResolvedValue({ allowed: true, remaining: 6, resetSeconds: 30 });
    const response = responseDouble();

    await serviceFor().enforce({}, response as never, 'write', ['api_key', 'ip'], {
      api_key: 'key-id',
      ip: '203.0.113.7',
    });

    expect(response.headers[RATE_LIMIT_HEADERS.limit]).toBe('120');
  });

  it('remembers the reported bucket across the two enforcement stages of one request', async () => {
    counter.consume.mockImplementation(async (scope: string) => ({
      allowed: true,
      remaining: scope === 'ip' ? 3 : 1,
      resetSeconds: 30,
    }));

    const request = {};
    const response = responseDouble();
    const service = serviceFor();
    await service.enforce(request, response as never, 'write', ['ip'], { ip: '203.0.113.7' });
    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('3');

    await service.enforce(request, response as never, 'write', ['api_key'], { api_key: 'key-id' });
    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('1');
  });

  it('raises the canonical 429 with budget-only details when a bucket is exhausted (AC6/D13)', async () => {
    counter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 17 });

    const error = (await serviceFor()
      .enforce({}, responseDouble() as never, 'webhook.replay', ['ip'], { ip: '203.0.113.7' })
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.getStatus()).toBe(429);
    expect(error.message).toBe('Too many requests');
    expect(error.details).toEqual({ limit: 20, remaining: 0, window_seconds: 300 });

    // No scope name, no class name, no discriminator, no Redis key.
    const dumped = JSON.stringify(error.details);
    expect(dumped).not.toContain('ip');
    expect(dumped).not.toContain('203.0.113.7');
    expect(dumped).not.toContain('webhook.replay');
    expect(dumped).not.toContain('brinnpay:rl');
  });

  it('reports the exhausted bucket and Retry-After on the rejected response (§4.4 point 2)', async () => {
    counter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 23 });
    const response = responseDouble();

    await serviceFor()
      .enforce({}, response as never, 'write', ['ip'], { ip: '203.0.113.7' })
      .catch(() => undefined);

    expect(response.headers[RATE_LIMIT_HEADERS.limit]).toBe('120');
    expect(response.headers[RATE_LIMIT_HEADERS.remaining]).toBe('0');
    expect(response.headers[RATE_LIMIT_HEADERS.reset]).toBe('23');
    expect(response.headers[RATE_LIMIT_HEADERS.retryAfter]).toBe('23');
  });

  it('keeps Retry-After a positive integer even when the window is expiring', async () => {
    counter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 1 });
    const response = responseDouble();

    await serviceFor()
      .enforce({}, response as never, 'write', ['ip'], { ip: '203.0.113.7' })
      .catch(() => undefined);

    const retryAfter = response.headers[RATE_LIMIT_HEADERS.retryAfter];
    expect(retryAfter).toBe('1');
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('stops at the exhausted scope, so later stages cost nothing', async () => {
    counter.consume.mockResolvedValue({ allowed: false, remaining: 0, resetSeconds: 5 });

    await serviceFor()
      .enforce({}, responseDouble() as never, 'write', ['ip', 'api_key'], {
        ip: '203.0.113.7',
        api_key: 'key-id',
      })
      .catch(() => undefined);

    expect(counter.consume).toHaveBeenCalledTimes(1);
    expect(counter.consume.mock.calls[0][0]).toBe('ip');
  });

  it('refuses a scope the class does not declare', async () => {
    await expect(
      serviceFor().enforce({}, responseDouble() as never, 'read', ['api_key'], { api_key: 'key-id' }),
    ).rejects.toThrow(/declares no "api_key" bucket/);
  });

  it('exposes the class budgets and scopes to the enforcement points', () => {
    const service = serviceFor();
    expect(service.scopesFor('write')).toEqual<RateLimitScope[]>(['ip', 'api_key']);
    expect(service.bucketsFor('webhook.endpoint-create')).toEqual([
      { scope: 'ip', limit: 10, windowSeconds: 3600 },
      { scope: 'api_key', limit: 10, windowSeconds: 3600 },
    ]);
  });
});