import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import type { RateLimitFailMode } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import type { RateLimitClass, RateLimitScope } from './rate-limit-classes';

/**
 * The accounting half of the rate-limiting capability (phase 13 §4.2 rules 3–5,
 * D2/D8): an atomic fixed-window counter over Redis, keyed by an opaque hash.
 *
 * - **Atomic (rule 4).** Counting, window creation and reading the remaining TTL
 *   happen in one Lua script — one round trip, one atomic operation. No request
 *   can be admitted as the first of a window twice, and none can observe a count
 *   without a TTL (the script repairs a TTL-less key it encounters).
 * - **Opaque keys (rule 5).** The key is SHA-256 over
 *   (scope, normalized discriminator, class, window), namespaced and versioned
 *   under one prefix. No raw IP, email, API key, API-key id, path or user agent
 *   can appear in it.
 * - **Self-expiring (rule 5).** Every key carries an expiry equal to its window,
 *   so Redis memory is bounded by distinct clients × classes within the window and
 *   no cleanup job exists.
 *
 * The window is owned by Redis (its TTL), never by this process's clock, so
 * replicas cannot desynchronize a bucket (§6.1).
 */

/** Single namespace + version for every limiter key (rule 5). */
const KEY_NAMESPACE = 'brinnpay:rl:v1';

/**
 * Ceiling on one Redis command (F11/§15). The limiter sits on the request path,
 * so a slow Redis must surface as a fast failure — which then takes the
 * documented D8 posture — instead of adding latency to every request.
 */
const REDIS_COMMAND_TIMEOUT_MS = 250;

/**
 * Ceiling on the degraded in-process store (F10/§8). It exists so a Redis outage
 * still bounds *a single process*; it must not be growable by a flood of distinct
 * identities. Expired entries are swept, and the oldest are dropped to stay under
 * the ceiling — the store is a safety bound, not a ledger.
 */
const FALLBACK_STORE_MAX_ENTRIES = 10_000;

/**
 * How often the degraded store's expired-entry sweep may run. The sweep is a full
 * pass over the map, so under a Redis outage with a steady stream of new identities
 * it must not run once per insertion (F10/L-2).
 */
const FALLBACK_SWEEP_INTERVAL_MS = 1_000;

/**
 * Tuple separator. A control character cannot appear in any part, so no
 * combination of scope, discriminator, class and window can be re-partitioned
 * into a different tuple — the anti-injection half of rule 5.
 */
const TUPLE_SEPARATOR = String.fromCharCode(0);

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

/** One bucket after one attempt. */
export interface BucketConsumption {
  /** Whether this attempt stayed inside the budget. */
  readonly allowed: boolean;
  /** Units left in the current window; never negative. */
  readonly remaining: number;
  /**
   * Whole seconds until the current window resets. Always at least 1: a caller
   * is never told to retry in zero or negative seconds (§4.4 point 2).
   */
  readonly resetSeconds: number;
}

interface FallbackCounter {
  count: number;
  windowStartedAt: number;
  windowMs: number;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Derives the bucket key: an opaque SHA-256 over the full tuple, namespaced and
 * versioned. Exported so the derivation is verifiable on its own (AC11): nothing
 * in the returned string can be read back as an identity.
 */
export function deriveRateLimitKey(
  scope: RateLimitScope,
  discriminator: string,
  routeClass: RateLimitClass,
  windowSeconds: number,
): string {
  const tuple = [scope, discriminator, routeClass, String(windowSeconds)].join(TUPLE_SEPARATOR);
  return `${KEY_NAMESPACE}:${createHash('sha256').update(tuple).digest('hex')}`;
}

@Injectable()
export class RateLimitCounterService {
  private readonly logger = new Logger(RateLimitCounterService.name);
  private readonly fallbackCounters = new Map<string, FallbackCounter>();
  private readonly failMode: RateLimitFailMode;
  private degraded = false;
  private lastSweepAt = 0;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.failMode = config.getOrThrow<RateLimitFailMode>('rateLimit.failMode');
  }

