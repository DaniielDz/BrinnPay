import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { toPublicUser, type AuthenticatedRequest } from './current-user';
import { TokenService } from './token.service';

/**
 * Reusable session-authentication boundary (phase 3 §4.3). Validates the
 * bearer JWT access token, loads the user, and attaches the public identity to
 * the request as `authUser`. Every session-authenticated endpoint in this and
 * later phases (4–14) enforces authentication here.
 *
 * This guard establishes *authentication* only; authorization (RBAC, tenant
 * isolation) belongs to Phase 4 and must not be approximated here.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers?.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      this.unauthorized();
    }

    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      this.unauthorized();
    }

    const claims = this.tokenService.verifyAccessToken(token);
    if (!claims) {
      this.unauthorized();
    }

    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) {
      this.unauthorized();
    }

    request.authUser = toPublicUser(user);
    return true;
  }

  private unauthorized(): never {
    throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Authentication required', 401);
  }
}