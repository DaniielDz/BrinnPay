import { Module } from '@nestjs/common';

import { InvitationsAcceptController } from './invitations-accept.controller';
import { OrgRbacGuard } from './org-rbac.guard';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Organizations domain module (phase 4): tenants, memberships, invitations,
 * the role → permission model, and the reusable org-scoped RBAC guard.
 * Session auth comes from the global `AuthModule` (phase 3).
 */
@Module({
  controllers: [OrganizationsController, InvitationsAcceptController],
  providers: [OrganizationsService, OrgRbacGuard],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}