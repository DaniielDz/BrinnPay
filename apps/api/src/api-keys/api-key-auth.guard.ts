import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/current-user';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { toApiKeyContext } from './api-key-context';
import { hashApiKey } from './api-key-crypto';

/**
 * API-key authentication boundary (phase 5 §4.5, D4). Ships in this phase as
 * tested infrastructure with **no HTTP consumer** — the contract assigns
 * API-key-authenticated routes to Phases 6+ (customers, payments, …). It must
 * not be applied to the session-only Phase 5 routes (`projects/*`,
 * `api-keys/*`).
 *
 * Procedure: parse `Authorization: Bearer <key>` → compute SHA-256 → look up
 * `api_keys` by `key_hash` → no row or `revoked_at` set → generic **401
 * `UNAUTHENTICATED`** (no disclosure of whether the key exists or was
 * revoked). On success the request is scoped to the key's (project,
 * environment).
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers?.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      this.unauthorized();
    }

    const key = header.slice('Bearer '.length).trim();
    if (key.length === 0) {
      this.unauthorized();
    }

    const keyHash = hashApiKey(key);
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash } });

    if (!row || row.revokedAt) {
      // Revocation is effective immediately; unknown and revoked keys are
      // indistinguishable here (state never disclosed).
      this.unauthorized();
    }

    request.apiKey = toApiKeyContext(row);
    return true;
  }

  private unauthorized(): never {
    throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Authentication required', 401);
  }
}