import { Prisma } from '../../generated/prisma/client';
import { type AuthUser } from '../auth/current-user';
import { PrismaService } from '../prisma/prisma.service';
import type { ResolvedMembership } from './membership';
import { OrganizationsService } from './organizations.service';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';

function membership(role: 'owner' | 'admin' | 'member' | 'viewer', userId = 'user-1'): ResolvedMembership {
  return {
    id: 'member-x',
    organization_id: ORG_ID,
    user_id: userId,
    role,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function userRow(overrides: Partial<{ id: string; email: string; name: string | null }> = {}) {
  return {
    id: overrides.id ?? 'user-1',
    email: overrides.email ?? 'dev@example.com',
    name: overrides.name ?? null,
    passwordHash: '$argon2id$hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function memberRow(overrides: Partial<{ id: string; userId: string; role: string; organizationId: string }> = {}) {
  return {
    id: overrides.id ?? 'member-1',
    organizationId: overrides.organizationId ?? ORG_ID,
    userId: overrides.userId ?? 'user-1',
    role: overrides.role ?? 'member',
    createdAt: new Date(),
    updatedAt: new Date(),
    user: userRow({ id: overrides.userId ?? 'user-1' }),
  };
}

function invitationRow(overrides: Partial<{
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  acceptedAt: Date | null;
  canceledAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? 'inv-1',
    organizationId: overrides.organizationId ?? ORG_ID,
    email: overrides.email ?? 'guest@example.com',
    role: overrides.role ?? 'member',
    status: overrides.status ?? 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    acceptedAt: overrides.acceptedAt ?? null,
    canceledAt: overrides.canceledAt ?? null,
  };
}

const ACTOR_EMAIL = 'dev@example.com';

describe('OrganizationsService (phase 4 §4.2, D4/D5/D7/D9)', () => {
  let service: OrganizationsService;
  let prisma: {
    organization: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    organizationMember: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    invitation: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let txn: {
    organization: { create: jest.Mock };
    organizationMember: { create: jest.Mock };
    invitation: { updateMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      organization: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      organizationMember: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      invitation: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    txn = {
      organization: { create: jest.fn() },
      organizationMember: { create: jest.fn() },
      invitation: { updateMany: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof txn) => Promise<unknown>) => fn(txn));

    service = new OrganizationsService(prisma as unknown as PrismaService);
  });

  describe('organizations.create (§4.2, D7)', () => {
    it('creates the organization and an owner membership in ONE transaction', async () => {
      txn.organization.create.mockResolvedValue({ id: 'org-new', name: 'Acme', createdAt: new Date(), updatedAt: new Date() });
      txn.organizationMember.create.mockResolvedValue({ id: 'm' });

      const result = await service.create('user-1', '  Acme  ');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txn.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Acme' }) }),
      );
      expect(txn.organizationMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', role: 'owner' }),
        }),
      );
      expect(result.name).toBe('Acme');
    });

    it('rejects an empty and an over-long name with VALIDATION_ERROR', async () => {
      await expect(service.create('user-1', '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
      await expect(service.create('user-1', 'x'.repeat(201))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    });
  });

  describe('organizations.retrieveById / update / delete (§4.2, D9)', () => {
    it('retrieveById returns the organization; unknown id → 404', async () => {
      prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, name: 'Acme', createdAt: new Date(), updatedAt: new Date() });
      const result = await service.retrieveById(ORG_ID);
      expect(result.id).toBe(ORG_ID);

      prisma.organization.findUnique.mockResolvedValue(null);
      await expect(service.retrieveById(ORG_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('update renames and advances updated_at; absent name is a no-op', async () => {
      const now = new Date();
      prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, name: 'Old', createdAt: now, updatedAt: now });
      prisma.organization.update.mockResolvedValue({ id: ORG_ID, name: 'New', createdAt: now, updatedAt: new Date() });

      const renamed = await service.update(ORG_ID, ' New ');
      expect(renamed.name).toBe('New');
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'New' }) }),
      );

      const noop = await service.update(ORG_ID, undefined);
      expect(noop.name).toBe('Old');
      expect(prisma.organization.update).not.toHaveBeenCalledTimes(2);
    });

    it('update maps a concurrently-deleted organization to 404', async () => {
      prisma.organization.update.mockRejectedValue(knownError('P2025'));
      await expect(service.update(ORG_ID, 'New')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('delete removes the organization (cascade handled by the DB)', async () => {
      prisma.organization.delete.mockResolvedValue({ id: ORG_ID });
      await expect(service.delete(ORG_ID)).resolves.toBeUndefined();
      expect(prisma.organization.delete).toHaveBeenCalledWith({ where: { id: ORG_ID } });
    });

    it('delete maps a concurrently-deleted organization to 404', async () => {
      prisma.organization.delete.mockRejectedValue(knownError('P2025'));
      await expect(service.delete(ORG_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('updateMember (§4.2 updateMember, D4)', () => {
    it('owner changes any member role, including another owner (with other owners present)', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'owner' }));
      prisma.organizationMember.count.mockResolvedValue(2);
      prisma.organizationMember.update.mockResolvedValue(memberRow({ userId: 'user-2', role: 'admin' }));

      const result = await service.updateMember(ORG_ID, membership('owner'), 'user-2', 'admin');
      expect(result.role).toBe('admin');
      expect(prisma.organizationMember.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ role: 'owner' }) }),
      );
    });

    it('admin cannot modify an owner member → 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'owner' }));
      await expect(
        service.updateMember(ORG_ID, membership('admin'), 'user-2', 'member'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('admin cannot grant the owner role → 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'member' }));
      await expect(
        service.updateMember(ORG_ID, membership('admin'), 'user-2', 'owner'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('demoting the last owner → 422 BUSINESS_RULE_VIOLATION', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'owner' }));
      prisma.organizationMember.count.mockResolvedValue(1);
      await expect(
        service.updateMember(ORG_ID, membership('owner'), 'user-1', 'member'),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });
    });

    it('owner self-demotion is allowed while another owner remains', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'owner' }));
      prisma.organizationMember.count.mockResolvedValue(2);
      prisma.organizationMember.update.mockResolvedValue(memberRow({ userId: 'user-1', role: 'admin' }));

      const result = await service.updateMember(ORG_ID, membership('owner'), 'user-1', 'admin');
      expect(result.role).toBe('admin');
    });

    it('owner self no-op is allowed', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'owner' }));
      prisma.organizationMember.update.mockResolvedValue(memberRow({ userId: 'user-1', role: 'owner' }));

      const result = await service.updateMember(ORG_ID, membership('owner'), 'user-1', 'owner');
      expect(result.role).toBe('owner');
    });

    it('member self-demotion downward is allowed', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'member' }));
      prisma.organizationMember.update.mockResolvedValue(memberRow({ userId: 'user-1', role: 'viewer' }));

      const result = await service.updateMember(ORG_ID, membership('member'), 'user-1', 'viewer');
      expect(result.role).toBe('viewer');
    });

    it('member attempting a non-downward self change → 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'member' }));
      await expect(
        service.updateMember(ORG_ID, membership('member'), 'user-1', 'member'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(
        service.updateMember(ORG_ID, membership('viewer'), 'user-1', 'member'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('member cannot promote themselves to owner → 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'member' }));
      await expect(
        service.updateMember(ORG_ID, membership('member'), 'user-1', 'owner'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('unknown target user_id → 404 (no cross-org disclosure)', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      await expect(
        service.updateMember(ORG_ID, membership('owner'), 'ghost-user', 'member'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('removeMember (§4.2 removeMember, D4)', () => {
    it('owner removes any member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'member' }));
      prisma.organizationMember.delete.mockResolvedValue({ id: 'member-1' });

      await expect(service.removeMember(ORG_ID, membership('owner'), 'user-2')).resolves.toBeUndefined();
    });

    it('admin cannot remove an owner member → 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'owner' }));
      await expect(
        service.removeMember(ORG_ID, membership('admin'), 'user-2'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('member self-removal is always allowed', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'member' }));
      prisma.organizationMember.delete.mockResolvedValue({ id: 'member-1' });

      await expect(service.removeMember(ORG_ID, membership('member'), 'user-1')).resolves.toBeUndefined();
    });

    it('removing the last owner (including self-removal) → 422', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-1', role: 'owner' }));
      prisma.organizationMember.count.mockResolvedValue(1);

      await expect(
        service.removeMember(ORG_ID, membership('owner'), 'user-1'),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });
    });

    it('unknown target user_id → 404', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      await expect(
        service.removeMember(ORG_ID, membership('owner'), 'ghost-user'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('createInvitation (§4.2 createInvitation, D5)', () => {
    it('creates a pending invitation with normalized email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.invitation.create.mockResolvedValue(invitationRow({ email: 'guest@example.com' }));

      const result = await service.createInvitation(ORG_ID, membership('owner'), '  GUEST@Example.com ', 'member');
      expect(result).toMatchObject({ email: 'guest@example.com', status: 'pending', role: 'member' });
      expect(prisma.invitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'guest@example.com', status: 'pending' }),
        }),
      );
    });

    it('admin cannot invite an owner → 403', async () => {
      await expect(
        service.createInvitation(ORG_ID, membership('admin'), 'guest@example.com', 'owner'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('inviting an existing member → 409 CONFLICT', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow({ id: 'user-2' }));
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow({ userId: 'user-2', role: 'member' }));

      await expect(
        service.createInvitation(ORG_ID, membership('owner'), 'member@example.com', 'member'),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });

    it('duplicate pending invitation → 409 CONFLICT', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(invitationRow());

      await expect(
        service.createInvitation(ORG_ID, membership('owner'), 'guest@example.com', 'member'),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });

    it('maps a partial-index race (P2002) to 409 CONFLICT', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.invitation.create.mockRejectedValue(knownError('P2002'));

      await expect(
        service.createInvitation(ORG_ID, membership('owner'), 'guest@example.com', 'member'),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });
  });

  describe('cancelInvitation (§4.2 cancelInvitation, D5)', () => {
    it('cancels a pending invitation and records canceled_at', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'pending' }));
      await expect(service.cancelInvitation(ORG_ID, 'inv-1')).resolves.toBeUndefined();
      expect(prisma.invitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'canceled', canceledAt: expect.any(Date) }),
        }),
      );
    });

    it('cancel-canceled is an idempotent no-op (204)', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'canceled' }));
      await expect(service.cancelInvitation(ORG_ID, 'inv-1')).resolves.toBeUndefined();
      expect(prisma.invitation.update).not.toHaveBeenCalled();
    });

    it('canceling an accepted invitation → 422', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'accepted' }));
      await expect(service.cancelInvitation(ORG_ID, 'inv-1')).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
      });
    });

    it('an invitation of another organization → 404', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ organizationId: 'other-org' }));
      await expect(service.cancelInvitation(ORG_ID, 'inv-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('acceptInvitation (§4.2 acceptInvitation, D5/D6)', () => {
    const actor = { id: 'user-1', email: ACTOR_EMAIL, name: null } as AuthUser;

    it('accepts with a matching email and creates membership with the invited role (atomic)', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ email: ACTOR_EMAIL, role: 'admin' }));
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      txn.invitation.updateMany.mockResolvedValue({ count: 1 });
      txn.organizationMember.create.mockResolvedValue(
        memberRow({ role: 'admin', userId: 'user-1' }),
      );

      const result = await service.acceptInvitation(actor, 'inv-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txn.invitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'inv-1', status: 'pending' }),
          data: expect.objectContaining({ status: 'accepted', acceptedAt: expect.any(Date) }),
        }),
      );
      expect(txn.organizationMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', role: 'admin' }),
        }),
      );
      expect(result).toMatchObject({ user_id: 'user-1', role: 'admin' });
    });

    it('hides the invitation from a non-matching email → 404', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ email: 'other@example.com' }));
      await expect(service.acceptInvitation(actor, 'inv-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('returns 404 for an unknown invitation id with the same generic message', async () => {
      prisma.invitation.findUnique.mockResolvedValue(null);
      await expect(service.acceptInvitation(actor, 'unknown')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('rejects accepting a non-pending invitation → 422', async () => {
      prisma.invitation.findUnique.mockResolvedValue(
        invitationRow({ email: ACTOR_EMAIL, status: 'canceled' }),
      );
      await expect(service.acceptInvitation(actor, 'inv-1')).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
      });
    });

    it('rejects acceptance when already a member → 409', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ email: ACTOR_EMAIL }));
      prisma.organizationMember.findUnique.mockResolvedValue(memberRow());
      await expect(service.acceptInvitation(actor, 'inv-1')).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
      });
    });

    it('maps a membership uniqueness race (P2002) to 409', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitationRow({ email: ACTOR_EMAIL }));
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      txn.invitation.updateMany.mockResolvedValue({ count: 1 });
      txn.organizationMember.create.mockRejectedValue(knownError('P2002'));

      await expect(service.acceptInvitation(actor, 'inv-1')).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
      });
    });
  });

  describe('list endpoints (§4.5)', () => {
    it('listForUser returns a paginated page scoped to the caller', async () => {
      prisma.organization.findMany.mockResolvedValue([
        { id: ORG_ID, name: 'Acme', createdAt: new Date(), updatedAt: new Date() },
        { id: 'org-2', name: 'Globex', createdAt: new Date(), updatedAt: new Date() },
      ]);
      const page = await service.listForUser('user-1', 20);
      expect(page.data).toHaveLength(2);
      expect(page.next_cursor).toBeNull();
      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ members: { some: { userId: 'user-1' } } }),
        }),
      );
    });

    it('listMembers projects the member identity (D8)', async () => {
      prisma.organizationMember.findMany.mockResolvedValue([
        memberRow({ userId: 'user-1', role: 'owner' }),
      ]);
      const page = await service.listMembers(ORG_ID, 20);
      expect(page.data[0]).toMatchObject({
        user_id: 'user-1',
        role: 'owner',
        user: { id: 'user-1' },
      });
    });

    it('listInvitations covers all statuses', async () => {
      prisma.invitation.findMany.mockResolvedValue([
        invitationRow({ status: 'pending' }),
        invitationRow({ status: 'accepted', acceptedAt: new Date() }),
        invitationRow({ status: 'canceled', canceledAt: new Date() }),
      ]);
      const page = await service.listInvitations(ORG_ID, 20);
      expect(page.data.map((i) => i.status)).toEqual(['pending', 'accepted', 'canceled']);
    });
  });
});