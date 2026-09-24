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
  UseGuards,
} from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ListQueryDto, type CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { ProjectRbacGuard } from '../projects/project-rbac.guard';
import { CurrentProject, type ResolvedProject } from '../projects/request-project';
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
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.read' })
  list(
    @CurrentProject() project: ResolvedProject,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<ApiKeyResponse>> {
    return this.apiKeys.list(project.project_id, query.limit, query.cursor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.create' })
  create(
    @CurrentProject() project: ResolvedProject,
    @Body() dto: ApiKeyCreateDto,
  ): Promise<ApiKeyCreatedResponse> {
    return this.apiKeys.create(project.project_id, dto.environment);
  }

  @Delete(':api_key_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'apiKeys.revoke' })
  async revoke(
    @CurrentProject() project: ResolvedProject,
    @Param('api_key_id') apiKeyId: string,
  ): Promise<void> {
    await this.apiKeys.revoke(project.project_id, apiKeyId);
  }
}