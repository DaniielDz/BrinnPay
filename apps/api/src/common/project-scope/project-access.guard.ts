import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import type { ApiKeyContext } from '../../api-keys/api-key-context';
import { API_KEY_PREFIX } from '../../api-keys/api-key-crypto';
import type { AuthenticatedRequest } from '../../auth/current-user';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { ApiError } from '../../common/errors/api-error';
import { ErrorCode } from '../../common/errors/error-code';
import { toResolvedMembership } from '../../organizations/membership';
import {
  RequireCapability,
  type CapabilityRequirement,
} from '../../organizations/org-rbac.guard';
import { can, isRole, type Role } from '../../organizations/roles';
import { PrismaService } from '../../prisma/prisma.service';
import { toResolvedProject } from '../../projects/request-project';

/** Matches `format: uuid` semantics (ADR-0001 IDs are UUIDv7, but the contract
 *  declares plain `uuid`); anything else is treated as a non-existent project. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProjectScopedRequest = AuthenticatedRequest & {
  params?: Record<string, string>;
  apiKey?: ApiKeyContext;
};

/**
 * The shared project-scoped, dual-mode access boundary (phase 10 §14 — the
 * extraction of the guard that phases 6, 7, and 9 each cloned; added before a
 * fourth copy).
 *
 * Exactly one authentication mode is accepted per request, decided by the bearer
 * token itself:
 *
 * - **API-key mode** — the token starts with `sk_` (ADR-0006). The request is
 *   delegated to `ApiKeyAuthGuard`, which resolves the key and attaches its
 *   (project, environment) scope, then the path `project_id` is pinned to the
 *   key's project: a mismatch or a malformed id is a 404, so a key can never
 *   address another project (non-disclosure). No role check applies — a
 *   project-scoped key is a full project operator (D10).
 * - **Session mode** — any other bearer token is the dashboard session JWT. The
 *   request is delegated to `SessionAuthGuard`, then the phase 5 project-scoped
 *   RBAC semantics apply: malformed/unknown project → 404; non-member of the
 *   owning organization → 404 (existence is never revealed); member without the
 *   route's capability → 403. The resolved membership and project are attached
 *   for the scope decorator.
 *
 * Every route declares `@RequireCapability({ capability })`; the registry lives in
 * `organizations/roles.ts` and is not evaluated in API-key mode.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly apiKeyAuth: ApiKeyAuthGuard,
    private readonly sessionAuth: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectScopedRequest>();

    const requirement = this.reflector.get<CapabilityRequirement | undefined>(
      RequireCapability,
      context.getHandler(),
    );
    if (!requirement) {
      // Programming error: every project-scoped route declares a capability.
      throw new Error('ProjectAccessGuard requires @RequireCapability on the route handler');
    }

    const header = request.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      if (token.startsWith(API_KEY_PREFIX)) {
        await this.apiKeyAuth.canActivate(context);
        this.authorizeApiKeyMode(request);
        return true;
      }
    }

    await this.sessionAuth.canActivate(context);
    return this.authorizeSessionMode(request, requirement);
  }

  /**
   * API-key mode: the path `project_id` must be the key's project. A malformed
   * id or any other project is indistinguishable from a non-existent one.
   */
  private authorizeApiKeyMode(request: ProjectScopedRequest): void {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    if (!request.apiKey || request.apiKey.project_id !== projectId) {
      this.notFound();
    }
  }

  private async authorizeSessionMode(
    request: ProjectScopedRequest,
    requirement: CapabilityRequirement,
  ): Promise<true> {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    if (!request.authUser) {
      // Programming error: must run after SessionAuthGuard.
      throw new Error('ProjectAccessGuard used without SessionAuthGuard');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      this.notFound();
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.organizationId,
          userId: request.authUser.id,
        },
      },
    });
    if (!membership) {
      // Non-member: the project is indistinguishable from a non-existent one.
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
    throw new ApiError(ErrorCode.NOT_FOUND, 'Project not found', 404);
  }
}
