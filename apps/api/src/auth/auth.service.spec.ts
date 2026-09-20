import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshSessionService } from './refresh-session.service';
import { TokenService } from './token.service';

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });
}

describe('AuthService (register/login, D4/D5/D8)', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; create: jest.Mock };
    organization: { create: jest.Mock };
    organizationMember: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let txn: {
    user: { create: jest.Mock };
    organization: { create: jest.Mock };
    organizationMember: { create: jest.Mock };
  };
  let password: PasswordService;
  const tokens = { signAccessToken: jest.fn().mockReturnValue('jwt-token') } as unknown as TokenService;
  const refreshSessions = {
    createForUserInTransaction: jest.fn().mockResolvedValue({ token: 'refresh-token', sessionId: 's', expiresAt: new Date() }),
    createForUser: jest.fn().mockResolvedValue({ token: 'refresh-token', sessionId: 's', expiresAt: new Date() }),
    rotate: jest.fn(),
    revoke: jest.fn(),
  } as unknown as jest.Mocked<RefreshSessionService>;
  const config = {
    getOrThrow: (key: string) => (key === 'jwt.accessTokenTtlSeconds' ? 900 : undefined),
  } as unknown as ConfigService;

  const USER_ROW = {
    id: 'user-id-1',
    email: 'dev@example.com',
    name: null,
    passwordHash: '$argon2id$hash',
    createdAt: new Date('2026-09-19T12:00:00Z'),
    updatedAt: new Date('2026-09-19T12:00:00Z'),
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), create: jest.fn() },
      organization: { create: jest.fn() },
      organizationMember: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    txn = {
      user: { create: jest.fn() },
      organization: { create: jest.fn() },
      organizationMember: { create: jest.fn() },
    };

    prisma.user.findUniqueOrThrow.mockResolvedValue(USER_ROW);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof txn) => Promise<unknown>) => fn(txn));

    password = new PasswordService();

    service = new AuthService(
      prisma as unknown as PrismaService,
      password,
      tokens as unknown as TokenService,
      refreshSessions as unknown as RefreshSessionService,
      config,
    );
  });

  describe('register', () => {
    it('creates user + default org + owner membership + refresh session in ONE transaction', async () => {
      txn.user.create.mockResolvedValue(USER_ROW);
      txn.organization.create.mockResolvedValue({ id: 'org-1', name: 'dev' });
      txn.organizationMember.create.mockResolvedValue({ id: 'm-1' });
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.register({
        email: '  DEV@Example.com ',
        password: 'password-123',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txn.user.create).toHaveBeenCalledTimes(1);
      expect(txn.organizationMember.create).toHaveBeenCalledTimes(1);
      // The transaction closure also creates the refresh session against the tx.
      expect(refreshSessions.createForUserInTransaction).toHaveBeenCalledTimes(1);
      // D8: email normalized to lowercase/trimmed before persistence.
      expect(txn.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'dev@example.com' }) }),
      );
      expect(result.user.email).toBe('dev@example.com');
      expect(result.accessToken).toBe('jwt-token');
      expect(result.refreshToken).toBe('refresh-token');
    });

    it('derives the default org name from the display name (D5)', async () => {
      txn.user.create.mockResolvedValue(USER_ROW);
      txn.organization.create.mockResolvedValue({ id: 'org-1', name: 'Ada Lovelace' });
      prisma.user.findUnique.mockResolvedValue(null);
      await service.register({ email: 'ada@example.com', password: 'password-123', name: '  Ada Lovelace  ' });
      expect(txn.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Ada Lovelace' }) }),
      );
    });

    it('derives the default org name from the email local part when no name (D5)', async () => {
      txn.user.create.mockResolvedValue(USER_ROW);
      txn.organization.create.mockResolvedValue({ id: 'org-1', name: 'dev' });
      prisma.user.findUnique.mockResolvedValue(null);
      await service.register({ email: 'dev@example.com', password: 'password-123' });
      expect(txn.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'dev' }) }),
      );
    });

    it('returns 409 CONFLICT on duplicate email (case-insensitive, D8)', async () => {
      prisma.user.findUnique.mockResolvedValue(USER_ROW);
      await expect(
        service.register({ email: 'DEV@EXAMPLE.COM', password: 'password-123' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });

    it('maps a unique-constraint violation to 409 CONFLICT even in a race', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      txn.user.create.mockRejectedValue(uniqueViolation());
      await expect(
        service.register({ email: 'dev@example.com', password: 'password-123' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });

    it('rolls back the whole transaction when session creation fails (atomicity D4)', async () => {
      txn.user.create.mockResolvedValue(USER_ROW);
      txn.organization.create.mockResolvedValue({ id: 'org-1' });
      prisma.user.findUnique.mockResolvedValue(null);
      refreshSessions.createForUserInTransaction.mockRejectedValueOnce(new Error('db error'));
      await expect(
        service.register({ email: 'dev@example.com', password: 'password-123' }),
      ).rejects.toThrow('db error');
    });
  });

  describe('login', () => {
    it('accepts correct credentials and creates a refresh session', async () => {
      const hash = await password.hash('correct-password');
      prisma.user.findUnique.mockResolvedValue({ ...USER_ROW, passwordHash: hash });
      const result = await service.login({ email: 'DEV@Example.com', password: 'correct-password' });
      expect(result.user.email).toBe('dev@example.com');
      expect(refreshSessions.createForUser).toHaveBeenCalledTimes(1);
    });

    it('returns the identical 401 for unknown email and wrong password', async () => {
      prisma.user.findUnique.mockResolvedValue(USER_ROW); // exists
      const wrongPassword = await service.login({ email: 'dev@example.com', password: 'not-the-password' }).catch((e) => e);
      prisma.user.findUnique.mockResolvedValue(null); // unknown
      const unknownEmail = await service.login({ email: 'ghost@example.com', password: 'whatever' }).catch((e) => e);

      expect(wrongPassword).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(unknownEmail).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(wrongPassword.message).toBe(unknownEmail.message);
    });
  });
});