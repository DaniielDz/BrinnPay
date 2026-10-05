import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { RedisService } from '../src/redis/redis.service';
import { deriveRateLimitKey, RateLimitCounterService } from '../src/rate-limiting/rate-limit-counter.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 13 counter integration against **real Redis** (§10 "Integration").
 *
 * These are the properties no unit double can establish: that the atomic script
 * really returns count *and* TTL in one round trip, that concurrent
 * first-requests admit exactly `limit`, that the key carries its window as a TTL,
 * and — the reason Redis is used at all — that **two independent limiter
 * instances sharing one Redis enforce one budget** rather than one budget each.
 *
 * They live in this harness because the repository has a single `test:e2e` command
 * backed by real PostgreSQL and Redis (`docker/compose.yml`, CI services); the
 * Redis dependency is probed through the same `requireDependencies` gate, so a
 * missing Redis fails loudly instead of quietly skipping.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY_PATTERN = 'brinnpay:rl:v1:*';

describe('rate limit counter (Phase 13, real Redis)', () => {
  let admin: Redis;
  let reachable = false;
  const clients: Redis[] = [];

  /**
   * One real ioredis connection per limiter instance — which is the point of the
   * cross-replica cases below: separate connections, one shared budget.
   *
   * The offline queue is enabled so a command issued while the socket is still
   * coming up is flushed rather than rejected; an unreachable URL still fails
   * fast because the retry strategy gives up immediately.
   */
  function counterFor(url = REDIS_URL, failMode: 'open' | 'closed' = 'open'): RateLimitCounterService {
    const client = new Redis(url, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    clients.push(client);
    return new RateLimitCounterService(
      // The counter only ever uses `connection`, so a narrow double keeps the
      // suite independent of the API's own Redis provider lifecycle.
      { connection: client } as unknown as RedisService,
      { getOrThrow: () => failMode } as unknown as ConfigService,
    );
  }

  const consume = (
    service: RateLimitCounterService,
    discriminator: string,
    options: { scope?: 'ip' | 'account' | 'api_key'; routeClass?: 'read' | 'write'; limit?: number; window?: number } = {},
  ) =>
    service.consume(
      options.scope ?? 'ip',
      discriminator,
      options.routeClass ?? 'read',
      options.limit ?? 5,
      options.window ?? 60,
    );

  beforeAll(async () => {
    admin = new Redis(REDIS_URL);
    try {
      await admin.ping();
      reachable = true;
    } catch {
      reachable = false;
    }
  });

  afterAll(async () => {
    if (admin) {
      const keys = await admin.keys(KEY_PATTERN).catch(() => []);
      if (keys.length > 0) await admin.del(...keys);
      await admin.quit();
    }
    for (const client of clients) {
      client.disconnect();
    }
  });

  beforeEach(async () => {
    requireDependencies(reachable);
    const keys = await admin.keys(KEY_PATTERN);
    if (keys.length > 0) await admin.del(...keys);
  });

  // -------------------------------------------------------------------------
  // Atomicity (rule 4, AC8)
  // -------------------------------------------------------------------------

  it('returns count and remaining TTL from one round trip, and anchors the window at the first hit', async () => {
    const service = counterFor();

    const first = await consume(service, '203.0.113.1', { limit: 5, window: 60 });
    expect(first).toMatchObject({ allowed: true, remaining: 4 });
    expect(first.resetSeconds).toBeGreaterThan(0);
    expect(first.resetSeconds).toBeLessThanOrEqual(60);

    const second = await consume(service, '203.0.113.1', { limit: 5, window: 60 });
    expect(second.remaining).toBe(3);
    // The window did not restart between the two hits: the TTL only decreased.
    expect(second.resetSeconds).toBeLessThanOrEqual(first.resetSeconds);
  });

  it('admits exactly `limit` concurrent first-requests in one window (AC8)', async () => {
    // Ten independent limiter instances race for the same fresh bucket.
    const services = Array.from({ length: 10 }, () => counterFor());
    const results = await Promise.all(
      services.map((service) => consume(service, '203.0.113.2', { limit: 5 })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
    expect(await admin.get(deriveRateLimitKey('ip', '203.0.113.2', 'read', 60))).toBe('10');
  });

  it('charges a rejected attempt exactly one unit', async () => {
    const service = counterFor();
    await Promise.all(
      Array.from({ length: 8 }, () => consume(service, '203.0.113.3', { limit: 2 })),
    );
    // 2 allowed + 6 rejected, every one of them counted.
    expect(await admin.get(deriveRateLimitKey('ip', '203.0.113.3', 'read', 60))).toBe('8');

    const next = await consume(service, '203.0.113.3', { limit: 2 });
    expect(next.allowed).toBe(false);
    expect(await admin.get(deriveRateLimitKey('ip', '203.0.113.3', 'read', 60))).toBe('9');
  });

  it('resets the window after it expires', async () => {
    const service = counterFor();
    await consume(service, '203.0.113.4', { limit: 1, window: 1 });
    await expect(consume(service, '203.0.113.4', { limit: 1, window: 1 })).resolves.toMatchObject({
      allowed: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(consume(service, '203.0.113.4', { limit: 1, window: 1 })).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it('carries the window as the key TTL, so no cleanup job is required', async () => {
    await consume(counterFor(), '203.0.113.5', { limit: 5, window: 120 });
    const ttl = await admin.ttl(deriveRateLimitKey('ip', '203.0.113.5', 'read', 120));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('never leaves a counted key without an expiry', async () => {
    const key = deriveRateLimitKey('ip', '203.0.113.6', 'read', 60);
    // A key that somehow exists without a TTL is repaired by the same script, so
    // no request can observe a count that outlives its window.
    await admin.set(key, '7');
    expect(await admin.ttl(key)).toBe(-1);

    await consume(counterFor(), '203.0.113.6', { limit: 5, window: 60 });
    expect(await admin.ttl(key)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Cross-replica and isolation
  // -------------------------------------------------------------------------

  it('enforces one budget across two independent limiter instances (the cross-replica property)', async () => {
    const first = counterFor();
    const second = counterFor();

    await consume(first, '203.0.113.7', { limit: 2 });
    await expect(consume(second, '203.0.113.7', { limit: 2 })).resolves.toMatchObject({ allowed: true });
    // The second instance sees the first instance's count, so the budget is one
    // budget — which is exactly what in-process storage could not give.
    await expect(consume(second, '203.0.113.7', { limit: 2 })).resolves.toMatchObject({ allowed: false });
  });

  it('isolates scopes, classes, windows and identities', async () => {
    const service = counterFor();
    await consume(service, '203.0.113.8', { limit: 1, routeClass: 'read' });
    await expect(consume(service, '203.0.113.8', { limit: 1, routeClass: 'read' })).resolves.toMatchObject({
      allowed: false,
    });

    // A different identity, a different scope, a different class and a different
    // window are all separate budgets.
    await expect(consume(service, '203.0.113.9', { limit: 1, routeClass: 'read' })).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      consume(service, '203.0.113.8', { limit: 1, routeClass: 'write' }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      consume(service, '203.0.113.8', { limit: 1, routeClass: 'read', window: 300 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      consume(service, '203.0.113.8', { limit: 1, scope: 'account', routeClass: 'read' }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('keeps every identity out of the Redis keys it creates (AC11)', async () => {
    const service = counterFor();
    const identities = ['203.0.113.10', 'someone@example.com', '0192f2a0-0000-7000-8000-000000000004'];

    await consume(service, identities[0], { limit: 5 });
    await consume(service, identities[1], { scope: 'account', limit: 5 });
    await consume(service, identities[2], { scope: 'api_key', routeClass: 'write', limit: 5 });

    const keys = await admin.keys(KEY_PATTERN);
    expect(keys.length).toBe(3);
    const dump = keys.join(' ');
    for (const identity of identities) {
      expect(dump).not.toContain(identity);
    }
    for (const key of keys) {
      expect(key).toMatch(/^brinnpay:rl:v1:[0-9a-f]{64}$/);
    }
  });

  // -------------------------------------------------------------------------
  // Degraded posture (D8)
  // -------------------------------------------------------------------------

  it('bounds a single process when Redis is unreachable, and stores nothing', async () => {
    const service = counterFor('redis://127.0.0.1:1', 'open');
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await consume(service, '203.0.113.11', { limit: 2, window: 60 }));
    }
    expect(results.map((result) => result.allowed)).toEqual([true, true, false, false]);
    // Nothing reached Redis, so a degraded process cannot poison the shared
    // budget of a healthy replica.
    expect(await admin.keys(KEY_PATTERN)).toHaveLength(0);
  });

  it('stays within its memory bound under a flood of distinct identities', async () => {
    const service = counterFor('redis://127.0.0.1:1', 'open');
    for (let index = 0; index < 10_050; index += 1) {
      await consume(service, `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`, {
        limit: 5,
        window: 60,
      });
    }
    const store = (service as unknown as { fallbackCounters: Map<string, unknown> }).fallbackCounters;
    expect(store.size).toBeLessThanOrEqual(10_000);
  });

  it('rejects with 429 instead of a 5xx when configured to fail closed', async () => {
    const service = counterFor('redis://127.0.0.1:1', 'closed');
    await expect(consume(service, '203.0.113.12', { limit: 5 })).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetSeconds: 60,
    });
  });

  it('restores Redis-backed counting after a recovery', async () => {
    const degraded = counterFor('redis://127.0.0.1:1', 'open');
    await consume(degraded, '203.0.113.13', { limit: 1 });

    const recovered = counterFor(REDIS_URL, 'open');
    await consume(recovered, '203.0.113.13', { limit: 1 });
    expect(await admin.get(deriveRateLimitKey('ip', '203.0.113.13', 'read', 60))).toBe('1');
    // The healthy path now counts in Redis: the degraded attempt is gone with it.
    await expect(consume(recovered, '203.0.113.13', { limit: 1 })).resolves.toMatchObject({
      allowed: false,
    });
  });
});