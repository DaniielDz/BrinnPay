import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiError } from '../common/errors/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { RequireCapability } from '../organizations/org-rbac.guard';
import type { Capability } from '../organizations/roles';
import { ProjectRbacGuard } from './project-rbac.guard';

type Handler = () => void;

const REFLECTOR = new Reflector();

const USER_ID = '0192f2a0-0000-7000-8000-000000000008';
const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';

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

function contextFor(handler: Handler, params: Record<string, string>, userId: string = USER_ID) {
  const request = {
    authUser: { id: userId, email: 'dev@example.com', name: null },
    params,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function decoratedHandler(capability: Capability): Handler {
  class Stub {
    @RequireCapability({ capability })
    run(): void {}
  }
  return Stub.prototype.run;
}

describe('ProjectRbacGuard (phase 5 §4.1, D2/D3)', () => {
  let prisma: {
    project: { findUnique: jest.Mock };
    organizationMember: { findUnique: jest.Mock };
  };
  let guard: ProjectRbacGuard;

  beforeEach(() => {
    prisma = {
      project: { findUnique: jest.fn() },
      organizationMember: { findUnique: jest.fn() },
    };
    guard = new ProjectRbacGuard(REFLECTOR, prisma as unknown as PrismaService);
  });

  it('loads the project, resolves membership, evaluates the capability, and attaches both contexts', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'admin' });
    const handler = decoratedHandler('projects.delete');

    const request = { authUser: { id: USER_ID }, params: { project_id: PROJECT_ID } } as {
      organizationMembership?: unknown;
      project?: unknown;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.organizationMembership).toMatchObject({
      organization_id: ORG_ID,
      user_id: USER_ID,
      role: 'admin',
    });
    expect(request.project).toMatchObject({
      project_id: PROJECT_ID,
      organization_id: ORG_ID,
    });
  });

  it('grants projects.read to viewers (phase 5 §4.3, D3)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'viewer' });

    await expect(guard.canActivate(contextFor(decoratedHandler('projects.read'), { project_id: PROJECT_ID }))).resolves.toBe(true);
  });

  it('returns 403 for a member without the required capability (§4.3, D3)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'member' });
    const request = {
      authUser: { id: USER_ID, email: 'dev@example.com', name: null },
      params: { project_id: PROJECT_ID },
    } as { project?: unknown; organizationMembership?: unknown };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => decoratedHandler('projects.delete'),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // Scope to the point of failure: a 403 still carries the resolved project.
    expect(request.project).toMatchObject({ project_id: PROJECT_ID, organization_id: ORG_ID });
  });

  it('returns 404 for a non-member of the owning organization (D2 — no disclosure)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    const request = {
      authUser: { id: USER_ID, email: 'dev@example.com', name: null },
      params: { project_id: PROJECT_ID },
    } as { project?: unknown; organizationMembership?: unknown };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => decoratedHandler('projects.read'),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // Phase 11 §4.2 rule 5: a non-member 404 is indistinguishable from an
    // unknown project — no tenant scope is attached, so the request log stays
    // null-scoped and an outsider can never write into a foreign tenant's log.
    expect(request.project).toBeUndefined();
    expect(request.organizationMembership).toBeUndefined();
  });

  it('returns 404 for an unknown project without checking membership', async () => {
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor(decoratedHandler('projects.read'), { project_id: PROJECT_ID })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed project_id without querying the DB', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);

    await expect(
      guard.canActivate(contextFor(decoratedHandler('projects.read'), { project_id: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('treats an invalid stored role as 404 (defensive, phase 4 D10)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue({ ...MEMBER_ROW, role: 'root' });

    await expect(
      guard.canActivate(contextFor(decoratedHandler('projects.read'), { project_id: PROJECT_ID })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('throws on a route that lacks @RequireCapability (programming error)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = (): void => undefined;

    await expect(guard.canActivate(contextFor(handler, { project_id: PROJECT_ID }))).rejects.toThrow(
      'ProjectRbacGuard requires @RequireCapability on the route handler',
    );
  });

  it('throws when no authenticated user is attached (must run after SessionAuthGuard)', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue(MEMBER_ROW);
    const handler = decoratedHandler('projects.read');
    const request = { params: { project_id: PROJECT_ID } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow('ProjectRbacGuard used without SessionAuthGuard');
  });

  it('rejects through ApiError with the canonical envelope', async () => {
    prisma.project.findUnique.mockResolvedValue(PROJECT_ROW);
    prisma.organizationMember.findUnique.mockResolvedValue(null);

    const error = await guard
      .canActivate(contextFor(decoratedHandler('projects.read'), { project_id: PROJECT_ID }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
  });
});