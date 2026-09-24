import { ExecutionContext } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from '../common/errors/api-error';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { generateApiKey } from './api-key-crypto';

function contextFor(authorization?: string) {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

const ACTIVE_KEY = generateApiKey('test');

const ACTIVE_ROW = {
  id: '0192f2a0-0000-7000-8000-000000000004',
  projectId: '0192f2a0-0000-7000-8000-00000000000b',
  environment: 'test',
  keyHash: 'hash',
  revokedAt: null,
  createdAt: new Date(),
};

describe('ApiKeyAuthGuard (phase 5 §4.5, D4)', () => {
  let prisma: { apiKey: { findUnique: jest.Mock } };
  let guard: ApiKeyAuthGuard;

  beforeEach(() => {
    prisma = { apiKey: { findUnique: jest.fn() } };
    guard = new ApiKeyAuthGuard(prisma as unknown as PrismaService);
  });

  it('authenticates an active key and attaches the (project, environment) scope', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(ACTIVE_ROW);
    const request = { headers: { authorization: `Bearer ${ACTIVE_KEY}` } } as {
      apiKey?: unknown;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.apiKey).toMatchObject({
      key_id: ACTIVE_ROW.id,
      project_id: ACTIVE_ROW.projectId,
      environment: 'test',
    });
  });

  it.each([undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer '])(
    'rejects malformed authorization (%s) as 401 UNAUTHENTICATED',
    async (authorization: string | undefined) => {
      const ctx = contextFor(authorization);
      await expect(guard.canActivate(ctx)).rejects.toThrow(ApiError);
      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown key with a generic 401 (no existence disclosure)', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(contextFor(`Bearer ${ACTIVE_KEY}`))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('rejects a revoked key with the same generic 401 as an unknown key', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ ...ACTIVE_ROW, revokedAt: new Date() });
    const revoked = await guard
      .canActivate(contextFor(`Bearer ${ACTIVE_KEY}`))
      .catch((e: unknown) => e);

    prisma.apiKey.findUnique.mockResolvedValue(null);
    const unknown = await guard
      .canActivate(contextFor(`Bearer ${ACTIVE_KEY}`))
      .catch((e: unknown) => e);

    expect(revoked).toBeInstanceOf(ApiError);
    expect(unknown).toBeInstanceOf(ApiError);
    expect((revoked as ApiError).message).toBe((unknown as ApiError).message);
    expect((revoked as ApiError).code).toBe('UNAUTHENTICATED');
  });
});