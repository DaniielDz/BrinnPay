import { Module } from '@nestjs/common';

import { ProjectRbacGuard } from './project-rbac.guard';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Projects domain module (phase 5): project CRUD, the environment model, and
 * the reusable project-scoped RBAC guard (project → owning organization →
 * membership → capability, phase 4 D1 semantics). The api-keys module imports
 * this module to guard the `/projects/{project_id}/api-keys` routes with the
 * same guard.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectRbacGuard],
  exports: [ProjectsService, ProjectRbacGuard],
})
export class ProjectsModule {}