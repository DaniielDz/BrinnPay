import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import type { ApiKeyContext } from '../../api-keys/api-key-context';
import { API_KEY_PREFIX } from '../../api-keys/api-key-crypto';
import type { AuthenticatedRequest } from '../../auth/current-user';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { ApiError } from '../errors/api-error';
import { ErrorCode } from '../errors/error-code';
import { toResolvedMembership } from '../../organizations/membership';
import {
  RequireCapability,
  type CapabilityRequirement,
} from '../../organizations/org-rbac.guard';
import { can, isRole, type Role } from '../../organizations/roles';
import { PrismaService } from '../../prisma/prisma.service';
import type { ResolvedProject } from '../../projects/request-project';

/** The request shape every dual-mode, project-scoped route family shares. */
export type DualModeRequest = AuthenticatedRequest & {
  params?: Record<string, string>;
  apiKey?: ApiKeyContext;
};

/**
 * The single implementation of the dual-mode authorization semantics
 * (phase 10 §14; phase 18 D1 — consolidation of the phase 6/7/9 guard clones).
 *
 * Exactly one authentication mode is accepted per request, decided by the
 * bearer token itself:
 *
 * - **API-key mode** — the token starts with `sk_` (ADR-0006). The request is
 *   delegated to `ApiKeyAuthGuard`, then the route family's tenant target is
 *   pinned to the key's (project, environment) scope. Anything outside that
 *   scope is a 404 (non-disclosure). No role check applies — a project-scoped
 *   key is a full project operator within its scope (phase 6 D6).
 * - **Session mode** — any other bearer token is the dashboard session JWT.
 *   The request is delegated to `SessionAuthGuard`, then the route family's
 *   tenant target is resolved, the user's membership in the owning
 *   organization is verified (unknown target or non-member → 404; existence is
 *   never revealed), and the route's capability is evaluated (member without
 *   the capability → 403). The resolved project and membership are attached
 *   for the `ProjectScope` decorator.
 *
 * Route families differ only in **how the tenant target is resolved** —
 * project-nested routes pin the path `project_id`, payment-nested refund
 * routes resolve the parent payment (phase 9 §38, contract-canonical) — which
 * is the only thing a subclass overrides. Everything else (mode detection,
 * delegation, membership resolution, 404/403 semantics, scope attachment)
 * lives here, once.
 *
 * Every route declares `@RequireCapability({ capability })`; the registry
 * lives in `organizations/roles.ts` and is not evaluated in API-key mode.
 */
export abstract class DualModeAccessGuard implements CanActivate {
  protected constructor(
    protected readonly reflector: Reflector,
    protected readonly prisma: PrismaService,
    private readonly apiKeyAuth: ApiKeyAuthGuard,
    private readonly sessionAuth: SessionAuthGuard,
    /** The concrete class name, used in programming-error messages. */
    private readonly guardName: string,
    /** The not-found subject of the route family (`Project` / `Payment`). */
    private readonly notFoundSubject: 'Project' | 'Payment',
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DualModeRequest>();

    const requirement = this.reflector.get<CapabilityRequirement | undefined>(
      RequireCapability,
      context.getHandler(),
    );
    if (!requirement) {
      // Programming error: every dual-mode route declares a capability.
      throw new Error(`${this.guardName} requires @RequireCapability on the route handler`);
    }

    const header = request.headers?.authorization;
    const apiKeyMode =
      typeof header === 'string' &&
      header.startsWith('Bearer ') &&
      header.slice('Bearer '.length).trim().startsWith(API_KEY_PREFIX);

    if (apiKeyMode) {
      await this.apiKeyAuth.canActivate(context);
      await this.authorizeApiKeyMode(request);
    } else {
      await this.sessionAuth.canActivate(context);
      await this.authorizeSessionMode(request, requirement);
    }

    return true;
  }

  /**
   * API-key mode: verify the authenticated key may address the route's tenant
   * target. Must throw {@link DualModeAccessGuard.notFound} for a target
   * outside the key's (project, environment) scope, so a key can never address
   * another tenant (non-disclosure). No membership or capability queries.
   */
  protected abstract authorizeApiKeyMode(request: DualModeRequest): Promise<void>;

  /**
   * Session mode: resolve the project the membership check must be evaluated
   * against. Must throw {@link DualModeAccessGuard.notFound} for a malformed
   * or unknown target, before any membership lookup (existence is never
   * revealed).
   */
  protected abstract resolveSessionProject(request: DualModeRequest): Promise<ResolvedProject>;

  /**
   * Session mode: project → owning organization → membership → capability,
   * with the phase 4/5 404/403 semantics. The resolved membership + project
   * context are attached for the `ProjectScope` decorator.
   */
  private async authorizeSessionMode(
    request: DualModeRequest,
    requirement: CapabilityRequirement,
  ): Promise<void> {
    if (!request.authUser) {
      // Programming error: must run after SessionAuthGuard.
      throw new Error(`${this.guardName} used without SessionAuthGuard`);
    }

    const project = await this.resolveSessionProject(request);
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: project.organization_id,
          userId: request.authUser.id,
        },
      },
    });
    if (!membership) {
      // Non-member: the target is indistinguishable from a non-existent one.
      // The project context is deliberately NOT attached, so the request log
      // (phase 11 §4.2 rule 5) records a null scope — a non-member can never
      // write rows into a foreign tenant's log.
      this.notFound();
    }

    if (!isRole(membership.role)) {
      // Defensive: DB `varchar` roles are app-validated (phase 4 D10).
      this.notFound();
    }
    const role = membership.role as Role;

    // Attached after membership resolution so a 403 still carries the scope
    // resolved to that point (phase 11 §4.2 rule 5) while non-member 404s stay
    // null-scoped. Authorization itself is unchanged — the handler never runs
    // either way.
    request.project = project;
    request.organizationMembership = toResolvedMembership(membership);

    if (!can(role, requirement.capability)) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }
  }

  protected notFound(): never {
    throw new ApiError(ErrorCode.NOT_FOUND, `${this.notFoundSubject} not found`, 404);
  }
}
