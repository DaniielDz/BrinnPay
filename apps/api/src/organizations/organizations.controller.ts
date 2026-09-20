import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser, type AuthUser } from '../auth/current-user';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ListQueryDto, type CursorPage } from './cursor';
import { InvitationCreateDto } from './dto/invitation-create.dto';
import { MemberRoleDto } from './dto/member-role.dto';
import { OrganizationCreateDto } from './dto/organization-create.dto';
import { OrganizationUpdateDto } from './dto/organization-update.dto';
import { CurrentMembership, type ResolvedMembership } from './membership';
import { OrgRbacGuard, RequireCapability } from './org-rbac.guard';
import {
  OrganizationsService,
  type InvitationResponse,
  type OrganizationMemberResponse,
  type OrganizationResponse,
} from './organizations.service';

const RBAC = () => [SessionAuthGuard, OrgRbacGuard];

/**
 * Organization surface (phase 4 §4.2). All org-scoped routes are guarded by
 * `SessionAuth` + the org-scoped RBAC guard; handlers consume the resolved
 * membership instead of re-deriving it.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @UseGuards(SessionAuthGuard)
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<OrganizationResponse>> {
    return this.organizations.listForUser(user.id, query.limit, query.cursor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionAuthGuard)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: OrganizationCreateDto,
  ): Promise<OrganizationResponse> {
    return this.organizations.create(user.id, dto.name);
  }

  @Get(':organization_id')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'organizations.read' })
  retrieve(@CurrentMembership() membership: ResolvedMembership): Promise<OrganizationResponse> {
    return this.organizations.retrieveById(membership.organization_id);
  }

  @Patch(':organization_id')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'organizations.update' })
  update(
    @CurrentMembership() membership: ResolvedMembership,
    @Body() dto: OrganizationUpdateDto,
  ): Promise<OrganizationResponse> {
    return this.organizations.update(membership.organization_id, dto.name);
  }

  @Delete(':organization_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'organizations.delete' })
  async remove(@CurrentMembership() membership: ResolvedMembership): Promise<void> {
    await this.organizations.delete(membership.organization_id);
  }

  @Get(':organization_id/members')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'members.read' })
  listMembers(
    @CurrentMembership() membership: ResolvedMembership,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<OrganizationMemberResponse>> {
    return this.organizations.listMembers(membership.organization_id, query.limit, query.cursor);
  }

  @Patch(':organization_id/members/:user_id')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'members.update', options: { allowSelf: true } })
  updateMember(
    @CurrentMembership() membership: ResolvedMembership,
    @Param('user_id') userId: string,
    @Body() dto: MemberRoleDto,
  ): Promise<OrganizationMemberResponse> {
    return this.organizations.updateMember(membership.organization_id, membership, userId, dto.role);
  }

  @Delete(':organization_id/members/:user_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'members.remove', options: { allowSelf: true } })
  async removeMember(
    @CurrentMembership() membership: ResolvedMembership,
    @Param('user_id') userId: string,
  ): Promise<void> {
    await this.organizations.removeMember(membership.organization_id, membership, userId);
  }

  @Get(':organization_id/invitations')
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'invitations.read' })
  listInvitations(
    @CurrentMembership() membership: ResolvedMembership,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<InvitationResponse>> {
    return this.organizations.listInvitations(
      membership.organization_id,
      query.limit,
      query.cursor,
    );
  }

  @Post(':organization_id/invitations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'invitations.create' })
  createInvitation(
    @CurrentMembership() membership: ResolvedMembership,
    @Body() dto: InvitationCreateDto,
  ): Promise<InvitationResponse> {
    return this.organizations.createInvitation(
      membership.organization_id,
      membership,
      dto.email,
      dto.role,
    );
  }

  @Delete(':organization_id/invitations/:invitation_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...RBAC())
  @RequireCapability({ capability: 'invitations.cancel' })
  async cancelInvitation(
    @CurrentMembership() membership: ResolvedMembership,
    @Param('invitation_id') invitationId: string,
  ): Promise<void> {
    await this.organizations.cancelInvitation(membership.organization_id, invitationId);
  }
}