import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import type { ApiKeyContext } from '../api-keys/api-key-context';
import { API_KEY_PREFIX } from '../api-keys/api-key-crypto';
import type { AuthenticatedRequest } from '../auth/current-user';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { toResolvedMembership } from '../organizations/membership';
import {
  RequireCapability,
  type CapabilityRequirement,
} from '../organizations/org-rbac.guard';
import { can, isRole, type Role } from '../organizations/roles';
import { PrismaService } from '../prisma/prisma.service';
import { toResolvedProject } from '../projects/request-project';

/** Matches `format: uuid` semantics (ADR-0001 IDs are UUIDv7, but the contract
 *  declares plain `uuid`); anything else is treated as a non-existent
 *  resource. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dual-mode access boundary for the customer routes (phase 6 §4.3, D8).
 *
 * Exactly one authentication mode is accepted per request, decided by the
 * bearer token itself:
 *
 * - **API-key mode** — the bearer token starts with `sk_` (the API key
 *   format `sk_test_…`/`sk_live_…`). The request is delegated to
 *   `ApiKeyAuthGuard`, which resolves the key and attaches its (project,
 *   environment) scope, then the path `project_id` is verified against the
 *   key's project — a mismatch (or malformed id) is a 404: the key cannot
 *   address other projects (non-disclosure, phase 4 D1 applied). No role
 *   check applies (D6); the (project, environment) scoping of the data access
 *   itself happens in `CustomersService`.
 * - **Session mode** — any other bearer token is treated as the dashboard
 *   session JWT (the web client signs every request with it). The request is
 *   delegated to `SessionAuthGuard`, then the project-scoped RBAC semantics of
 *   phase 5 are applied: unknown project → 404; non-member of the owning
 *   organization → 404 (existence never revealed); member without the route's
 *   capability → 403; on success the resolved membership + project are
 *   attached to the request.
 *
 * Every route declares `@RequireCapability({ capability })` (the registry
 * lives in `organizations/roles.ts`); in API-key mode the capability is not
 * evaluated.
 */
@Injectable()
export class CustomersAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly apiKeyAuth: ApiKeyAuthGuard,
    private readonly sessionAuth: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { apiKey?: ApiKeyContext; params?: Record<string, string> }>();

    const requirement = this.reflector.get<CapabilityRequirement | undefined>(
      RequireCapability,
      context.getHandler(),
    );
    if (!requirement) {
      // Programming error: every customer route declares a capability.
      throw new Error('CustomersAccessGuard requires @RequireCapability on the route handler');
    }

    const header = request.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      if (token.startsWith(API_KEY_PREFIX)) {
        // API-key mode (D8): delegate to the API-key authentication boundary,
        // then pin the path project to the key's project.
        await this.apiKeyAuth.canActivate(context);
        return this.authorizeApiKeyMode(request);
      }
    }

    // Session mode (D8): delegate to the session authentication boundary, then
    // evaluate the route capability with the phase 5 project-RBAC semantics.
    await this.sessionAuth.canActivate(context);
    return this.authorizeSessionMode(request, requirement);
  }

  /**
   * API-key mode: the key authenticates the request; the path `project_id`
   * must be the key's project. A malformed id or any other project is
   * indistinguishable from a non-existent one (404 — the key never reveals
   * foreign projects).
   */
  private authorizeApiKeyMode(
    request: AuthenticatedRequest & { apiKey?: ApiKeyContext; params?: Record<string, string> },
  ): true {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    if (!request.apiKey || request.apiKey.project_id !== projectId) {
      this.notFound();
    }
    return true;
  }

  /**
   * Session mode: mirrors `ProjectRbacGuard` (phase 5 §4.1/D2): project →
   * owning organization → membership → capability, with the same 404/403
   * semantics. The resolved membership + project context are attached for
   * `CustomersScope` to consume.
   */
  private async authorizeSessionMode(
    request: AuthenticatedRequest & { params?: Record<string, string> },
    requirement: CapabilityRequirement,
  ): Promise<true> {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    if (!request.authUser) {
      // Programming error: must run after SessionAuthGuard.
      throw new Error('CustomersAccessGuard used without SessionAuthGuard');
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
      // Non-member: the project is indistinguishable from a non-existent one
      // (phase 4 D1 applied to projects — D2).
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