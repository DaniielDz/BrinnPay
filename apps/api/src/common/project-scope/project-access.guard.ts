import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { toResolvedProject, type ResolvedProject } from '../../projects/request-project';
import {
  DualModeAccessGuard,
  type DualModeRequest,
} from './dual-mode-access.guard';

/** Matches `format: uuid` semantics (ADR-0001 IDs are UUIDv7, but the contract
 *  declares plain `uuid`); anything else is treated as a non-existent project. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shared project-scoped, dual-mode access boundary (phase 10 §14; phase 18
 * D1 — the single implementation every dual-mode route family uses).
 *
 * Route families nested under `/projects/{project_id}/…` (webhooks, payments,
 * customers) resolve their tenant target from the path `project_id`:
 *
 * - **API-key mode** — the path `project_id` must be the key's project. A
 *   malformed id or any other project is indistinguishable from a
 *   non-existent one (404 — the key never reveals foreign projects). No
 *   database lookup happens in this mode.
 * - **Session mode** — the project is loaded by path id (unknown → 404) and
 *   the phase 5 project-scoped RBAC semantics apply (non-member of the owning
 *   organization → 404; member without the route's capability → 403).
 *
 * The dual-mode authorization semantics themselves live in
 * {@link DualModeAccessGuard}; the payment-nested refunds surface
 * (`RefundsAccessGuard`) is the only other subclass and exists because the
 * contract nests it under `/payments/{payment_id}/refunds` (phase 9 §38).
 */
@Injectable()
export class ProjectAccessGuard extends DualModeAccessGuard {
  constructor(
    reflector: Reflector,
    prisma: PrismaService,
    apiKeyAuth: ApiKeyAuthGuard,
    sessionAuth: SessionAuthGuard,
  ) {
    super(reflector, prisma, apiKeyAuth, sessionAuth, 'ProjectAccessGuard', 'Project');
  }

  /**
   * API-key mode: the path `project_id` must be the key's project. A malformed
   * id or any other project is indistinguishable from a non-existent one.
   */
  protected async authorizeApiKeyMode(request: DualModeRequest): Promise<void> {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    if (!request.apiKey || request.apiKey.project_id !== projectId) {
      this.notFound();
    }
  }

  /**
   * Session mode: resolve the path project (phase 5 §4.1/D2 semantics —
   * malformed/unknown project → 404, before any membership lookup).
   */
  protected async resolveSessionProject(request: DualModeRequest): Promise<ResolvedProject> {
    const projectId = request.params?.project_id;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) {
      this.notFound();
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      this.notFound();
    }
    return toResolvedProject(project);
  }
}
