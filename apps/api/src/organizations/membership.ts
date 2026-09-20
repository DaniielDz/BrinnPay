import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { OrganizationMember as PrismaOrganizationMember } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/current-user';
import type { Role } from './roles';

/**
 * The membership attached to a request by `OrgRbacGuard` (phase 4 §4.3).
 * Route handlers consume it via `@CurrentMembership()` instead of re-deriving
 * membership, keeping the guard the single authorization boundary.
 */
export interface ResolvedMembership {
  id: string;
  organization_id: string;
  user_id: string;
  role: Role;
  created_at: Date;
  updated_at: Date;
}

/**
 * `AuthenticatedRequest` declares an index signature, so the guard can attach
 * `organizationMembership` without coupling the auth module to organizations.
 */
export function toResolvedMembership(membership: PrismaOrganizationMember): ResolvedMembership {
  return {
    id: membership.id,
    organization_id: membership.organizationId,
    user_id: membership.userId,
    role: membership.role as Role,
    created_at: membership.createdAt,
    updated_at: membership.updatedAt,
  };
}

/**
 * Returns the membership attached by `OrgRbacGuard`. Presence is guaranteed
 * only behind `@UseGuards(SessionAuthGuard, OrgRbacGuard)`.
 */
export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedMembership => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const membership = request.organizationMembership as ResolvedMembership | undefined;
    if (!membership) {
      // Programming error: must only be used behind the org-scoped RBAC guard.
      throw new Error('CurrentMembership used outside an org-scoped guard');
    }
    return membership;
  },
);