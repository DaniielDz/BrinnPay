import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';

import { uuidv7 } from '../common/uuid/uuid';
import { PrismaService } from '../prisma/prisma.service';

export type RefreshVerdict =
  | { status: 'rotated'; token: string; sessionId: string; userId: string }
  | { status: 'reuse-detected'; userId: string }
  | { status: 'invalid' };

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/** Minimal repository surface used for seed/rotation work (per-write client). */
interface SessionRepo {
  create(args: {
    data: {
      id: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      revokedAt: null;
      createdAt: Date;
    };
  }): Promise<{ id: string; expiresAt: Date }>;
  deleteMany(args: {
    where: { userId: string; expiresAt: { lte: Date } };
  }): Promise<{ count: number }>;
}

/**
 * Server-side refresh sessions (D10, D3). Refresh tokens are cryptographically
 * random opaque strings; only a SHA-256 hash is persisted (never the plaintext,
 * never a JWT). Rotate on refresh; a revoked-but-unexpired token presented
 * again revokes all of the user's sessions (theft response). Cleanup of
 * expired rows is lazy — no background jobs (ADR-0013).
 */
@Injectable()
export class RefreshSessionService {
  private readonly logger = new Logger(RefreshSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get ttlDays(): number {
    return this.config.getOrThrow<number>('auth.refreshSessionTtlDays');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Creates a new refresh session for the user (owning transaction) and
   * returns the plaintext token (for the `HttpOnly` cookie) plus the session
   * expiry. Deletes the user's expired sessions lazily on the way.
   */
  async createForUser(userId: string, now = new Date()): Promise<CreatedSession> {
    return this.createWithRepo(this.prisma.refreshSession as unknown as SessionRepo, userId, now);
  }

  /**
   * Creates a refresh session inside an existing transaction so registration
   * is atomic (D4); failures roll back user/org/member/session together.
   */
  async createForUserInTransaction(
    tx: { refreshSession: SessionRepo },
    userId: string,
    now = new Date(),
  ): Promise<CreatedSession> {
    return this.createWithRepo(tx.refreshSession, userId, now);
  }

  private async createWithRepo(
    repo: SessionRepo,
    userId: string,
    now: Date,
  ): Promise<CreatedSession> {
    const expiresAt = new Date(now.getTime() + this.ttlDays * 24 * 60 * 60 * 1000);
    const token = this.issueToken();
    const tokenHash = this.hashToken(token);

    const created = await this.prisma.$transaction(async () => {
      await repo.deleteMany({ where: { userId, expiresAt: { lte: now } } });
      return repo.create({
        data: {
          id: uuidv7(),
          userId,
          tokenHash,
          expiresAt,
          revokedAt: null,
          createdAt: now,
        },
      });
    });

    return { token, sessionId: created.id, expiresAt: created.expiresAt };
  }

  /**
   * Validates and rotates the presented refresh token (D3).
   * - Active + unexpired → rotate (new session, revoke the presented one).
   * - Revoked but unexpired → reuse detection: revoke all the user's sessions.
   * - Expired, revoked-and-expired, or unknown → invalid.
   */
  async rotate(token: string, now = new Date()): Promise<RefreshVerdict> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });

    if (!session) {
      return { status: 'invalid' };
    }

    if (session.revokedAt !== null) {
      if (session.expiresAt > now) {
        await this.revokeAllForUser(session.userId, session.id, now);
        return { status: 'reuse-detected', userId: session.userId };
      }
      return { status: 'invalid' };
    }

    if (session.expiresAt <= now) {
      await this.prisma.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });
      return { status: 'invalid' };
    }

    const next = await this.createForUser(session.userId, now);
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });

    return { status: 'rotated', token: next.token, sessionId: next.sessionId, userId: session.userId };
  }

  async revoke(token: string, now = new Date()): Promise<void> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });

    if (!session || session.revokedAt !== null || session.expiresAt <= now) {
      return;
    }

    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
  }

  async revokeAllForUser(userId: string, excludeSessionId?: string, now = new Date()): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      data: { revokedAt: now },
    });
  }
}