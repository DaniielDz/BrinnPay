import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

/**
 * API-key domain module (phase 5 §4.1): the key lifecycle (generation,
 * hashing, listing, revocation) and the reusable API-key authentication
 * infrastructure (`ApiKeyAuthGuard`, `ApiKeysService`) shared by all
 * API-key-authenticated routes.
 *
 * The management routes (`/projects/{project_id}/api-keys`) reuse the
 * project-scoped RBAC guard from the projects module; the `ApiKeyAuthGuard`
 * ships with no HTTP consumer until Phase 6 but is exported for those routes.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthGuard],
  exports: [ApiKeysService, ApiKeyAuthGuard],
})
export class ApiKeysModule {}