import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { type PublicUser } from '../auth/current-user';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from './cursor';
import { type ResolvedMembership } from './membership';
import { can, isDownward, type Role } from './roles';

/** `Organization` as contracted (D7/D8). */
export interface OrganizationResponse {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** `OrganizationMember` as contracted (D8): carries the member identity. */
export interface OrganizationMemberResponse {
  id: string;
  organization_id: string;
  user_id: string;
  role: Role;
  created_at: Date;
  updated_at: Date;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

export type InvitationStatus = 'pending' | 'accepted' | 'canceled';

/** `Invitation` as contracted (D8): lifecycle timestamps are exposed. */
export interface InvitationResponse {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  canceled_at: Date | null;
}

const ORGANIZATION_NOT_FOUND = () =>
  new ApiError(ErrorCode.NOT_FOUND, 'Organization not found', 404);
const MEMBER_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Member not found', 404);

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/**
 * Organizations domain service (phase 4). Owns organization, membership, and
 * invitation persistence and rules; the RBAC guard already resolved the
 * caller's membership, so this layer enforces target restrictions and business
 * invariants (last-owner, owner-granting, invitation lifecycle) — never tenant
 * scoping, which belongs to the guard.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------

  async listForUser(userId: string, limit: number = DEFAULT_LIST_LIMIT, cursor?: string): Promise<CursorPage<OrganizationResponse>> {
    const rows = await this.prisma.organization.findMany({
      where: {
        members: { some: { userId } },
        ...(cursorToWhere(cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toOrganizationResponse), limit);
  }

  /**
   * Create (§4.2): organization + creator's `owner` membership in one
   * transaction. The creator is always the initial owner (phase 3 D5 / ADR-0010
   * for additional orgs).
   */
  async create(userId: string, name: string): Promise<OrganizationResponse> {
    const validatedName = this.validateName(name);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          id: uuidv7(),
          name: validatedName,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.organizationMember.create({
        data: {
          id: uuidv7(),
          organizationId: organization.id,
          userId,
          role: 'owner',
          createdAt: now,
          updatedAt: now,
        },
      });
      return toOrganizationResponse(organization);
    });
  }

  /** Retrieve (§4.2): membership was already verified by the RBAC guard. */
  async retrieveById(organizationId: string): Promise<OrganizationResponse> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization) {
      throw ORGANIZATION_NOT_FOUND();
    }
    return toOrganizationResponse(organization);
  }

  async update(organizationId: string, name?: string): Promise<OrganizationResponse> {
    if (name === undefined) {
      // Partial update: no field provided → no-op returning the current state.
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });
      if (!organization) {
        throw ORGANIZATION_NOT_FOUND();
      }
      return toOrganizationResponse(organization);
    }

    const validatedName = this.validateName(name);
    try {
      const organization = await this.prisma.organization.update({
        where: { id: organizationId },
        data: { name: validatedName, updatedAt: new Date() },
      });
      return toOrganizationResponse(organization);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw ORGANIZATION_NOT_FOUND();
      }
      throw error;
    }
  }

  /**
   * Delete (§4.2, D9): owner-only (guard); the DB cascades the tenant-scoped
   * rows that exist in this phase — `organization_members` and `invitations`.
   * Deleting the acting owner's last organization is allowed (ADR-0010
   * guarantees a default tenant at registration, not forever).
   */
  async delete(organizationId: string): Promise<void> {
    try {
      await this.prisma.organization.delete({ where: { id: organizationId } });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw ORGANIZATION_NOT_FOUND();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async listMembers(
    organizationId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    cursor?: string,
  ): Promise<CursorPage<OrganizationMemberResponse>> {
    const rows = await this.prisma.organizationMember.findMany({
      where: {
        organizationId,
        ...(cursorToWhere(cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: { user: true },
    });
    return buildCursorPage(rows.map(toMemberResponse), limit);
  }

  /**
   * Update member role (§4.2, D4). The guard resolved membership and passes
   * self-service through; this layer applies the target restrictions, the
   * owner-granting rule, the last-owner invariant, and the self-demotion rule.
   */
  async updateMember(
    organizationId: string,
    actor: ResolvedMembership,
    targetUserId: string,
    newRole: Role,
  ): Promise<OrganizationMemberResponse> {
    const target = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
      include: { user: true },
    });
    if (!target) {
      throw MEMBER_NOT_FOUND();
    }

    const isSelf = target.userId === actor.user_id;

    if (!isSelf) {
      // Managed change: the actor must hold `members.update` (owner/admin).
      if (!can(actor.role, 'members.update')) {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
      }
      // target restrictions (D4)
      if (target.role === 'owner' && actor.role !== 'owner') {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Only owners can modify owner members', 403);
      }
      if (newRole === 'owner' && actor.role !== 'owner') {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Only owners can grant the owner role', 403);
      }
    } else {
      // Self-service (D4)
      if (newRole === 'owner' && actor.role !== 'owner') {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Only owners can grant the owner role', 403);
      }
      if (actor.role !== 'owner' && actor.role !== 'admin' && !isDownward(actor.role, newRole)) {
        // member/viewer without `members.update`: self-demotion only.
        // (Admins may demote themselves freely; granting owner was rejected above.)
        throw new ApiError(ErrorCode.FORBIDDEN, 'Self-demotion only lowers your role', 403);
      }
    }

    if (target.role === 'owner' && newRole !== 'owner') {
      await this.assertOwnerRemains(organizationId);
    }

    const member = await this.prisma.organizationMember.update({
      where: { id: target.id },
      data: { role: newRole, updatedAt: new Date() },
      include: { user: true },
    });
    return toMemberResponse(member);
  }

  /**
   * Remove member (§4.2, D4): admins manage non-`owner` members only; owners
   * may remove anyone; self-removal is always permitted (subject to the
   * last-owner invariant).
   */
  async removeMember(
    organizationId: string,
    actor: ResolvedMembership,
    targetUserId: string,
  ): Promise<void> {
    const target = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
    });
    if (!target) {
      throw MEMBER_NOT_FOUND();
    }

    const isSelf = target.userId === actor.user_id;

    if (!isSelf) {
      if (!can(actor.role, 'members.remove')) {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
      }
      if (target.role === 'owner' && actor.role !== 'owner') {
        throw new ApiError(ErrorCode.FORBIDDEN, 'Only owners can remove owner members', 403);
      }
    }

    if (target.role === 'owner') {
      await this.assertOwnerRemains(organizationId);
    }

    await this.prisma.organizationMember.delete({ where: { id: target.id } });
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  async listInvitations(
    organizationId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    cursor?: string,
  ): Promise<CursorPage<InvitationResponse>> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        organizationId,
        ...(cursorToWhere(cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toInvitationResponse), limit);
  }

  /**
   * Create invitation (§4.2, D5): normalized email; `role: owner` requires the
   * actor to be an `owner`; conflicts: existing member or an already-pending
   * invitation for the email (409). The partial unique index is the DB guard.
   */
  async createInvitation(
    organizationId: string,
    actor: ResolvedMembership,
    email: string,
    role: Role,
  ): Promise<InvitationResponse> {
    const normalizedEmail = this.normalizeEmail(email);

    if (!can(actor.role, 'invitations.create')) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }
    if (role === 'owner' && actor.role !== 'owner') {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Only owners can invite new owners', 403);
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: existingUser.id },
        },
      });
      if (membership) {
        throw new ApiError(ErrorCode.CONFLICT, 'This user is already a member', 409);
      }
    }

    const pending = await this.prisma.invitation.findFirst({
      where: { organizationId, email: normalizedEmail, status: 'pending' },
    });
    if (pending) {
      throw new ApiError(ErrorCode.CONFLICT, 'A pending invitation exists for this email', 409);
    }

    const now = new Date();
    try {
      const invitation = await this.prisma.invitation.create({
        data: {
          id: uuidv7(),
          organizationId,
          email: normalizedEmail,
          role,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      });
      return toInvitationResponse(invitation);
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new ApiError(ErrorCode.CONFLICT, 'A pending invitation exists for this email', 409);
      }
      throw error;
    }
  }

  /**
   * Cancel invitation (§4.2, D5): pending → canceled (204); already-canceled
   * → 204 (idempotent no-op); accepted → 422 (historical record).
   */
  async cancelInvitation(organizationId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.organizationId !== organizationId) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Invitation not found', 404);
    }

    if (invitation.status === 'accepted') {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'An accepted invitation cannot be canceled',
        422,
      );
    }

    if (invitation.status === 'pending') {
      const now = new Date();
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'canceled', canceledAt: now, updatedAt: now },
      });
    }
  }

  /**
   * Accept invitation (§4.2, D5/D6): the only org endpoint a non-member can
   * use. Email binding hides the invitation's existence from non-matching
   * accounts (404 with a generic message). Accept marks the invitation
   * `accepted` and creates the membership atomically.
   */
  async acceptInvitation(actor: PublicUser, invitationId: string): Promise<OrganizationMemberResponse> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation || invitation.email !== actor.email) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Invitation not found', 404);
    }
    if (invitation.status !== 'pending') {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'This invitation is no longer pending',
        422,
      );
    }

    const existing = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: actor.id },
      },
    });
    if (existing) {
      throw new ApiError(ErrorCode.CONFLICT, 'You are already a member', 409);
    }

    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.invitation.updateMany({
          where: { id: invitation.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: now, updatedAt: now },
        });
        if (updated.count !== 1) {
          // Concurrent accept (or state change between check and transaction).
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'This invitation is no longer pending',
            422,
          );
        }
        const member = await tx.organizationMember.create({
          data: {
            id: uuidv7(),
            organizationId: invitation.organizationId,
            userId: actor.id,
            role: invitation.role as Role,
            createdAt: now,
            updatedAt: now,
          },
          include: { user: true },
        });
        return toMemberResponse(member);
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        // Race: the user became a member between the check and the create.
        throw new ApiError(ErrorCode.CONFLICT, 'You are already a member', 409);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private validateName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Organization name must not be empty'] }],
      });
    }
    if (trimmed.length > 200) {
      throw ApiError.validation({
        fields: [{ field: 'name', errors: ['Organization name must be at most 200 characters'] }],
      });
    }
    return trimmed;
  }

  /**
   * Last-owner invariant (D4): a demotion/removal is only allowed while at
   * least one `owner` member remains in the organization.
   */
  private async assertOwnerRemains(organizationId: string): Promise<void> {
    const ownerCount = await this.prisma.organizationMember.count({
      where: { organizationId, role: 'owner' },
    });
    if (ownerCount <= 1) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'An organization must keep at least one owner',
        422,
      );
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Mappers (snake_case contract projections; UTC timestamps pass through as-is)
// ---------------------------------------------------------------------------

function toOrganizationResponse(
  organization: { id: string; name: string; createdAt: Date; updatedAt: Date },
): OrganizationResponse {
  return {
    id: organization.id,
    name: organization.name,
    created_at: organization.createdAt,
    updated_at: organization.updatedAt,
  };
}

function toMemberResponse(
  member: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    createdAt: Date;
    updatedAt: Date;
    user: { id: string; email: string; name: string | null };
  },
): OrganizationMemberResponse {
  return {
    id: member.id,
    organization_id: member.organizationId,
    user_id: member.userId,
    role: member.role as Role,
    created_at: member.createdAt,
    updated_at: member.updatedAt,
    user: {
      id: member.user.id,
      email: member.user.email,
      name: member.user.name,
    },
  };
}

function toInvitationResponse(invitation: {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  canceledAt: Date | null;
}): InvitationResponse {
  return {
    id: invitation.id,
    organization_id: invitation.organizationId,
    email: invitation.email,
    role: invitation.role as Role,
    status: invitation.status as InvitationStatus,
    created_at: invitation.createdAt,
    updated_at: invitation.updatedAt,
    accepted_at: invitation.acceptedAt,
    canceled_at: invitation.canceledAt,
  };
}