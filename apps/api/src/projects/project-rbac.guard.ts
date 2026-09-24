import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../auth/current-user';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { toResolvedMembership } from '../organizations/membership';
import {
  RequireCapability,
  type CapabilityRequirement,
} from '../organizations/org-rbac.guard';
import { can, isRole, type Role } from '../organizations/roles';
import { PrismaService } from '../prisma/prisma.service';
import { toResolvedProject } from './request-project';

/** Matches `format: uuid` semantics (ADR-0001 IDs are UUIDv7, but the contract
 *  declares plain `uuid`); anything else is treated as a non-existent
 *  resource. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project-scoped RBAC guard (phase 5 §4.1/D2). Runs after `SessionAuth` on
 * project routes (whose paths carry `project_id`, not `organization_id`) and
 * extends the Phase 4 guard mechanics with the project → owning organization
 * indirection:
 *
 * 1. reads `project_id` from the request path (malformed → 404);
 * 2. loads the project; unknown project → 404 (`NOT_FOUND`, D1 semantics);
 * 3. loads the caller's membership in the owning organization; no membership
 *    → 404 (project existence is never revealed cross-tenant);
 * 4. evaluates the required capability against the role matrix; insufficient
 *    → 403 (`FORBIDDEN`);
 * 5. attaches the resolved membership and the resolved project context to the
 *    request.
 *
 * The capability registry stays in the single shared location
 * (`organizations/roles.ts`, extended by Phase 5 §4.3); routes reuse the same
 * `@RequireCapability` decorator as the org-scoped guard.
 */
@Injectable()
export class ProjectRbacGuard implements CanActivate {
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
      // Programming error: every project-scoped route declares a capability.
      throw new Error('ProjectRbacGuard requires @RequireCapability on the route handler');
    }

    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      // A malformed ID cannot identify a real project; the resource is not
      // visible to anyone (phase 4 D1 semantics, safe non-disclosure).
      this.notFound();
    }

    if (!request.authUser) {
      // Programming error: must run after SessionAuthGuard.
      throw new Error('ProjectRbacGuard used without SessionAuthGuard');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      this.notFound();
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: project.organizationId, userId: request.authUser.id },
      },
    });

    if (!membership) {
      // Non-member of the owning organization: the project is indistinguishable
      // from a non-existent one (phase 4 D1 applied to projects — D2).
      this.notFound();
    }

    if (!isRole(membership.role)) {
      // Defensive: DB `varchar` roles are app-validated (phase 4 D10).
      this.notFound();
    }
    const role = membership.role as Role;

    if (!can(role, requirement.capability)) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }

    request.organizationMembership = toResolvedMembership(membership);
    request.project = toResolvedProject(project);
    return true;
  }

  private notFound(): never {
    // D2: a non-member (or unparseable) project is indistinguishable from a
    // non-existent one; existence is never revealed.
    throw new ApiError(ErrorCode.NOT_FOUND, 'Project not found', 404);
  }
}