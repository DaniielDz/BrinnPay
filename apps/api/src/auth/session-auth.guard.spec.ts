import { ExecutionContext } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { ApiError } from '../common/errors/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuthGuard } from './session-auth.guard';
import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-that-is-long-enough-for-hs256';

function contextFor(authorization?: string) {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard (phase 3 §4.3)', () => {
  let guard: SessionAuthGuard;
  let tokenService: TokenService;
  let prisma: { user: { findUnique: jest.Mock } };

  const USER = {
    id: '0192f2a0-0000-7000-8000-000000000001',
    email: 'dev@example.com',
    name: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    prisma = { user: { findUnique: jest.fn() } };
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: '900s' } })],
      providers: [TokenService],
    }).compile();
    tokenService = moduleRef.get(TokenService);
    guard = new SessionAuthGuard(tokenService, prisma as unknown as PrismaService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts a valid bearer token and attaches the public user', async () => {
    prisma.user.findUnique.mockResolvedValue(USER);
    const request = { headers: { authorization: `Bearer ${tokenService.signAccessToken(USER.id)}` } } as { authUser?: unknown };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // `authUser` is the contract `User` shape: snake_case JSON fields
    // (created_at/updated_at), never the Prisma row shape.
    expect(request.authUser).toEqual({
      id: USER.id,
      email: USER.email,
      name: USER.name,
      created_at: USER.createdAt,
      updated_at: USER.updatedAt,
    });
  });

  it.each([undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer '])(
    'rejects malformed authorization (%s) as 401 UNAUTHENTICATED',
    async (auth: string | undefined) => {
      const ctx = contextFor(auth);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    },
  );

  it('rejects an invalid/expired token as 401 UNAUTHENTICATED', async () => {
    const token = `${tokenService.signAccessToken(USER.id)}.AA.invalid`;
    const ctx = contextFor(`Bearer ${token}`);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ApiError);
  });

  it('rejects a valid token whose user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const ctx = contextFor(`Bearer ${tokenService.signAccessToken(USER.id)}`);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ApiError);
  });
});