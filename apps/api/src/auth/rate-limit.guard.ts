import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import type { BrinnPayConfig } from '../config/configuration';
import type { AuthenticatedRequest } from './current-user';
import { AUTH_RATE_LIMIT_KEY, type AuthRateLimitKind } from './rate-limit.decorator';
import { AuthRateLimitService } from './rate-limit.service';

interface RateLimitProfile {
  ipMax: number;
  accountMax: number;
  applyToAccount: boolean;
  windowSeconds: number;
}

function profileFor(kind: AuthRateLimitKind | undefined, auth: BrinnPayConfig['auth']): RateLimitProfile {
  const limits = auth.rateLimits;
  switch (kind) {
    case 'session-creation':
      // Login/register: both IP and account throttling (D7).
      return {
        ipMax: limits.ipLoginRegisterMax,
        accountMax: limits.accountLoginRegisterMax,
        applyToAccount: true,
        windowSeconds: limits.windowSeconds,
      };
    case 'refresh':
      // Refresh/logout: IP-scoped (cookie-bound credentials already limit abuse).
      return { ipMax: limits.ipRefreshMax, accountMax: 0, applyToAccount: false, windowSeconds: limits.windowSeconds };
    case 'none':
      return { ipMax: Number.MAX_SAFE_INTEGER, accountMax: 0, applyToAccount: false, windowSeconds: limits.windowSeconds };
    default:
      // 'read' and any auth endpoint: IP-scoped.
      return { ipMax: limits.ipReadMax, accountMax: 0, applyToAccount: false, windowSeconds: limits.windowSeconds };
  }
}

/**
 * Applies the IP/account rate limits to every /auth/* endpoint (D7). Limits
 * are env-configurable; a throttled request gets the canonical
 * `RATE_LIMITED` (429) envelope.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest<{ email?: string }>>();

    const kind = this.reflector.getAllAndOverride<AuthRateLimitKind | undefined>(
      AUTH_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const auth = this.config.get<BrinnPayConfig['auth']>('auth');
    if (!auth) {
      // No auth config present: never fail closed over the whole surface.
      // Configuration always defines auth limits; this guards odd test setups.
      return true;
    }

    const profile = profileFor(kind, auth);

    const ip = request.ip ?? 'unknown';
    const ipAllowed = await this.rateLimit.consume(`ip:${ip}`, profile.ipMax, profile.windowSeconds);
    if (!ipAllowed.allowed) {
      this.throwRateLimited();
    }

    const email = request.body?.email;
    if (profile.applyToAccount && typeof email === 'string' && email.length > 0) {
      const accountAllowed = await this.rateLimit.consume(
        `account:${email.trim().toLowerCase()}`,
        profile.accountMax,
        profile.windowSeconds,
      );
      if (!accountAllowed.allowed) {
        this.throwRateLimited();
      }
    }

    return true;
  }

  private throwRateLimited(): never {
    throw new ApiError(ErrorCode.RATE_LIMITED, 'Too many requests', 429);
  }
}