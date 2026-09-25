import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Phase 3 e2e (§9.1): supertest against the running Nest application with real
 * PostgreSQL/Redis. CI provides dependencies as service containers (D8);
 * locally the suites that need them are skipped when they are unreachable
 * (same pattern as the Phase 2 health e2e).
 *
 * Refresh cookies are handled explicitly (never via the supertest agent jar)
 * so rotation/reuse assertions are deterministic.
 */
process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX = '500';
process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX = '300';
process.env.AUTH_RATE_LIMIT_IP_REFRESH_MAX = '500';
process.env.AUTH_RATE_LIMIT_IP_READ_MAX = '500';

const COOKIE_NAME = 'brinnpay_refresh';

interface Reachable {
  value: boolean;
}

function extractCookieValue(header: unknown): string | null {
  if (!header) {
    return null;
  }
  const raw = Array.isArray(header) ? header.join('; ') : String(header);
  const match = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function refreshCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}`;
}

describe('BrinnPay auth (e2e, phase 3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const reachable: Reachable = { value: false };

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();

    prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    try {
      await prisma.ping();
      await redis.ping();
      reachable.value = true;
    } catch {
      // Dependencies unavailable (local run without docker compose).
    }

    if (reachable.value) {
      await prisma.organizationMember.deleteMany();
      await prisma.organization.deleteMany();
      await prisma.refreshSession.deleteMany();
      await prisma.user.deleteMany();
      // Reset the auth rate-limit counters so repeated local runs (and the
      // 900s window) stay deterministic (D7).
      const rateLimitKeys = await redis.connection.keys('auth:rl:*');
      if (rateLimitKeys.length > 0) {
        await redis.connection.del(rateLimitKeys);
      }
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const register = async (email: string, password = 'password-123', name = 'Integration Dev') => {
    const response = await request(server()).post('/api/v1/auth/register').send({ email, password, name });
    return { response, cookie: extractCookieValue(response.headers['set-cookie']) };
  };

  const login = async (email: string, password = 'password-123') => {
    const response = await request(server()).post('/api/v1/auth/login').send({ email, password });
    return { response, cookie: extractCookieValue(response.headers['set-cookie']) };
  };

  it('registers a user, establishes a session and sets an HttpOnly cookie (§8.1, §8.9)', async () => {
    if (!reachable.value) return;

    const { response, cookie } = await register('e2e-register@example.com');

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      access_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: expect.any(Number),
      user: { id: expect.any(String), email: 'e2e-register@example.com', name: 'Integration Dev' },
    });
    expect(cookie).toBeTruthy();

    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join('; ')
      : String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth');
    expect(setCookie).toContain('SameSite=Lax');
    expect(JSON.stringify(response.body)).not.toContain('brinnpay_refresh');
  });

  it('creates the default organization with the owner membership (ADR-0010, D4)', async () => {
    if (!reachable.value) return;

    const { response } = await register('e2e-org@example.com', 'password-123', 'Ada Lovelace');
    const userId = response.body.user.id;

    const memberships = await prisma.organizationMember.findMany({
      where: { userId },
      include: { organization: true },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
    expect(memberships[0].organization.name).toBe('Ada Lovelace');
  });

  it('duplicate email (any case) returns 409 CONFLICT (D8)', async () => {
    if (!reachable.value) return;
    await register('e2e-dup@example.com');

    const dup = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: 'E2E-DUP@example.com', password: 'password-123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('login issues a session and /auth/me returns the public user; missing token → 401 (§8.7)', async () => {
    if (!reachable.value) return;

    const { response, cookie } = await login('e2e-register@example.com');
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('e2e-register@example.com');
    expect(cookie).toBeTruthy();

    const me = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${response.body.access_token}`)
      .expect(200);
    expect(me.body).toMatchObject({ id: response.body.user.id, email: 'e2e-register@example.com' });

    const missing = await request(server()).get('/api/v1/auth/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('login yields an identical generic 401 for unknown email and wrong password (§8.4)', async () => {
    if (!reachable.value) return;

    const unknown = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'wrong-password' });
    const wrong = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'e2e-register@example.com', password: 'not-the-password' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.code).toBe('UNAUTHENTICATED');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('refresh rotates the session (D3): valid rotation issues a new token (§8.5)', async () => {
    if (!reachable.value) return;

    const { cookie } = await login('e2e-register@example.com');
    expect(cookie).toBeTruthy();

    const rotated = await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookieHeader(cookie!))
      .expect(200);
    expect(rotated.body).toMatchObject({
      access_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: expect.any(Number),
    });
  });

  it('refresh detects reuse of a rotated (revoked-but-unexpired) token and revokes all sessions (§8.5, D3)', async () => {
    if (!reachable.value) return;

    await register('e2e-reuse@example.com');
    const { cookie: first } = await login('e2e-reuse@example.com');
    expect(first).toBeTruthy();

    // Rotate once: first token becomes revoked, a new one is issued.
    await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookieHeader(first!))
      .expect(200);

    // Present the revoked original again → reuse-detection → all sessions gone.
    const replay = await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookieHeader(first!));
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');
    expect(Array.isArray(replay.headers['set-cookie']) ? replay.headers['set-cookie'].join('; ') : String(replay.headers['set-cookie'])).toContain(`${COOKIE_NAME}=;`);

    // Every refresh session of the user is now revoked.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'e2e-reuse@example.com' } });
    const sessions = await prisma.refreshSession.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('logout revokes the session and clears the cookie; repeat logout is idempotent 204 (D9) (§8.6)', async () => {
    if (!reachable.value) return;

    const { cookie } = await login('e2e-register@example.com');
    expect(cookie).toBeTruthy();

    const logout = await request(server())
      .post('/api/v1/auth/logout')
      .set('Cookie', refreshCookieHeader(cookie!));
    expect(logout.status).toBe(204);
    const cleared = Array.isArray(logout.headers['set-cookie']) ? logout.headers['set-cookie'].join('; ') : String(logout.headers['set-cookie']);
    expect(cleared).toContain(`${COOKIE_NAME}=;`);

    const again = await request(server())
      .post('/api/v1/auth/logout')
      .set('Cookie', refreshCookieHeader(cookie!));
    expect(again.status).toBe(204);

    const refresh = await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookieHeader(cookie!));
    expect(refresh.status).toBe(401);
  });

  it('validates request bodies and honors password bounds (D6)', async () => {
    if (!reachable.value) return;

    const shortPassword = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: 'e2e-bounds@example.com', password: 'short' });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.error.code).toBe('VALIDATION_ERROR');

    const badEmail = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'password-123' });
    expect(badEmail.status).toBe(400);
  });

  it('does not leak credential or token material in error responses (§8.11)', async () => {
    if (!reachable.value) return;

    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'super-secret-value' });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('super-secret-value');
    expect(response.status).toBe(401);
  });

  describe('rate limiting with overridden low limits (D7, §8.8)', () => {
    let limitedApp: INestApplication;

    beforeAll(async () => {
      if (!reachable.value) return;
      process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX = '3';
      process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX = '3';
      process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '3600';

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      limitedApp = moduleRef.createNestApplication();
      configureApp(limitedApp, limitedApp.get(ConfigService));
      await limitedApp.init();
    });

    afterAll(async () => {
      if (limitedApp) await limitedApp.close();
    });

    it('returns 429 RATE_LIMITED once login attempts exceed the limit', async () => {
      if (!reachable.value) return;

      const attempts = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(limitedApp.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'rate-target@example.com', password: 'guess' }),
        ),
      );

      expect(attempts.some((r) => r.status === 429)).toBe(true);
      const throttled = attempts.find((r) => r.status === 429)!;
      expect(throttled.body.error.code).toBe('RATE_LIMITED');
    });
  });
});