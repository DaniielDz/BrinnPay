import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RequireCapability } from '../organizations/org-rbac.guard';
import type { Capability } from '../organizations/roles';
import { RefundsAccessGuard } from './refunds-access.guard';

type Handler = () => void;

const REFLECTOR = new Reflector();

const USER_ID = '0192f2a0-0000-7000-8000-000000000008';
const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const PAYMENT_ID = '0192f2a0-0000-7000-8000-0000000000c1';
const OTHER_PAYMENT_ID = '0192f2a0-0000-7000-8000-0000000000dd';
const API_KEY = 'sk_live_refunds-guard-fixture';

const PAYMENT_ROW = {
  id: PAYMENT_ID,
  projectId: PROJECT_ID,
  environment: 'test',
  amount: 1000n,
  currency: 'usd',
  status: 'succeeded',
  customerId: '0192f2a0-0000-7000-8000-0000000000e1',
  description: null,
  failureCode: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: 'Payments API',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
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
  payment: { findUnique: jest.Mock };
  organizationMember: { findUnique: jest.Mock };
}): { guard: RefundsAccessGuard; mocks: Mocks } {
  const mocks: Mocks = {
    apiKeyAuth: { canActivate: jest.fn() },
    sessionAuth: { canActivate: jest.fn() },
  };
  const guard = new RefundsAccessGuard(
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
  if (authorization !== undefined) request.headers = { authorization };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('RefundsAccessGuard (phase 9 §4.3 — payment-nested tenant resolution)', () => {
  let prisma: {
    payment: { findUnique: jest.Mock };
    organizationMember: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      payment: { findUnique: jest.fn() },
      organizationMember: { findUnique: jest.fn() },
    };
    prisma.payment.findUnique.mockResolvedValue(PAYMENT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'owner' });
  });

  describe('API-key mode', () => {
    function attachKey(
      mocks: Mocks,
      context: { project_id: string; environment: string } = {
        project_id: PROJECT_ID,
        environment: 'test',
      },
    ): void {
      mocks.apiKeyAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { apiKey?: unknown };
        req.apiKey = { key_id: 'key-1', ...context };
        return true;
      });
    }

    it('accepts the key owning the payment project and environment without RBAC queries', async () => {
      const { guard, mocks } = setup(prisma);
      attachKey(mocks);

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.create'), { payment_id: PAYMENT_ID }, `Bearer ${API_KEY}`),
        ),
      ).resolves.toBe(true);

      expect(mocks.apiKeyAuth.canActivate).toHaveBeenCalledTimes(1);
      expect(mocks.sessionAuth.canActivate).not.toHaveBeenCalled();
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });

    it('returns 404 for a payment from another project', async () => {
      const { guard, mocks } = setup(prisma);
      attachKey(mocks, { project_id: '0192f2a0-0000-7000-8000-0000000000ff', environment: 'test' });

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID }, `Bearer ${API_KEY}`),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('returns 404 for a payment from another environment of the same project', async () => {
      const { guard, mocks } = setup(prisma);
      attachKey(mocks, { project_id: PROJECT_ID, environment: 'live' });

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.create'), { payment_id: PAYMENT_ID }, `Bearer ${API_KEY}`),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('session mode', () => {
    function attachSession(mocks: Mocks): void {
      mocks.sessionAuth.canActivate.mockImplementation(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest() as { authUser?: unknown };
        req.authUser = { id: USER_ID, email: 'dev@example.com', name: null };
        return true;
      });
    }

    it('attaches the resolved project of the payment, not a path project', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);

      const request = { headers: {}, params: { payment_id: PAYMENT_ID } } as {
        organizationMembership?: unknown;
        project?: unknown;
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => decoratedHandler('refunds.create'),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(mocks.apiKeyAuth.canActivate).not.toHaveBeenCalled();
      expect(request.organizationMembership).toMatchObject({ organization_id: ORG_ID, role: 'owner' });
      expect(request.project).toMatchObject({ project_id: PROJECT_ID, organization_id: ORG_ID });
      expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
        where: { organizationId_userId: { organizationId: ORG_ID, userId: USER_ID } },
      });
    });

    it('returns 403 for a member without refunds.create (D5) and 200 for refunds.read', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'member' });

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.create'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).resolves.toBe(true);
    });

    it('returns 403 for a viewer on refunds.read as well (D5)', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'viewer' });

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.create'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('returns 404 for a non-member of the payment organization (no disclosure)', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('returns 404 for an unknown payment without checking membership', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: OTHER_PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });

    it('returns 404 for a malformed payment_id without querying the DB', async () => {
      const { guard, mocks } = setup(prisma);
      attachSession(mocks);

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: 'not-a-uuid' }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    });

    it('treats a missing Authorization header as session mode', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.sessionAuth.canActivate.mockRejectedValue({ code: 'UNAUTHENTICATED', status: 401 });

      await expect(
        guard.canActivate(contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID })),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(mocks.apiKeyAuth.canActivate).not.toHaveBeenCalled();
    });

    it('throws when the delegated session guard did not attach a user (programming error)', async () => {
      const { guard, mocks } = setup(prisma);
      mocks.sessionAuth.canActivate.mockResolvedValue(true);

      await expect(
        guard.canActivate(
          contextFor(decoratedHandler('refunds.read'), { payment_id: PAYMENT_ID }, 'Bearer some.jwt.token'),
        ),
      ).rejects.toThrow('RefundsAccessGuard used without SessionAuthGuard');
    });
  });

  it('throws on a route without @RequireCapability (programming error)', async () => {
    const { guard } = setup(prisma);
    const handler = (): void => undefined;

    await expect(
      guard.canActivate(contextFor(handler, { payment_id: PAYMENT_ID }, `Bearer ${API_KEY}`)),
    ).rejects.toThrow('RefundsAccessGuard requires @RequireCapability on the route handler');
  });
});
