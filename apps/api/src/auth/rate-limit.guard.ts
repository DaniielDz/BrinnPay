import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { resolveRateLimitClass } from '../rate-limiting/rate-limit.decorator';
import { normalizeAccountDiscriminator } from '../rate-limiting/rate-limit-discriminator';
import { RateLimitService, type RateLimitedRequest } from '../rate-limiting/rate-limit.service';

/**
 * The phase 3 per-account limiter, now a thin consumer of the cross-cutting
 * capability (phase 13 §15).
 *
 * Phase 3 already proved that `/auth/*` needs two dimensions and this guard still
 * applies the one the shared capability does not stage for it: the **`account`**
 * scope, the credential-stuffing dimension, present only on
 * `auth.session-creation` (D10 — the catalog decides, not this guard). The `ip`
 * dimension is staged for every request by the global pre-authentication guard, so
 * counting it here as well would have charged an authenticated client twice per
 * attempt.
 *
 * Behavior is unchanged: same limits, same window, same per-account rule (only
 * when the request carries an email), same canonical `RATE_LIMITED` 429 — the
 * shared capability adds the budget headers and the budget-only `details` the
 * phase requires (§4.4 point 5, D13).
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const routeClass = resolveRateLimitClass(this.reflector, context);
    if (!this.rateLimit.scopesFor(routeClass).includes('account')) {
      return true;
    }

    const email = request.body?.email;
    if (typeof email !== 'string' || email.length === 0) {
      // Nothing to count: a request without an email cannot be attributed to an
      // account, exactly as in phase 3.
      return true;
    }

    await this.rateLimit.enforce(
      request as unknown as RateLimitedRequest,
      http.getResponse<Response>(),
      routeClass,
      ['account'],
      { account: normalizeAccountDiscriminator(email) },
    );

    return true;
  }
}