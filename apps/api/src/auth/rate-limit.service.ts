import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { RedisService } from '../redis/redis.service';

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
}

interface InMemoryCounter {
  count: number;
  windowStartedAt: number;
}

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return current
`;

/**
 * Redis-backed rate limiting for auth endpoints (D7). Keys are derived from a
 * hashed discriminator (client IP, normalized account email) so no raw
 * credentials or emails sit in keys. When Redis is unreachable the service
 * fails open using an in-process counter — a documented local-dev fallback,
 * never a substitute for Redis-backed limits in shared deployments.
 */
@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);
  private readonly fallbackCounters = new Map<string, InMemoryCounter>();
  private redisFallbackWarned = false;

  constructor(private readonly redis: RedisService) {}

  static hashKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async consume(
    discriminator: string,
    limit: number,
    windowSeconds: number,
  ): Promise<ConsumeResult> {
    const key = `auth:rl:${AuthRateLimitService.hashKey(discriminator)}`;

    try {
      const current = (await this.redis.connection.eval(
        INCREMENT_SCRIPT,
        1,
        key,
        windowSeconds,
      )) as number;
      return { allowed: current <= limit, remaining: Math.max(0, limit - current) };
    } catch {
      if (!this.redisFallbackWarned) {
        this.redisFallbackWarned = true;
        this.logger.warn(
          'Redis is unreachable; auth rate limiting is falling back to an in-process store (local-dev fallback, D7).',
        );
      }
      return this.consumeInMemory(key, limit, windowSeconds);
    }
  }

  private consumeInMemory(
    key: string,
    limit: number,
    windowSeconds: number,
  ): ConsumeResult {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = this.fallbackCounters.get(key);
    const current = entry && now - entry.windowStartedAt < windowMs ? entry : { count: 0, windowStartedAt: now };

    current.count += 1;
    this.fallbackCounters.set(key, current);

    return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count) };
  }
}