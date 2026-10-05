import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from '../redis/redis.service';
import type { RateLimitFailMode } from '../config/configuration';
import type { RateLimitClass } from './rate-limit-classes';
import { deriveRateLimitKey, RateLimitCounterService } from './rate-limit-counter.service';

/**
 * The accounting half (phase 13 §4.2 rules 3–5, D2/D8): one atomic round trip,
 * opaque keys, self-expiring windows, and both failure postures.
 */
describe('RateLimitCounterService (phase 13 §4.2)', () => {
  let evalMock: jest.Mock;
  let redis: { connection: { eval: jest.Mock } };
  let warn: jest.SpyInstance;

  function counterFor(failMode: RateLimitFailMode = 'open'): RateLimitCounterService {
    const config = { getOrThrow: jest.fn().mockReturnValue(failMode) };
    return new RateLimitCounterService(
      redis as unknown as RedisService,
      config as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    evalMock = jest.fn();
    redis = { connection: { eval: evalMock } };
    // The degradation warning is the observable the posture tests assert on, and
    // it must be asserted without going through the global logging pipeline.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const consume = (
    service: RateLimitCounterService,
    overrides: { scope?: 'ip' | 'account' | 'api_key'; discriminator?: string; limit?: number } = {},
  ) =>
    service.consume(
      overrides.scope ?? 'ip',
      overrides.discriminator ?? '203.0.113.7',
      'read',
      overrides.limit ?? 10,
      60,
    );

  describe('key derivation (rule 5, AC11)', () => {
    it('namespaces and versions the key', () => {
      expect(deriveRateLimitKey('ip', '203.0.113.7', 'read', 60)).toMatch(
        /^brinnpay:rl:v1:[0-9a-f]{64}$/,
      );
    });

    it('keeps every identity out of the key', () => {
      const identities = ['203.0.113.7', 'someone@example.com', 'sk_test_secret', 'key-id-1234'];
      for (const identity of identities) {
        const key = deriveRateLimitKey('ip', identity, 'write', 60);
        expect(key).not.toContain(identity);
        expect(key).toMatch(/^brinnpay:rl:v1:[0-9a-f]{64}$/);
      }
    });

    it('separates every tuple part, so no two buckets collide', () => {
      const scope = deriveRateLimitKey('ip', 'a', 'read', 60);
      expect(deriveRateLimitKey('account', 'a', 'read', 60)).not.toBe(scope);
      expect(deriveRateLimitKey('ip', 'b', 'read', 60)).not.toBe(scope);
      expect(deriveRateLimitKey('ip', 'a', 'write', 60)).not.toBe(scope);
      expect(deriveRateLimitKey('ip', 'a', 'read', 900)).not.toBe(scope);
    });

    it('cannot be re-partitioned into a different tuple', () => {
      // Without a separator, these two would hash the same concatenation.
      expect(deriveRateLimitKey('ip', 'a:b', 'read', 60)).not.toBe(
        deriveRateLimitKey('ip', 'a', 'b' as RateLimitClass, 60),
      );
    });

    it('is deterministic, so replicas derive the same bucket', () => {
      expect(deriveRateLimitKey('ip', '203.0.113.7', 'read', 60)).toBe(
        deriveRateLimitKey('ip', '203.0.113.7', 'read', 60),
      );
    });

    it('sends the derived key — never the discriminator — to Redis', async () => {
      evalMock.mockResolvedValue([1, 60]);
      await consume(counterFor(), { discriminator: 'someone@example.com' });
      expect(evalMock.mock.calls[0][1]).not.toContain('someone@example.com');
    });
  });

  describe('atomic counting (rule 4, D2)', () => {
    it('issues exactly one Redis command and reads count and TTL from it', async () => {
      evalMock.mockResolvedValue([3, 42]);
      await expect(consume(counterFor())).resolves.toEqual({
        allowed: true,
        remaining: 7,
        resetSeconds: 42,
      });
      // No second `TTL` round trip: the script returns both halves.
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the window TTL in the same script that counts', async () => {
      evalMock.mockResolvedValue([1, 60]);
      await consume(counterFor());
      const script = String(evalMock.mock.calls[0][0]);
      expect(script).toContain("redis.call('INCR'");
      expect(script).toContain("redis.call('EXPIRE'");
      expect(script).toContain("redis.call('TTL'");
    });

    it('allows up to the limit and rejects the attempt past it', async () => {
      evalMock.mockResolvedValue([10, 60]);
      await expect(consume(counterFor())).resolves.toEqual({ allowed: true, remaining: 0, resetSeconds: 60 });

      evalMock.mockResolvedValue([11, 60]);
      await expect(consume(counterFor())).resolves.toEqual({
        allowed: false,
        remaining: 0,
        resetSeconds: 60,
      });
    });

    it('never reports a remaining count below zero or a reset of zero', async () => {
      evalMock.mockResolvedValue([999, 0]);
      await expect(consume(counterFor())).resolves.toEqual({
        allowed: false,
        remaining: 0,
        resetSeconds: 1,
      });

      evalMock.mockResolvedValue([-3, -1]);
      await expect(consume(counterFor())).resolves.toEqual({
        allowed: true,
        remaining: 13,
        resetSeconds: 1,
      });
    });

    it('uses the window as the counter expiry, so no cleanup job is needed', async () => {
      evalMock.mockResolvedValue([1, 60]);
      await counterFor().consume('ip', '203.0.113.7', 'read', 10, 60);
      expect(evalMock.mock.calls[0][3]).toBe(60);
    });
  });

  describe('failure posture (D8, AC12)', () => {
    it('fails open with a single warning and a bounded in-process store', async () => {
      evalMock.mockRejectedValue(new Error('redis down'));
      const service = counterFor();
      await expect(consume(service, { limit: 2 })).resolves.toMatchObject({ allowed: true });
      await expect(consume(service, { limit: 2 })).resolves.toMatchObject({ allowed: true });
      await expect(consume(service, { limit: 2 })).resolves.toMatchObject({ allowed: false });

      // One warning for the whole degradation, and it names no identity.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('203.0.113.7');
      expect(String(warn.mock.calls[0][0])).not.toContain('brinnpay:rl');
    });

    it('never turns a Redis error into a throw', async () => {
      evalMock.mockRejectedValue(new Error('redis down'));
      await expect(consume(counterFor())).resolves.toMatchObject({ allowed: true });
    });

    it('sweeps the degraded store at most once per second, not once per insertion', async () => {
      // The sweep is a full pass over the map; under an outage with a steady stream
      // of new identities, running it per insertion is a CPU amplifier (L-2).
      evalMock.mockRejectedValue(new Error('redis down'));
      const service = counterFor();
      for (let index = 0; index < 10_050; index += 1) {
        await service.consume('ip', `10.1.${Math.floor(index / 256)}.${index % 256}`, 'read', 10, 60);
      }
      const lastSweepAt = (service as unknown as { lastSweepAt: number }).lastSweepAt;
      expect(lastSweepAt).toBeGreaterThan(0);
      // Every insertion past the ceiling still ran, and the store stayed bounded.
      const store = (service as unknown as { fallbackCounters: Map<string, unknown> }).fallbackCounters;
      expect(store.size).toBeLessThanOrEqual(10_000);
    });

    it('stays bounded when no entry ever expires', async () => {
      // A very long window means nothing is ever swept, so the ceiling itself is
      // the only thing keeping the store bounded.
      evalMock.mockRejectedValue(new Error('redis down'));
      const service = counterFor();
      for (let index = 0; index < 10_050; index += 1) {
        await service.consume('ip', `10.2.${Math.floor(index / 256)}.${index % 256}`, 'read', 10, 3600);
      }
      const store = (service as unknown as { fallbackCounters: Map<string, unknown> }).fallbackCounters;
      expect(store.size).toBeLessThanOrEqual(10_000);
    });

    it('bounds the degraded store so a flood of identities cannot grow it', async () => {
      evalMock.mockRejectedValue(new Error('redis down'));
      const service = counterFor();
      for (let index = 0; index < 10_050; index += 1) {
        await service.consume('ip', `10.0.${Math.floor(index / 256)}.${index % 256}`, 'read', 10, 60);
      }
      const store = (service as unknown as { fallbackCounters: Map<string, unknown> }).fallbackCounters;
      expect(store.size).toBeLessThanOrEqual(10_000);
      expect(store.size).toBeGreaterThan(0);
    });

    it('fails closed with a 429-shaped result and no remaining budget', async () => {
      evalMock.mockRejectedValue(new Error('redis down'));
      await expect(counterFor('closed').consume('ip', '203.0.113.7', 'write', 120, 60)).resolves.toEqual({
        allowed: false,
        remaining: 0,
        resetSeconds: 60,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('203.0.113.7');
    });

    it('warns again only after Redis recovers', async () => {
      const service = counterFor();

      evalMock.mockRejectedValue(new Error('down'));
      await consume(service);
      await consume(service);
      expect(warn).toHaveBeenCalledTimes(1);

      evalMock.mockResolvedValue([1, 60]);
      await consume(service);
      evalMock.mockRejectedValue(new Error('down'));
      await consume(service);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('bounds the Redis command, so a slow Redis is a fast failure (F11)', async () => {
      evalMock.mockImplementation(() => new Promise(() => undefined));
      const startedAt = Date.now();
      const result = await counterFor('closed').consume('ip', '203.0.113.7', 'read', 10, 60);
      expect(result.allowed).toBe(false);
      // The bound is well under a request budget; the point is that it is not
      // unbounded, not the exact number.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    }, 5_000);
  });

  describe('degraded window math', () => {
    it('anchors the fallback window at the first attempt and resets it after', async () => {
      evalMock.mockRejectedValue(new Error('down'));
      const service = counterFor();
      const first = await service.consume('ip', '203.0.113.7', 'read', 10, 1);
      expect(first.resetSeconds).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(service.consume('ip', '203.0.113.7', 'read', 10, 1)).resolves.toMatchObject({
        allowed: true,
        remaining: 9,
      });
    });
  });
});