import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser, type AuthUser } from '../auth/current-user';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { OrganizationsService, type OrganizationMemberResponse } from './organizations.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Invitation acceptance (phase 4 §4.2, D5/D6). The only org endpoint a
 * non-member can use: session-authenticated, bound to the caller's normalized
 * email, and never revealing an invitation's existence to non-matching users.
 * `/invitations/{invitation_id}/accept` lives outside `/organizations` in the
 * contract, hence this separate controller.
 */
@Controller('invitations')
export class InvitationsAcceptController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post(':invitation_id/accept')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionAuthGuard)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('invitation_id') invitationId: string,
  ): Promise<OrganizationMemberResponse> {
    // A malformed ID cannot identify a real invitation; the same generic
    // 404 the service returns for unknown/mismatched invitations (D6).
    if (!UUID_PATTERN.test(invitationId)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Invitation not found', 404);
    }
    return this.organizations.acceptInvitation(user, invitationId);
  }
}