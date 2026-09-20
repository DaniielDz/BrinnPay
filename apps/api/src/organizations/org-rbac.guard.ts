import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../auth/current-user';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { toResolvedMembership } from './membership';
import { can, isRole, type Capability, type Role } from './roles';

export interface CapabilityOptions {
  /**
   * `members.update` / `members.remove` self-service: actors without the
   * capability may act on their own membership (self-demotion / self-removal,
   * phase 4 §4.2, D4). Target-restriction and last-owner rules still apply in
   * the service layer.
   */
  allowSelf?: boolean;
}

export interface CapabilityRequirement {
  capability: Capability;
  options?: CapabilityOptions;
}

/**
 * Declares the capability a route requires. Applied together with
 * `@UseGuards(SessionAuthGuard, OrgRbacGuard)`, e.g.
 * `@RequireCapability({ capability: 'members.update', options: { allowSelf: true } })`.
 */
export const RequireCapability = Reflector.createDecorator<CapabilityRequirement>({
  key: 'brinnpay:capability',
});

/**
 * Matches `format: uuid` semantics (ADR-0001 IDs are UUIDv7, but the contract
 * declares plain `uuid`); anything else is treated as a non-existent resource.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reusable org-scoped RBAC guard (phase 4 §4.3, D2). Runs after `SessionAuth`
 * on org-scoped routes and is the single authorization boundary:
 *
 * 1. reads `organization_id` from the request path (malformed → 404);
 * 2. loads the caller's membership; no membership → 404 (`NOT_FOUND`, D1);
 * 3. evaluates the required capability against the role matrix; insufficient
 *    → 403 (`FORBIDDEN`); self-service targets bypass the matrix;
 * 4. attaches the resolved membership to the request.
 *
 * Later phases (5–13) reuse this guard and extend the capability registry.
 */
@Injectable()
export class OrgRbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { params?: Record<string, string> }>();
    const requirement = this.reflector.get<CapabilityRequirement | undefined>(
      RequireCapability,
      context.getHandler(),
    );

    if (!requirement) {
      // Programming error: every org-scoped route declares a capability.
      throw new Error('OrgRbacGuard requires @RequireCapability on the route handler');
    }

    const organizationId = request.params?.organization_id;
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) {
      // A malformed ID cannot identify a real organization; the resource is
      // not visible to anyone (D1 semantics, safe non-disclosure).
      this.notFound();
    }

    if (!request.authUser) {
      // Programming error: must run after SessionAuthGuard.
      throw new Error('OrgRbacGuard used without SessionAuthGuard');
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: request.authUser.id },
      },
    });

    if (!membership) {
      this.notFound();
    }

    if (!isRole(membership.role)) {
      // Defensive: DB `varchar` roles are app-validated (D10); never pass an
      // unrecognized role into the matrix.
      this.notFound();
    }
    const role = membership.role as Role;

    const selfTargetId = requirement.options?.allowSelf
      ? request.params?.user_id
      : undefined;
    const isSelf = typeof selfTargetId === 'string' && selfTargetId === request.authUser.id;

    if (!isSelf && !can(role, requirement.capability)) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }

    request.organizationMembership = toResolvedMembership(membership);
    return true;
  }

  private notFound(): never {
    // D1: a non-member (or unparseable) organization is indistinguishable from
    // a non-existent one; existence is never revealed.
    throw new ApiError(ErrorCode.NOT_FOUND, 'Organization not found', 404);
  }
}