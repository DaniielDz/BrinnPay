import { Global, Module } from '@nestjs/common';

import { ApiKeysModule } from '../../api-keys/api-keys.module';
import { ProjectAccessGuard } from './project-access.guard';

/**
 * The shared project-scoped dual-mode access boundary (phase 10 §14).
 *
 * `global` because every domain module that owns `/projects/{project_id}/…`
 * routes needs the same guard, and the guard's own dependencies
 * (`ApiKeyAuthGuard`, `PrismaService`, the session boundary provided globally by
 * the auth module) are already global or exported. The scope decorator is a
 * plain parameter decorator and needs no provider.
 */
@Global()
@Module({
  imports: [ApiKeysModule],
  providers: [ProjectAccessGuard],
  exports: [ProjectAccessGuard],
})
export class ProjectScopeModule {}
