import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RequireCapability } from '../organizations/org-rbac.guard';
import type { Capability } from '../organizations/roles';
import { CustomersAccessGuard } from './customers-access.guard';

type Handler = () => void;

const REFLECTOR = new Reflector();

const USER_ID = '0192f2a0-0000-7000-8000-000000000008';
const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const API_KEY = 'sk_live_customers-guard-fixture';

const PROJECT_ROW = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  name: 'Payments API',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MEMBER_ROW = {
  id: 'member-1',
  organizationId: ORG_ID,
  userId: USER_ID,
  role: 'member',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function decoratedHandler(capability: Capability): Handler {
  class Stub {
    @RequireCapability({ capability })
    run(): void {}
  }
  return Stub.prototype.run;
}

interface Mocks {
  apiKeyAuth: { canActivate: jest.Mock };
  sessionAuth: { canActivate: jest.Mock };
}

function setup(prisma: {
  project: { findUnique: jest.Mock };
  organizationMember: { findUnique: jest.Mock };
}): { guard: CustomersAccessGuard; mocks: Mocks } {
  const mocks: Mocks = {
    apiKeyAuth: { canActivate: jest.fn() },
    sessionAuth: { canActivate: jest.fn() },
  };
  const guard = new CustomersAccessGuard(
    REFLECTOR,
    prisma as unknown as PrismaService,
    mocks.apiKeyAuth as unknown as ApiKeyAuthGuard,
    mocks.sessionAuth as unknown as SessionAuthGuard,
  );
  return { guard, mocks };
}

function contextFor(
  handler: Handler,
  params: Record<string, string>,
  authorization?: string,
) {
  const request: Record<string, unknown> = { headers: {}, params };
  if (authorization !== undefined) {
    request.headers = { authorization };
  }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('CustomersAccessGuard (phase 6 §4.3, D8)', () => {
  let prisma: {
    project: { findUnique: jest.Mock };
    organizationMember: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      project: { findUnique: jest.fn() },
      organizationMember: { findUnique: jest.fn() },
    };
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'admin' });
  });

  describe('API-key mode (sk_… token)', () => {
    it('delegates to ApiKeyAuthGuard and accepts the key’s own project (no RBAC queries)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.apiKeyAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { apiKey?: unknown };
        req.apiKey = { key_id: 'key-1', project_id: PROJECT_ID, environment: 'live' };
        return true;
      });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: PROJECT_ID }, `Bearer ${API_KEY}`)),
      ).resolves.toBe(true);

      expect(mocks.apiKeyAuth.canActivate).toHaveBeenCalledTimes(1);
      expect(mocks.sessionAuth.canActivate).not.toHaveBeenCalled();
      // No membership/capability evaluation in API-key mode (D6).
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a path project that is not the key’s project with 404 (non-disclosure)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.apiKeyAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { apiKey?: unknown };
        req.apiKey = { key_id: 'key-1', project_id: PROJECT_ID, environment: 'live' };
        return true;
      });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: '0192f2a0-0000-7000-8000-0000000000dd' }, `Bearer ${API_KEY}`)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('rejects a malformed project_id with 404', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.apiKeyAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { apiKey?: unknown };
        req.apiKey = { key_id: 'key-1', project_id: PROJECT_ID, environment: 'live' };
        return true;
      });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: 'not-a-uuid' }, `Bearer ${API_KEY}`)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('lets an API key with any capability requirement pass (capability not evaluated, D6)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.apiKeyAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { apiKey?: unknown };
        req.apiKey = { key_id: 'key-1', project_id: PROJECT_ID, environment: 'live' };
        return true;
      });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.delete'), { project_id: PROJECT_ID }, `Bearer ${API_KEY}`)),
      ).resolves.toBe(true);
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('session mode (JWT or absent/foreign token)', () => {
    function attachSession(mocks: Mocks): void {
      mocks.sessionAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { authUser?: unknown };
        req.authUser = { id: USER_ID, email: 'dev@example.com', name: null };
        return true;
      });
    }

    it('delegates to SessionAuthGuard and evaluates the route capability (attaches both contexts)', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);

      const request = { headers: { authorization: 'Bearer some.jwt.token' }, params: { project_id: PROJECT_ID } } as {
        organizationMembership?: unknown;
        project?: unknown;
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => decoratedHandler('customers.create'),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(mocks.apiKeyAuth.canActivate).not.toHaveBeenCalled();
      expect(request.organizationMembership).toMatchObject({
        organization_id: ORG_ID,
        user_id: USER_ID,
        role: 'admin',
      });
      expect(request.project).toMatchObject({ project_id: PROJECT_ID, organization_id: ORG_ID });
    });

    it('returns 403 for a member without the required capability', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'viewer' });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.create'), { project_id: PROJECT_ID }, 'Bearer some.jwt.token')),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('returns 404 for a non-member of the owning organization (no disclosure)', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: PROJECT_ID }, 'Bearer some.jwt.token')),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('returns 404 for an unknown project without checking membership', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: PROJECT_ID }, 'Bearer some.jwt.token')),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });

    it('returns 404 for a malformed project_id without querying the DB', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: 'not-a-uuid' }, 'Bearer some.jwt.token')),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
    });

    it('treats a missing Authorization header as session mode (401 from SessionAuthGuard)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.sessionAuth.canActivate.mockRejectedValue({ code: 'UNAUTHENTICATED', status: 401 });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: PROJECT_ID })),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(mocks.apiKeyAuth.canActivate).not.toHaveBeenCalled();
    });

    it('throws when the delegated session guard did not attach a user (programming error)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.sessionAuth.canActivate.mockResolvedValue(true);

      await expect(
        guard.canActivate(contextFor(decoratedHandler('customers.read'), { project_id: PROJECT_ID }, 'Bearer some.jwt.token')),
      ).rejects.toThrow('CustomersAccessGuard used without SessionAuthGuard');
    });
  });

  it('throws on a route that lacks @RequireCapability (programming error)', async () => {
    const { guard } = setup(prisma);
    const handler = (): void => undefined;

    await expect(
      guard.canActivate(contextFor(handler, { project_id: PROJECT_ID }, `Bearer ${API_KEY}`)),
    ).rejects.toThrow('CustomersAccessGuard requires @RequireCapability on the route handler');
  });
});