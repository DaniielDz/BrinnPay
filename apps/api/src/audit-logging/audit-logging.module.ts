import { Module } from '@nestjs/common';

import { OrganizationsModule } from '../organizations/organizations.module';
import { AuditLoggingCoreModule } from './audit-logging-core.module';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

/**
 * The audit-logging capability (phase 12 §4.1): capture, persistence, and the
 * contracted read surface.
 *
 * Three responsibilities, one module (§4.1):
 *
 * 1. **Capture** — domain modules trigger it through {@link AuditLoggingCoreModule}'s
 *    port; this module never intercepts HTTP responses (§4.2 rule 1).
 * 2. **Persistence** — {@link AuditLoggingCoreModule} owns the `audit_log_entries`
 *    rows, written in the audited change's own transaction (§6.2).
 * 3. **Read surface** — {@link AuditLogsController} serves the session-only
 *    `logs.listAuditLogs` operation.
 *
 * `OrganizationsModule` is imported so Nest can resolve the org-scoped RBAC
 * guard in this controller's context — the same convention ApiKeysModule uses
 * by importing ProjectsModule for `ProjectRbacGuard`.
 */
@Module({
  imports: [AuditLoggingCoreModule, OrganizationsModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLoggingCoreModule],
})
export class AuditLoggingModule {}
