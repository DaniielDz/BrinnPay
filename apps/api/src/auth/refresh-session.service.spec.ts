import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { RefreshSessionService } from './refresh-session.service';

describe('RefreshSessionService (D3, D10)', () => {
  let service: RefreshSessionService;
  let prisma: {
    refreshSession: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  const config = { getOrThrow: jest.fn().mockReturnValue(30) } as unknown as ConfigService;

  const NOW = new Date('2026-09-19T12:00:00Z');
  const ACTIVE_SESSION = {
    id: 'sess-active',
    userId: 'user-1',
    tokenHash: 'hash-active',
    expiresAt: new Date('2026-10-19T12:00:00Z'), // 30 days ahead
    revokedAt: null,
    createdAt: NOW,
  };
  const REVOKED_UNEXPIRED = {
    ...ACTIVE_SESSION,
    id: 'sess-revoked',
    tokenHash: 'hash-revoked',
    revokedAt: new Date('2026-09-19T11:00:00Z'),
  };
  const EXPIRED = {
    ...ACTIVE_SESSION,
    id: 'sess-expired',
    tokenHash: 'hash-expired',
    expiresAt: new Date('2026-09-01T12:00:00Z'),
  };

  beforeEach(() => {
    prisma = {
      refreshSession: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: { refreshSession: unknown }) => unknown) =>
      fn({ refreshSession: prisma.refreshSession }),
    );
    prisma.refreshSession.create.mockResolvedValue({ id: 'sess-new', expiresAt: ACTIVE_SESSION.expiresAt });
    service = new RefreshSessionService(
      prisma as unknown as PrismaService,
      config,
    );
  });

  it('hashes tokens as a SHA-256 hex digest (never stores plaintext)', () => {
    const hex = service.hashToken('opaque-token-value');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).not.toContain('opaque-token-value');
  });

  it('issues cryptographically random opaque tokens', () => {
    const a = service.issueToken();
    const b = service.issueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('rotates an active session: revokes the presented one and issues a new token', async () => {
    prisma.refreshSession.findUnique.mockResolvedValue(ACTIVE_SESSION);

    const verdict = await service.rotate('presented-token', NOW);

    expect(verdict.status).toBe('rotated');
    if (verdict.status === 'rotated') {
      expect(verdict.token).toBeTruthy();
      expect(verdict.userId).toBe('user-1');
      // Old session revoked.
      expect(prisma.refreshSession.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sess-active' } }),
      );
    }
  });

  it('detects reuse of a revoked-but-unexpired token and revokes all sessions', async () => {
    prisma.refreshSession.findUnique.mockResolvedValue(REVOKED_UNEXPIRED);
    prisma.refreshSession.updateMany.mockResolvedValue({ count: 1 });

    const verdict = await service.rotate('replayed-token', NOW);

    expect(verdict).toEqual({ status: 'reuse-detected', userId: 'user-1' });
    expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it('returns invalid for expired sessions', async () => {
    prisma.refreshSession.findUnique.mockResolvedValue(EXPIRED);
    await expect(service.rotate('expired-token', NOW)).resolves.toEqual({ status: 'invalid' });
  });

  it('returns invalid for unknown tokens', async () => {
    prisma.refreshSession.findUnique.mockResolvedValue(null);
    await expect(service.rotate('unknown-token', NOW)).resolves.toEqual({ status: 'invalid' });
  });

  it('revokes an active session on explicit revoke (logout) only once', async () => {
    prisma.refreshSession.findUnique.mockResolvedValue(ACTIVE_SESSION);
    await service.revoke('some-token', NOW);
    expect(prisma.refreshSession.update).toHaveBeenCalled();

    prisma.refreshSession.findUnique.mockResolvedValue(REVOKED_UNEXPIRED);
    await service.revoke('already-revoked-token', NOW);
    expect(prisma.refreshSession.update).toHaveBeenCalledTimes(1);
  });

  it('revokes all active sessions for a user (reuse detection)', async () => {
    prisma.refreshSession.updateMany.mockResolvedValue({ count: 3 });
    await service.revokeAllForUser('user-1', undefined, NOW);
    expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
      }),
    );
  });
});