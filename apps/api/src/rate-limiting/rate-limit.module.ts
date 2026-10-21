import { Global, Module } from '@nestjs/common';

import { ApiKeyRateLimitGuard } from './api-key-rate-limit.guard';
import { RateLimitCounterService } from './rate-limit-counter.service';
import { RateLimitService } from './rate-limit.service';

/**
 * The cross-cutting rate-limiting capability (phase 13 §4.1).
 *
 * It owns four things and nothing else: the **policy** (the closed class
 * catalog), the **accounting** (an atomic Redis counter keyed by an opaque
 * hash), the **enforcement points** (the global pre-authentication `ip` stage,
 * registered in `AppModule`, and the post-authentication `api_key` stage
 * exported here) and the **reporting** (the `RateLimit-*`/`Retry-After` headers
 * and the 429 envelope).
 *
 * `global` because every domain module needs the enforcement points, and the
 * capability's own dependency (`RedisService`) is already global. Domain modules
 * declare the class of their operations and nothing more: never a limit, a
 * window, a Redis key or a header.
 *
 * The webhook **worker** never imports this module: it serves no HTTP traffic and
 * registers no limiter (§4.2 rule 7).
 */
@Global()
@Module({
  providers: [RateLimitCounterService, RateLimitService, ApiKeyRateLimitGuard],
  exports: [RateLimitService, ApiKeyRateLimitGuard],
})
export class RateLimitingModule {}