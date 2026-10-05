import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { BrinnPayConfig } from '../config/configuration';
import { isCorsPreflight, isUnderApiPrefix, requestPathOf } from '../request-logging/request-log-record';
import { resolveRateLimitClass } from './rate-limit.decorator';
import {
  resolveClientIdentity,
  type ClientIdentityRequest,
  type ProxyTrust,
} from './rate-limit-discriminator';
import { RateLimitService, type RateLimitedRequest } from './rate-limit.service';

/**
 * The bucket shared by requests whose client identity cannot be resolved at all
 * (a socket with no peer address). It is a constant, not an identity, so it
 * discloses nothing — and it is the same posture phase 3 took for an absent
 * `request.ip`: such requests share one bounded budget rather than escaping
 * counting entirely, which is what an empty discriminator would otherwise do.
 */
const UNRESOLVED_CLIENT = 'unresolved';

/**
 * Stage 0 + stage 1 of the enforcement order (phase 13 §4.3).
 *
 * Registered globally, so it runs **before any route authentication**: an
 * unauthenticated flood is bounded without a database lookup, and an exhausted
 * budget yields 429 rather than 401 for a request that never got as far as a
 * credential (AC2).
 *
 * Stage 0 decides the exclusions from the request path and method alone, before
 * any Redis work: CORS preflights, health probes, Swagger UI traffic and anything
 * outside the API prefix are never counted and never throttled. A health probe
 * must never receive a 429 — a throttled readiness probe would remove a healthy
 * instance from rotation, which is a self-inflicted outage.
 *
 * The exclusion predicates are the ones phase 11 established, imported rather
 * than re-derived, so the recorder and the limiter can never disagree about what
 * the API surface is (§15).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const rawUrl = request.originalUrl ?? request.url ?? '';
    if (!isUnderApiPrefix(requestPathOf(rawUrl))) {
      return true;
    }
    if (isCorsPreflight(request.method, request.headers as Record<string, unknown>)) {
      return true;
    }

    const routeClass = resolveRateLimitClass(this.reflector, context);
    if (!this.rateLimit.scopesFor(routeClass).includes('ip')) {
      return true;
    }

    await this.rateLimit.enforce(
      request as unknown as RateLimitedRequest,
      response,
      routeClass,
      ['ip'],
      {
        ip:
          resolveClientIdentity(request as unknown as ClientIdentityRequest, this.proxyTrust()) ||
          UNRESOLVED_CLIENT,
      },
    );

    return true;
  }

  private proxyTrust(): ProxyTrust {
    const rateLimit = this.config.getOrThrow<BrinnPayConfig['rateLimit']>('rateLimit');
    return { hops: rateLimit.trustedProxyHops, cidrs: rateLimit.trustedProxyCidrs };
  }
}