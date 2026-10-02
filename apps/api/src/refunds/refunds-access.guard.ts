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
import { RequireCapability, type CapabilityRequirement } from '../organizations/org-rbac.guard';
import { can, isRole } from '../organizations/roles';
import { PrismaService } from '../prisma/prisma.service';
import { isUuidLike } from '../projects/projects.service';
import { toResolvedProject } from '../projects/request-project';

type RefundRequest = AuthenticatedRequest & {
  params?: Record<string, string>;
  apiKey?: ApiKeyContext;
};

/** Authenticate first, then resolve the payment's tenant and enforce capability.
 * Both unknown and cross-scope payment IDs have the same 404 response. */
@Injectable()
export class RefundsAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly apiKeyAuth: ApiKeyAuthGuard,
    private readonly sessionAuth: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RefundRequest>();
    const requirement = this.reflector.get<CapabilityRequirement | undefined>(
      RequireCapability,
      context.getHandler(),
    );
    if (!requirement) throw new Error('RefundsAccessGuard requires @RequireCapability on the route handler');

    const header = request.headers?.authorization;
    const keyMode = typeof header === 'string' && header.startsWith('Bearer ') &&
      header.slice(7).trim().startsWith(API_KEY_PREFIX);
    if (keyMode) await this.apiKeyAuth.canActivate(context);
    else await this.sessionAuth.canActivate(context);

    const paymentId = request.params?.payment_id;
    if (!paymentId || !isUuidLike(paymentId)) this.notFound();
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { project: true },
    });
    if (!payment) this.notFound();

    if (keyMode) {
      if (!request.apiKey || request.apiKey.project_id !== payment.projectId ||
        request.apiKey.environment !== payment.environment) this.notFound();
    } else {
      if (!request.authUser) throw new Error('RefundsAccessGuard used without SessionAuthGuard');
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: payment.project.organizationId,
            userId: request.authUser.id,
          },
        },
      });
      // A non-member 404 never attaches the project context, so the request
      // log (phase 11 §4.2 rule 5) records a null scope — a non-member can
      // never write rows into a foreign tenant's log.
      if (!membership || !isRole(membership.role)) this.notFound();
      // Attached after membership resolution so a 403 still carries the scope
      // resolved to that point (phase 11 §4.2 rule 5) while non-member 404s
      // stay null-scoped. Authorization is unchanged either way.
      request.project = toResolvedProject(payment.project);
      request.organizationMembership = toResolvedMembership(membership);
      if (!can(membership.role, requirement.capability)) {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
      }
    }
    return true;
  }

  private notFound(): never {
    throw new ApiError(ErrorCode.NOT_FOUND, 'Payment not found', 404);
  }
}
