import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { CAPABILITIES } from '../organizations/roles';
import { ProjectRbacGuard } from '../projects/project-rbac.guard';
import { CurrentProject, type ResolvedProject } from '../projects/request-project';
import { RateLimit } from '../rate-limiting/rate-limit.decorator';
import { RequestLogListQueryDto } from './dto/request-log-list-query.dto';
import { RequestLogsService, type RequestLogResponse } from './request-logs.service';

const RBAC = () => [SessionAuthGuard, ProjectRbacGuard];

/**
 * `GET /projects/{project_id}/logs/requests` (phase 11 §4.3, `logs.listRequestLogs`).
 *
 * **Session-only by design (F6)**: the Phase 5 api-keys route pattern is reused
 * deliberately instead of the dual-mode `ProjectAccessGuard`, because an `sk_…`
 * API key never carries management/observability authority (phase 1 §7.3). An
 * API-key bearer therefore fails in `SessionAuthGuard` with the same generic
 * 401 an unauthenticated request gets — no capability is evaluated, no record
 * is read.
 *
 * Authorization happens entirely in the guards: unknown or foreign `project_id`
 * → 404 (existence never disclosed), member without `logs.read` → 403. The
 * capability is declared from the registry (`organizations/roles.ts`), not from
 * a string literal (§14).
 */
@Controller('projects/:project_id/logs/requests')
export class RequestLogsController {
  constructor(private readonly requestLogs: RequestLogsService) {}

  @Get()
  @RateLimit('read')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: CAPABILITIES.LOGS_READ })
  list(
    @CurrentProject() project: ResolvedProject,
    @Query() query: RequestLogListQueryDto,
  ): Promise<CursorPage<RequestLogResponse>> {
    return this.requestLogs.list(project.project_id, query);
  }
}
