import { Module } from '@nestjs/common';

import { AuditLoggingCoreModule } from '../audit-logging/audit-logging-core.module';
import { InvitationsAcceptController } from './invitations-accept.controller';
import { OrgRbacGuard } from './org-rbac.guard';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Organizations domain module (phase 4): tenants, memberships, invitations,
 * the role → permission model, and the reusable org-scoped RBAC guard.
 * Session auth comes from the global `AuthModule` (phase 3).
 *
 * `OrgRbacGuard` is exported so a controller declared in another module (the
 * phase 12 `AuditLogsController`) can `@UseGuards` it: Nest resolves a
 * controller's guards in the declaring module's context — the same reason
 * `ProjectsModule` exports `ProjectRbacGuard`.
 *
 * AuditLoggingCoreModule (phase 12 §5.3) supplies the audit capture port:
 * invitation/membership changes and their entries share one transaction
 * (§6.2, D7).
 */
@Module({
  imports: [AuditLoggingCoreModule],
  controllers: [OrganizationsController, InvitationsAcceptController],
  providers: [OrganizationsService, OrgRbacGuard],
  exports: [OrganizationsService, OrgRbacGuard],
})
export class OrganizationsModule {}