  /**
   * Consumes one unit of one bucket and reports the budget the caller should
   * surface. The same method serves the Redis-backed and both degraded paths, so
   * there is a single definition of "allowed" in the system.
   */
  async consume(
    scope: RateLimitScope,
    discriminator: string,
    routeClass: RateLimitClass,
    limit: number,
    windowSeconds: number,
  ): Promise<BucketConsumption> {
    const key = deriveRateLimitKey(scope, discriminator, routeClass, windowSeconds);

    try {
      const raw = await withTimeout(
        this.redis.connection.eval(
          INCREMENT_SCRIPT,
          1,
          key,
          windowSeconds,
        ) as Promise<unknown>,
        REDIS_COMMAND_TIMEOUT_MS,
      );
      const [count, ttl] = Array.isArray(raw) ? (raw as [number, number]) : [0, 0];
      this.degraded = false;
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetSeconds: Math.max(1, ttl),
      };
    } catch {
      this.warnOnce();
      return this.failMode === 'closed'
        ? // Fail-closed: enforcement is preferred over availability, so the
          // attempt is rejected with the configured budget and the full window
          // as the retry hint. Still a 429, never a 5xx (§8).
          { allowed: false, remaining: 0, resetSeconds: windowSeconds }
        : this.consumeInMemory(key, limit, windowSeconds);
    }
  }

  /** One non-identifying warning per degradation episode, never per request. */
  private warnOnce(): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.logger.warn(
      this.failMode === 'closed'
        ? 'Redis is unreachable; rate limiting is failing closed and rejecting requests with 429 (RATE_LIMIT_FAIL_MODE=closed).'
        : 'Redis is unreachable; rate limiting is falling back to a bounded in-process store, so limits are enforced per process only (local-dev fallback, D8).',
    );
  }

  /**
   * The degraded path. A fixed window anchored at the first attempt, bounded by
   * {@link FALLBACK_STORE_MAX_ENTRIES}: expired entries are dropped first, then
   * the oldest, so a flood of distinct identities cannot grow the map without
   * limit (F10/§8).
   */
  private consumeInMemory(key: string, limit: number, windowSeconds: number): BucketConsumption {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const existing = this.fallbackCounters.get(key);
    const current =
      existing !== undefined && now - existing.windowStartedAt < windowMs
        ? existing
        : { count: 0, windowStartedAt: now, windowMs };

    current.count += 1;
    this.remember(key, current);

    return {
      allowed: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
      resetSeconds: Math.max(1, Math.ceil((current.windowStartedAt + windowMs - now) / 1000)),
    };
  }

  private remember(key: string, entry: FallbackCounter): void {
    if (!this.fallbackCounters.has(key) && this.fallbackCounters.size >= FALLBACK_STORE_MAX_ENTRIES) {
      this.evict();
    }
    this.fallbackCounters.set(key, entry);
  }

  /**
   * Sweeps expired entries, then makes room oldest-first until the store is below
   * its ceiling again.
   *
   * The sweep is amortized to at most once per {@link FALLBACK_SWEEP_INTERVAL_MS}:
   * it is a full pass over the map, and a Redis outage with a steady stream of new
   * identities would otherwise turn each insertion into an O(N) scan. The
   * oldest-first loop runs unconditionally and stops as soon as there is room, so a
   * live bucket is only ever displaced by the sheer volume of distinct identities —
   * which is the bound, not a correctness guarantee, of a degraded store.
   */
  private evict(): void {
    const now = Date.now();
    if (now - this.lastSweepAt >= FALLBACK_SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      for (const [key, entry] of this.fallbackCounters) {
        if (now - entry.windowStartedAt >= entry.windowMs) {
          this.fallbackCounters.delete(key);
        }
      }
    }

    while (this.fallbackCounters.size >= FALLBACK_STORE_MAX_ENTRIES) {
      const oldest = this.fallbackCounters.keys().next();
      if (oldest.done) {
        return;
      }
      this.fallbackCounters.delete(oldest.value);
    }
  }
}