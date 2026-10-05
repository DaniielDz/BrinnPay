import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import type { BrinnPayConfig } from '../config/configuration';
import {
  buildRateLimitPolicy,
  scopesForClass,
  type RateLimitBucketPolicy,
  type RateLimitClass,
  type RateLimitPolicy,
  type RateLimitScope,
} from './rate-limit-classes';
import { RateLimitCounterService, type BucketConsumption } from './rate-limit-counter.service';

/**
 * The enforcement and reporting half of the rate-limiting capability
 * (phase 13 §4.3/§4.4, D3/D4/D13).
 *
 * Responsibilities, and nothing beyond them: resolve a class's configured
 * buckets, consume the scopes a caller stages, report the applicable budget in
 * the response headers, and raise the canonical 429. It never authenticates,
 * authorizes or validates, never converts a `401` into a `429` or the reverse,
 * and never runs a database query (§4.1).
 */

/** Published standard header names (D3). The legacy `X-RateLimit-*` form is not used. */
export const RATE_LIMIT_HEADERS = {
  limit: 'RateLimit-Limit',
  remaining: 'RateLimit-Remaining',
  reset: 'RateLimit-Reset',
  retryAfter: 'Retry-After',
} as const;

/**
 * The headers listed in `Access-Control-Expose-Headers` (§4.4 point 6) so a
 * cross-origin browser client can read its own remaining budget without a proxy
 * change. Only non-secret budget fields; nothing else is exposed.
 */
export const RATE_LIMIT_EXPOSED_HEADERS = [
  RATE_LIMIT_HEADERS.limit,
  RATE_LIMIT_HEADERS.remaining,
  RATE_LIMIT_HEADERS.reset,
  RATE_LIMIT_HEADERS.retryAfter,
];

/** Where the currently reported bucket is remembered on the request (D4). */
const REPORTED_BUCKET = Symbol('brinnpay:rateLimit:reported');

/**
 * The slice of an Express request the enforcement point may read. It carries the
 * request id and anything a guard resolved; no header, body or cookie value is
 * ever persisted or logged by this module.
 */
export interface RateLimitedRequest {
  [REPORTED_BUCKET]?: { scope: RateLimitScope; limit: number; remaining: number };
}

/** Budget numbers only — never an identity, a scope name or a class name (D13). */
export interface RateLimitBudgetDetails extends Record<string, unknown> {
  limit: number;
  remaining: number;
  window_seconds: number;
}

@Injectable()
export class RateLimitService {
  private readonly policy: RateLimitPolicy;

  constructor(
    config: ConfigService,
    private readonly counter: RateLimitCounterService,
  ) {
    this.policy = buildRateLimitPolicy({
      auth: config.getOrThrow<BrinnPayConfig['auth']>('auth'),
      rateLimit: config.getOrThrow<BrinnPayConfig['rateLimit']>('rateLimit'),
    });
  }

  /** The buckets of a class, in D4 tie-break order. */
  bucketsFor(routeClass: RateLimitClass): readonly RateLimitBucketPolicy[] {
    return this.policy[routeClass];
  }

  /** The scopes a class applies, in D4 tie-break order. */
  scopesFor(routeClass: RateLimitClass): readonly RateLimitScope[] {
    return scopesForClass(routeClass);
  }

  /**
   * Consumes one unit of every staged scope (D10: every attempt that reaches the
   * limiter counts, whatever the request's eventual outcome) and reports the
   * applicable budget on the response — allowed or rejected.
   *
   * The buckets are consumed in the catalog's scope order rather than the order
   * the caller staged them, because that order is what the D4 tie-break is defined
   * against: a caller must not be able to choose which budget the headers report.
   *
   * A scope with no discriminator is **not** counted: the `account` scope has
   * nothing to count when the request carries no email, and `api_key` is only
   * staged once a key has resolved (D5).
   *
   * @throws ApiError 429 `RATE_LIMITED` when any scope is exhausted. The handler
   * never runs and nothing is stored (AC6).
   */
  async enforce(
    request: RateLimitedRequest,
    response: Response,
    routeClass: RateLimitClass,
    scopes: readonly RateLimitScope[],
    discriminators: Readonly<Partial<Record<RateLimitScope, string>>>,
  ): Promise<void> {
    const declared = this.scopesFor(routeClass);
    for (const scope of scopes) {
      if (!declared.includes(scope)) {
        // Programming error: the catalog and the staged scope disagree.
        throw new Error(`Route class "${routeClass}" declares no "${scope}" bucket`);
      }
    }

    for (const scope of declared) {
      if (!scopes.includes(scope)) {
        continue;
      }

      const discriminator = discriminators[scope];
      if (typeof discriminator !== 'string' || discriminator.length === 0) {
        continue;
      }

      const budget = this.budgetFor(routeClass, scope);
      const consumption = await this.counter.consume(
        scope,
        discriminator,
        routeClass,
        budget.limit,
        budget.windowSeconds,
      );

      if (!consumption.allowed) {
        // A rejection always reports the bucket that was exhausted, so `Retry-After`
        // and the budget describe the limit the caller actually hit.
        this.report(request, response, scope, budget, consumption, true);
        response.setHeader(RATE_LIMIT_HEADERS.retryAfter, String(consumption.resetSeconds));
        throw new ApiError(ErrorCode.RATE_LIMITED, 'Too many requests', 429, {
          limit: budget.limit,
          remaining: consumption.remaining,
          window_seconds: budget.windowSeconds,
        } satisfies RateLimitBudgetDetails);
      }

      this.report(request, response, scope, budget, consumption, false);
    }
  }

  private budgetFor(routeClass: RateLimitClass, scope: RateLimitScope): RateLimitBucketPolicy {
    const budget = this.policy[routeClass].find((candidate) => candidate.scope === scope);
    if (!budget) {
      // Programming error: the catalog and the staged scope disagree.
      throw new Error(`Route class "${routeClass}" declares no "${scope}" bucket`);
    }
    return budget;
  }

  /**
   * Publishes the budget of one bucket on the response (D4). When several scopes
   * apply, the bucket **closest to exhaustion** (lowest remaining) is reported, so
   * a developer is never told there is headroom on a request that is about to be
   * rejected. Because the scopes are staged in the catalog's order, keeping the
   * already-reported bucket on an equal count makes the **earlier** scope win a
   * tie. A rejection overrides the choice, because it must describe the limit that
   * was actually hit.
   */
  private report(
    request: RateLimitedRequest,
    response: Response,
    scope: RateLimitScope,
    budget: RateLimitBucketPolicy,
    consumption: BucketConsumption,
    force: boolean,
  ): void {
    const reported = request[REPORTED_BUCKET];
    if (!force && reported !== undefined && reported.remaining <= consumption.remaining) {
      return;
    }

    request[REPORTED_BUCKET] = {
      scope,
      limit: budget.limit,
      remaining: consumption.remaining,
    };
    response.setHeader(RATE_LIMIT_HEADERS.limit, String(budget.limit));
    response.setHeader(RATE_LIMIT_HEADERS.remaining, String(consumption.remaining));
    response.setHeader(RATE_LIMIT_HEADERS.reset, String(consumption.resetSeconds));
  }
}