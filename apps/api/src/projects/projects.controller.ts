import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser, type AuthUser } from '../auth/current-user';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ListQueryDto, type CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { ProjectCreateDto } from './dto/project-create.dto';
import { ProjectUpdateDto } from './dto/project-update.dto';
import { CurrentProject, type ResolvedProject } from './request-project';
import { ProjectRbacGuard } from './project-rbac.guard';
import { ProjectsService, type ProjectResponse } from './projects.service';

const RBAC = () => [SessionAuthGuard, ProjectRbacGuard];

/**
 * Project surface (phase 5 §4.2). `projects.list` and `projects.create` carry
 * no `project_id` in the path: the list is inherently scoped to the caller's
 * memberships, and create resolves the target organization from the body in
 * the service. All `{project_id}` routes are guarded by session auth + the
 * project-scoped RBAC guard with phase 4 D1 semantics (non-member → 404,
 * member without capability → 403).
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @UseGuards(SessionAuthGuard)
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<ProjectResponse>> {
    return this.projects.listForUser(user.id, query.limit, query.cursor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionAuthGuard)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: ProjectCreateDto,
  ): Promise<ProjectResponse> {
    return this.projects.create(user, dto.organization_id, dto.name);
  }

  @Get(':project_id')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'projects.read' })
  retrieve(@CurrentProject() project: ResolvedProject): Promise<ProjectResponse> {
    return this.projects.retrieve(project.project_id);
  }

  @Patch(':project_id')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'projects.update' })
  update(
    @CurrentProject() project: ResolvedProject,
    @Body() dto: ProjectUpdateDto,
  ): Promise<ProjectResponse> {
    return this.projects.update(project.project_id, dto.name);
  }

  @Delete(':project_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'projects.delete' })
  async remove(@CurrentProject() project: ResolvedProject): Promise<void> {
    await this.projects.delete(project.project_id);
  }
}