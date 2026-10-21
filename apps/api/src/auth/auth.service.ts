import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';

import { AUDIT_LOG_PORT, type AuditLogPort } from '../audit-logging/audit-log.port';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { toPublicUser, type PublicUser } from './current-user';
import { PasswordService } from './password.service';
import { RefreshSessionService, type CreatedSession } from './refresh-session.service';
import { TokenService } from './token.service';

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  refreshToken: string;
}

const GENERIC_LOGIN_ERROR = new ApiError(
  ErrorCode.UNAUTHENTICATED,
  'Invalid email or password',
  401,
);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshSessions: RefreshSessionService,
    private readonly config: ConfigService,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
  ) {}

  get expiresIn(): number {
    return this.config.getOrThrow<number>('jwt.accessTokenTtlSeconds');
  }

  /**
   * Registration (D4): user + default personal organization (ADR-0010) +
   * `owner` membership + first refresh session, all in one transaction. Also
   * issues the first access token. Atomic: any failure rolls back everything.
   *
   * Phase 12 §5.2/§6.2: `user.registered` is written **inside** the same
   * transaction (it is the one auth event that has one, D7), and its D4
   * membership fan-out reads the membership created just above — typically one
   * entry for the default organization.
   */
  async register(input: RegisterInput, requestId?: string): Promise<AuthResult> {
    const email = this.normalizeEmail(input.email);
    const name = this.cleanName(input.name);

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ApiError(ErrorCode.CONFLICT, 'email is already registered', 409);
    }

    const passwordHash = await this.password.hash(input.password);
    const now = new Date();
    const organizationName = this.defaultOrganizationName(name, email);

    let userId!: string;
    // TS requires these to be assigned before use; they are set inside the
    // closure or immediately after, and the atomicity guarantees mean the
    // session is created within the same transaction (D4).
    let session!: CreatedSession;

    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            id: uuidv7(),
            email,
            name,
            passwordHash,
            createdAt: now,
            updatedAt: now,
          },
        });
        const organization = await tx.organization.create({
          data: {
            id: uuidv7(),
            name: organizationName,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.organizationMember.create({
          data: {
            id: uuidv7(),
            organizationId: organization.id,
            userId: user.id,
            role: 'owner',
            createdAt: now,
            // `updated_at` exists since Phase 4 (mutable member records).
            updatedAt: now,
          },
        });
        userId = user.id;
        // Phase 12 §5.2: committed inside the registration transaction — a
        // user can never exist without their audit entry (fail-closed, D7).
        await this.audit.record(tx, {
          action: 'user.registered',
          user_id: user.id,
          request_id: requestId ?? null,
        });
        session = await this.refreshSessions.createForUserInTransaction(tx, user.id, now);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(ErrorCode.CONFLICT, 'email is already registered', 409);
      }
      throw error;
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    return {
      accessToken: this.tokens.signAccessToken(userId),
      expiresIn: this.expiresIn,
      user: toPublicUser(user),
      refreshToken: session.token,
    };
  }

  async login(input: LoginInput, requestId?: string): Promise<AuthResult> {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Unknown email and wrong password get the identical generic response so
    // the endpoint cannot be used to enumerate accounts (phase 3 §4.2, §7.4).
    if (!user) {
      // Phase 12 §5.2/D4: an unknown address records **no** entry — the
      // presented email is third-party PII (D13) and there is no user to
      // attribute it to. The response is identical either way.
      throw GENERIC_LOGIN_ERROR;
    }
    if (!(await this.password.verify(user.passwordHash, input.password))) {
      // Known account, wrong password: the archetypal auth security event
      // (§5.2). Recorded best-effort — a failed audit write never changes the
      // 401 outcome, its body or its headers (D7).
      await this.audit.captureAuth({
        action: 'user.login_failed',
        user_id: user.id,
        request_id: requestId ?? null,
      });
      throw GENERIC_LOGIN_ERROR;
    }

    const session = await this.refreshSessions.createForUser(user.id);

    // §5.2: a successful login (a refresh session was created), best-effort.
    await this.audit.captureAuth({
      action: 'user.logged_in',
      user_id: user.id,
      request_id: requestId ?? null,
    });

    return {
      accessToken: this.tokens.signAccessToken(user.id),
      expiresIn: this.expiresIn,
      user: toPublicUser(user),
      refreshToken: session.token,
    };
  }

  /**
   * Refresh rotation (D3). A valid session yields a new access token and a new
   * refresh session (the presented session is revoked). Presenting a
   * revoked-but-unexpired token is treated as theft: all the user's sessions
   * are revoked and the request is rejected.
   */
  async refresh(token: string): Promise<{ accessToken: string; expiresIn: number; refreshToken: string }> {
    const verdict = await this.refreshSessions.rotate(token);

    if (verdict.status === 'invalid' || verdict.status === 'reuse-detected') {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Session invalid or expired', 401);
    }

    return {
      accessToken: this.tokens.signAccessToken(verdict.userId),
      expiresIn: this.expiresIn,
      refreshToken: verdict.token,
    };
  }

  async logout(token: string, requestId?: string): Promise<void> {
    const userId = await this.refreshSessions.revoke(token);

    // Phase 12 §5.2: `user.logged_out` only when a valid session was actually
    // revoked; a rejected logout (no authenticated actor) records nothing.
    // Best-effort like the other outcome events (D7) — the cookie is cleared
    // and 204 returned regardless.
    if (userId) {
      await this.audit.captureAuth({
        action: 'user.logged_out',
        user_id: userId,
        request_id: requestId ?? null,
      });
    }
  }

  private normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  private cleanName(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Default organization name derivation (D5): provided name → email local
   * part → "My Organization".
   */
  private defaultOrganizationName(name: string | null, email: string): string {
    if (name) {
      return name;
    }
    const localPart = email.split('@')[0];
    return localPart.length > 0 ? localPart : 'My Organization';
  }
}