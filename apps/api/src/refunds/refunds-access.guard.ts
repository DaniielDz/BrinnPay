import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { isUuidLike } from '../projects/projects.service';
import { toResolvedProject, type ResolvedProject } from '../projects/request-project';
import {
  DualModeAccessGuard,
  type DualModeRequest,
} from '../common/project-scope/dual-mode-access.guard';

/**
 * The payment-nested dual-mode access boundary for the refund routes
 * (phase 9 §4.3/§38). The contract mounts refunds at
 * `/payments/{payment_id}/refunds` — not under a project path — so the tenant
 * target is resolved from the parent payment; this is the only difference
 * from `ProjectAccessGuard`. All dual-mode authorization semantics (mode
 * detection, delegation, membership, capability, 404/403 non-disclosure)
 * live in the shared {@link DualModeAccessGuard} (phase 18 D1).
 *
 * Both path IDs are authorized against the resolved parent before anything is
 * revealed (phase 9 §38): unknown and cross-scope payment IDs have the same
 * 404 response, and an API key may address only payments in its own project
 * **and** environment.
 */
@Injectable()
export class RefundsAccessGuard extends DualModeAccessGuard {
  constructor(
    reflector: Reflector,
    prisma: PrismaService,
    apiKeyAuth: ApiKeyAuthGuard,
    sessionAuth: SessionAuthGuard,
  ) {
    super(reflector, prisma, apiKeyAuth, sessionAuth, 'RefundsAccessGuard', 'Payment');
  }

  /**
   * API-key mode: the parent payment must belong to the key's project and
   * environment (phase 9 §38 — both, because the refund inherits both from
   * the payment). Any other payment is indistinguishable from a non-existent
   * one (404).
   */
  protected async authorizeApiKeyMode(request: DualModeRequest): Promise<void> {
    const payment = await this.loadParentPayment(request);
    if (
      !request.apiKey ||
      request.apiKey.project_id !== payment.projectId ||
      request.apiKey.environment !== payment.environment
    ) {
      this.notFound();
    }
  }

  /**
   * Session mode: resolve the parent payment's project — the membership and
   * capability checks apply against that organization (phase 9 §38), with no
   * path project ID on these routes.
   */
  protected async resolveSessionProject(request: DualModeRequest): Promise<ResolvedProject> {
    const payment = await this.loadParentPayment(request);
    return toResolvedProject(payment.project);
  }

  private async loadParentPayment(request: DualModeRequest) {
    const paymentId = request.params?.payment_id;
    if (!paymentId || !isUuidLike(paymentId)) this.notFound();
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { project: true },
    });
    if (!payment) this.notFound();
    return payment;
  }
}
