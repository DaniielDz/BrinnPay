import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser, type AuthUser } from '../auth/current-user';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { userActor } from '../audit-logging/audit-scope';
import { ListQueryDto, type CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { ProjectRbacGuard } from '../projects/project-rbac.guard';
import { CurrentProject, type ResolvedProject } from '../projects/request-project';
import { resolveRequestId } from '../request-id/request-id';
import { RateLimit } from '../rate-limiting/rate-limit.decorator';
import {
  ApiKeysService,
  type ApiKeyCreatedResponse,
  type ApiKeyResponse,
} from './api-keys.service';
import { ApiKeyCreateDto } from './dto/api-key-create.dto';

const RBAC = () => [SessionAuthGuard, ProjectRbacGuard];

/**
 * API-key surface (phase 5 §4.2) — session-authenticated management routes
 * nested under the addressed project. Session-only: API keys never carry
 * management authority (phase 1 §7.3). The project-scoped guard resolves the
 * owning organization and the caller's membership, so non-members receive 404
 * and members without the required capability receive 403.
 */
@Controller('projects/:project_id/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @RateLimit('read')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.read' })
  list(
    @CurrentProject() project: ResolvedProject,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<ApiKeyResponse>> {
    return this.apiKeys.list(project.project_id, query.limit, query.cursor);
  }

  @Post()
  @RateLimit('write')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.create' })
  create(
    @CurrentProject() project: ResolvedProject,
    @CurrentUser() user: AuthUser,
    @Body() dto: ApiKeyCreateDto,
    @Req() request: { id?: unknown },
  ): Promise<ApiKeyCreatedResponse> {
    // Session-only route, so the audit actor is always the acting user (§5.5).
    return this.apiKeys.create(project, dto.environment, {
      actor: userActor(user.id),
      request_id: resolveRequestId(request),
    });
  }

  @Delete(':api_key_id')
  @RateLimit('write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.revoke' })
  async revoke(
    @CurrentProject() project: ResolvedProject,
    @CurrentUser() user: AuthUser,
    @Param('api_key_id') apiKeyId: string,
    @Req() request: { id?: unknown },
  ): Promise<void> {
    await this.apiKeys.revoke(project, apiKeyId, {
      actor: userActor(user.id),
      request_id: resolveRequestId(request),
    });
  }
}