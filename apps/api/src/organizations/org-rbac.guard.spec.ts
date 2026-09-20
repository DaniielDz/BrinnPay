import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiError } from '../common/errors/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { OrgRbacGuard, RequireCapability } from './org-rbac.guard';
import type { Capability } from './roles';

type Handler = () => void;

const REFLECTOR = new Reflector();

const MEMBER_ROW = {
  id: 'member-1',
  organizationId: '0192f2a0-0000-7000-8000-00000000000a',
  userId: '0192f2a0-0000-7000-8000-000000000008',
  role: 'member',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function contextFor(handler: Handler, params?: Record<string, string>, userId?: string) {
  const request = {
    authUser: { id: userId ?? MEMBER_ROW.userId, email: 'dev@example.com', name: null },
    params,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function decoratedHandler(capability: Capability, options?: { allowSelf?: boolean }): Handler {
  class Stub {
    @RequireCapability({ capability, options })
    run(): void {}
  }
  return Stub.prototype.run;
}

describe('OrgRbacGuard (phase 4 §4.3, D1/D2)', () => {
  let prisma: { organizationMember: { findUnique: jest.Mock } };
  let guard: OrgRbacGuard;

  beforeEach(() => {
    prisma = {
      organizationMember: { findUnique: jest.fn() },
    };
    guard = new OrgRbacGuard(REFLECTOR, prisma as unknown as PrismaService);
  });

  it('loads membership, evaluates the capability, and attaches the resolved membership', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('members.read');

    const request = { authUser: { id: MEMBER_ROW.userId }, params: { organization_id: MEMBER_ROW.organizationId } } as {
      organizationMembership?: unknown;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.organizationMembership).toMatchObject({
      organization_id: MEMBER_ROW.organizationId,
      user_id: MEMBER_ROW.userId,
      role: 'member',
    });
  });

  it('returns 404 NOT_FOUND for a non-member organization (D1)', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    const handler = decoratedHandler('organizations.read');
    const ctx = contextFor(handler, { organization_id: MEMBER_ROW.organizationId });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('returns 404 NOT_FOUND for a malformed organization_id without querying', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('organizations.read');
    const ctx = contextFor(handler, { organization_id: 'not-a-uuid' });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN for a member without the required capability (D1)', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('organizations.delete');
    const ctx = contextFor(handler, { organization_id: MEMBER_ROW.organizationId });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('lets self-targeted actions pass the matrix when allowSelf is set (self-service)', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('members.update', { allowSelf: true });
    const ctx = contextFor(handler, {
      organization_id: MEMBER_ROW.organizationId,
      user_id: MEMBER_ROW.userId,
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('still denies a different target when allowSelf is set but the actor lacks the capability', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('members.update', { allowSelf: true });
    const ctx = contextFor(handler, {
      organization_id: MEMBER_ROW.organizationId,
      user_id: '0192f2a0-0000-7000-8000-000000000099', // someone else
    });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('throws on a route that lacks @RequireCapability (programming error)', async () => {
    const handler = (): void => undefined;
    const ctx = contextFor(handler, { organization_id: MEMBER_ROW.organizationId });

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'OrgRbacGuard requires @RequireCapability on the route handler',
    );
  });

  it('throws when no authenticated user is attached (must run after SessionAuthGuard)', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('members.read');
    const request = { params: { organization_id: MEMBER_ROW.organizationId } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow('OrgRbacGuard used without SessionAuthGuard');
  });

  it('rejects ApiError objects through the canonical envelope', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    const handler = decoratedHandler('organizations.read');
    const ctx = contextFor(handler, { organization_id: MEMBER_ROW.organizationId });

    const error = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});