import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { ApiKeyContext } from '../api-keys/api-key-context';
import { resolveRateLimitClass } from './rate-limit.decorator';
import { RateLimitService, type RateLimitedRequest } from './rate-limit.service';

/**
 * Stage 2 of the enforcement order (phase 13 §4.3, D7).
 *
 * Registered **after** the dual-mode access guard on the project routes, so it
 * only runs once a key has actually resolved: the API-key identity is not
 * available before that, and a global guard cannot key on it (F6). The domain
 * guards are untouched — this is a second guard on the same route, not a change
 * to their logic (§15).
 *
 * In session mode there is no `api_key` bucket at all (D5): the request is
 * covered by the stage-1 `ip` bucket alone, and a stolen access token is not
 * given a per-user budget (a shared NAT egress would throttle unrelated
 * dashboard users).
 *
 * The discriminator is the key's `key_id`, never the presented plaintext
 * (ADR-0006/ADR-0014), and it is hashed before it reaches Redis (§8).
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { apiKey?: ApiKeyContext }>();

    const routeClass = resolveRateLimitClass(this.reflector, context);
    if (!this.rateLimit.scopesFor(routeClass).includes('api_key')) {
      return true;
    }

    const keyId = request.apiKey?.key_id;
    if (typeof keyId !== 'string' || keyId.length === 0) {
      // Session mode (D5): stage 1 alone applies.
      return true;
    }

    await this.rateLimit.enforce(
      request as unknown as RateLimitedRequest,
      http.getResponse<Response>(),
      routeClass,
      ['api_key'],
      { api_key: keyId },
    );

    return true;
  }
}