import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
// `ListQueryDto` must be a **value** import: Nest's `design:paramtypes`
// metadata needs the runtime class, otherwise the global validation pipe sees
// `Object`, skips validation and the raw query string reaches the service.
import { ListQueryDto, type CursorPage } from '../organizations/cursor';
import { CurrentMembership, type ResolvedMembership } from '../organizations/membership';
import { OrgRbacGuard, RequireCapability } from '../organizations/org-rbac.guard';
import { CAPABILITIES } from '../organizations/roles';
import { AuditLogsService, type AuditLogEntryResponse } from './audit-logs.service';

const RBAC = () => [SessionAuthGuard, OrgRbacGuard];

/**
 * `GET /organizations/{organization_id}/logs/audit` (phase 12 §4.3,
 * `logs.listAuditLogs`).
 *
 * **Session-only by design**: the Phase 4 org-route pattern is reused instead
 * of the dual-mode `ProjectAccessGuard`, because `docs/api-conventions.md` §3
 * puts `logs/*` on session authority — an `sk_…` bearer therefore fails in
 * `SessionAuthGuard` with the same generic 401 an unauthenticated request
 * gets, before any capability or row is considered.
 *
 * Authorization happens entirely in the guards: malformed or foreign
 * `organization_id` → 404 (existence never disclosed), member without
 * `logs.read` → 403 (under the D3 matrix every role holds it, so the branch
 * is proven at guard-unit level). The capability is declared from the registry
 * (`organizations/roles.ts`), never from a string literal, and the handler
 * lists the organization the guard resolved — not the raw path parameter — so
 * a cursor can only ever address the authorized tenant's rows.
 */
@Controller('organizations/:organization_id/logs/audit')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @UseGuards(...RBAC())
  @RequireCapability({ capability: CAPABILITIES.LOGS_READ })
  list(
    @CurrentMembership() membership: ResolvedMembership,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<AuditLogEntryResponse>> {
    return this.auditLogs.list(membership.organization_id, query);
  }
}
