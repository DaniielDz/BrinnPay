import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 13 e2e against real PostgreSQL and Redis (§9 acceptance criteria, §10
 * "E2E (API)").
 *
 * One application is booted here with **deliberately tight** limits so the
 * numbered criteria can be asserted against real responses, while every other
 * e2e suite keeps the raised defaults from `jest-e2e.setup.ts`. That separation
 * is what lets the shared gate stay deterministic without weakening any assertion
 * below.
 *
 * Per-test budget isolation comes from the proxy trust this app is booted with
 * (`TRUST_PROXY_HOPS=1` plus a `127.0.0.0/8` allowlist): each case presents its
 * own `X-Forwarded-For`, so one client's exhausted bucket can never be another's
 * — which is simultaneously the end-to-end proof of the D1 trust model and of
 * bucket isolation (AC4).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-rl-${slug}-${RUN}@example.com`;
const PASSWORD = 'Rate-Limit-Passw0rd-Sup3rSecret';

const READ_MAX = 3;
const WRITE_MAX = 4;
const WEBHOOK_REPLAY_MAX = 2;
const WEBHOOK_ENDPOINT_CREATE_MAX = 2;
const AUTH_LOGIN_MAX = 3;

/** Every value this suite overrides, restored so a later suite is unaffected. */
const OVERRIDES: Record<string, string> = {
  RATE_LIMIT_READ_MAX: String(READ_MAX),
  RATE_LIMIT_WRITE_MAX: String(WRITE_MAX),
  RATE_LIMIT_WINDOW_SECONDS: '900',
  RATE_LIMIT_WEBHOOK_REPLAY_MAX: String(WEBHOOK_REPLAY_MAX),
  RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS: '900',
  RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX: String(WEBHOOK_ENDPOINT_CREATE_MAX),
  RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS: '900',
  AUTH_RATE_LIMIT_IP_LOGIN_MAX: String(AUTH_LOGIN_MAX),
  AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX: String(AUTH_LOGIN_MAX),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '900',
  // One trusted hop, so a test can present its own client identity. The
  // allowlist is what makes the hop legal: boot refuses hops without it (D1),
  // and `127.0.0.0/8` is the peer supertest connects from.
  TRUST_PROXY_HOPS: '1',
  TRUST_PROXY_CIDRS: '127.0.0.0/8',
};

jest.setTimeout(120_000);

/**
 * The limiter's whole state is Redis keys under this one namespace, so clearing
 * it is exactly "reset every budget". Without this a re-run inside the same
 * 900 s window would start from the previous run's counters and the class budgets
 * would no longer be predictable.
 */
const LIMITER_KEY_PATTERN = 'brinnpay:rl:v1:*';

/** Unique client identity per case, so budgets never leak between cases. */
let clientCounter = 0;
const nextClientIp = () => `203.0.113.${(clientCounter += 1) % 250}`;

describe('rate limiting (Phase 13, real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiterAdmin: Redis;
  let reachable = false;

  const server = () => app.getHttpServer();
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of Object.keys(OVERRIDES)) {
      saved[key] = process.env[key];
      process.env[key] = OVERRIDES[key];
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);

    try {
      await prisma.ping();
      await app.get(RedisService).ping();
      limiterAdmin = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
      await limiterAdmin.ping();
      reachable = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  beforeEach(async () => {
    if (!reachable) return;
    const keys = await limiterAdmin.keys(LIMITER_KEY_PATTERN);
    if (keys.length > 0) await limiterAdmin.del(...keys);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (limiterAdmin) await limiterAdmin.quit().catch(() => undefined);
    for (const key of Object.keys(OVERRIDES)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  afterEach(async () => {
    requireDependencies(reachable);
    const users = await prisma.user.findMany({
      where: { email: { startsWith: 'e2e-rl-', endsWith: `-${RUN}@example.com` } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    const organizations = await prisma.organization.findMany({
      where: { name: { startsWith: 'rl13-', endsWith: `-${RUN}` } },
      select: { id: true },
    });
    const organizationIds = organizations.map((organization) => organization.id);

    const projects = await prisma.project.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { id: true },
    });
    const projectIds = projects.map((project) => project.id);

    if (userIds.length > 0) {
      await prisma.requestLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLogEntry.deleteMany({ where: { actorId: { in: userIds } } });
      await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
    }
    if (projectIds.length > 0) {
      await prisma.requestLog.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      // Deliveries and events cascade from the endpoint/project.
      await prisma.webhookEvent.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.webhookEndpoint.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }
    if (organizationIds.length > 0) {
      await prisma.requestLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await prisma.auditLogEntry.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await prisma.invitation.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await prisma.organizationMember.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    }
    if (userIds.length > 0) {
      await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A request bound to a specific client identity and (optionally) a session. */
  function as(options: { ip?: string; token?: string; key?: string } = {}) {
    const agent = request(server());
    return {
      get: (url: string) => apply(agent.get(url), options),
      post: (url: string) => apply(agent.post(url), options),
      patch: (url: string) => apply(agent.patch(url), options),
      delete: (url: string) => apply(agent.delete(url), options),
    };
  }

  function apply(
    call: request.Test,
    options: { ip?: string; token?: string; key?: string },
  ): request.Test {
    call.set('X-Forwarded-For', options.ip ?? nextClientIp());
    if (options.token) call.set('Authorization', `Bearer ${options.token}`);
    if (options.key) call.set('Authorization', `Bearer ${options.key}`);
    return call;
  }

  const setupIp = () => nextClientIp();

  async function setup(slug: string, options: { withKey?: boolean; withCustomer?: boolean } = {}) {
    // Setup traffic runs under its own client identity so it never consumes the
    // budget a case is about to exhaust.
    const ip = setupIp();
    const client = as({ ip });

    const registration = await client.post('/api/v1/auth/register').send({
      email: EMAIL(`owner-${slug}`),
      password: PASSWORD,
      name: `RL ${slug}`,
    });
    expect(registration.status).toBe(201);
    const token = registration.body.access_token as string;
    const userId = registration.body.user.id as string;

    const organization = await client.post('/api/v1/organizations').set('Authorization', `Bearer ${token}`).send({
      name: `rl13-${slug}-${RUN}`,
    });
    expect(organization.status).toBe(201);

    const project = await client.post('/api/v1/projects').set('Authorization', `Bearer ${token}`).send({
      organization_id: organization.body.id,
      name: `RL ${slug}`,
    });
    expect(project.status).toBe(201);

    let key: { id: string; key: string } | null = null;
    if (options.withKey) {
      const created = await client
        .post(`/api/v1/projects/${project.body.id}/api-keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ environment: 'test' });
      expect(created.status).toBe(201);
      key = { id: created.body.id, key: created.body.key };
    }

    let customerId: string | null = null;
    if (options.withCustomer) {
      const customer = await client
        .post(`/api/v1/projects/${project.body.id}/customers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ environment: 'test', email: EMAIL(`customer-${slug}`) });
      expect(customer.status).toBe(201);
      customerId = customer.body.id;
    }

    return {
      ip,
      token,
      userId,
      organizationId: organization.body.id as string,
      projectId: project.body.id as string,
      key,
      customerId,
      projectsUrl: `/api/v1/projects`,
      customersUrl: `/api/v1/projects/${project.body.id}/customers`,
      paymentsUrl: `/api/v1/projects/${project.body.id}/payments`,
      endpointsUrl: `/api/v1/projects/${project.body.id}/webhook-endpoints`,
    };
  }

  /** Polls for the post-response write (phase 11 accepts the visibility lag). */
  async function rowFor(requestId: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await prisma.requestLog.findMany({
        where: { requestId },
        orderBy: { id: 'asc' },
        take: 1,
      });
      if (rows.length > 0) return rows[0];
      if (Date.now() > deadline) throw new Error(`No request log row for ${requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const header = (response: request.Response, name: string) => response.headers[name.toLowerCase()];

  const asInteger = (value: unknown) => {
    expect(typeof value).toBe('string');
    return Number(value as string);
  };

  // -------------------------------------------------------------------------
  // Enforcement order: stage 1 before authentication (AC2)
  // -------------------------------------------------------------------------

  it('bounds an unauthenticated flood before any authentication or database work (AC2)', async () => {
    requireDependencies(reachable);
    const ip = nextClientIp();
    const projectLookup = jest.spyOn(prisma.project, 'findMany');

    const attempts = [];
    for (let index = 0; index < READ_MAX + 2; index += 1) {
      attempts.push(await as({ ip }).get('/api/v1/projects'));
    }

    const throttled = attempts[READ_MAX];
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
    // A throttled request never reached the authentication guard, so the
    // handler's query was never issued: no database work happened at all.
    expect(projectLookup).not.toHaveBeenCalled();
    projectLookup.mockRestore();

    // The same route answered 401 while budget remained — the limiter is not
    // converting a 401 into a 429.
    expect(attempts[0].status).toBe(401);
    expect(attempts[0].body.error.code).toBe('UNAUTHENTICATED');
  });

  // -------------------------------------------------------------------------
  // Per-class status table (AC3, §4.3)
  // -------------------------------------------------------------------------

  it('applies every class of the catalog to a representative route (AC3)', async () => {
    requireDependencies(reachable);
    const session = await setup('classes', { withKey: true });

    // `auth.read` — 100/900 s in the confirmed policy, so it stays allowed here.
    expect((await as({ ip: nextClientIp(), token: session.token }).get('/api/v1/auth/me')).status).toBe(200);

    // `auth.refresh` — cookie-bound; no cookie means 401, and the request counts.
    expect((await as({ ip: nextClientIp() }).post('/api/v1/auth/refresh')).status).toBe(401);

    // `read` — a dedicated client exhausts its own budget.
    const reader = nextClientIp();
    const reads = [];
    for (let index = 0; index < READ_MAX; index += 1) {
      reads.push(await as({ ip: reader, token: session.token }).get('/api/v1/projects'));
    }
    expect(reads.every((response) => response.status === 200)).toBe(true);
    expect((await as({ ip: reader, token: session.token }).get('/api/v1/projects')).status).toBe(429);

    // `write` — same shape, its own budget.
    const writer = nextClientIp();
    for (let index = 0; index < WRITE_MAX; index += 1) {
      expect(
        (await as({ ip: writer, token: session.token }).post('/api/v1/organizations').send({ name: 'x' }))
          .status,
      ).toBe(201);
    }
    expect(
      (await as({ ip: writer, token: session.token }).post('/api/v1/organizations').send({ name: 'y' }))
        .status,
    ).toBe(429);

    // `webhook.endpoint-create` and `webhook.replay` have their own budgets, and
    // both are counted before the handler runs: an unknown event still counts.
    const amplifier = nextClientIp();
    for (let index = 0; index < WEBHOOK_ENDPOINT_CREATE_MAX; index += 1) {
      expect(
        (
          await as({ ip: amplifier, token: session.token })
            .post(session.endpointsUrl)
            .send({ environment: 'test', url: `https://example.com/hook-${index}`, event_types: ['payment.created'] })
        ).status,
      ).toBe(201);
    }
    const endpointBlocked = await as({ ip: amplifier, token: session.token })
      .post(session.endpointsUrl)
      .send({ environment: 'test', url: 'https://example.com/hook-blocked', event_types: ['payment.created'] });
    expect(endpointBlocked.status).toBe(429);

    const replayer = nextClientIp();
    const replayUrl = `${session.endpointsUrl}/0192f2a0-0000-7000-8000-000000000005/events/0192f2a0-0000-7000-8000-000000000006/replay`;
    for (let index = 0; index < WEBHOOK_REPLAY_MAX; index += 1) {
      // Counted, then rejected by the handler: the unknown event is a 404.
      expect((await as({ ip: replayer, token: session.token }).post(replayUrl)).status).toBe(404);
    }
    const replayBlocked = await as({ ip: replayer, token: session.token }).post(replayUrl);
    expect(replayBlocked.status).toBe(429);
  });

  it('keeps the Phase 3 auth limits on the unchanged variables (AC10, D9)', async () => {
    requireDependencies(reachable);
    await setup('auth-regression');

    // One shared identity, distinct emails: only the `ip` budget can be the one
    // that is exhausted here, which is exactly the phase 3 dimension.
    const ip = nextClientIp();
    const attempts = [];
    for (let index = 0; index < AUTH_LOGIN_MAX; index += 1) {
      attempts.push(
        await as({ ip }).post('/api/v1/auth/login').send({ email: EMAIL(`guess-${index}`), password: 'nope' }),
      );
    }
    expect(attempts.every((response) => response.status === 401)).toBe(true);

    const throttled = await as({ ip })
      .post('/api/v1/auth/login')
      .send({ email: EMAIL('guess-over'), password: 'nope' });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
  });

  it('bounds one account across client identities (Phase 3 account dimension)', async () => {
    requireDependencies(reachable);
    await setup('account-dimension');
    const target = EMAIL('credential-stuffing-target');

    // One account, three different client identities: every one of them has a
    // full ip budget, so only the account budget can be the exhausted one.
    for (let index = 0; index < AUTH_LOGIN_MAX; index += 1) {
      const attempt = await as({ ip: nextClientIp() })
        .post('/api/v1/auth/login')
        .send({ email: target, password: 'nope' });
      expect(attempt.status).toBe(401);
    }
    const blocked = await as({ ip: nextClientIp() })
      .post('/api/v1/auth/login')
      .send({ email: target, password: 'nope' });
    expect(blocked.status).toBe(429);

    // A different account, from yet another client with a fresh budget.
    expect(
      (await as({ ip: nextClientIp() })
        .post('/api/v1/auth/login')
        .send({ email: EMAIL('someone-else'), password: 'nope' })).status,
    ).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Scopes and bucket isolation (AC3/AC4)
  // -------------------------------------------------------------------------

  it('charges an API-key mutation to both its ip and its key budget (AC3)', async () => {
    requireDependencies(reachable);
    const session = await setup('dual-scope', { withKey: true });
    const create = (options: { ip: string; key?: string; token?: string }, slug: string) =>
      as(options)
        .post(session.customersUrl)
        .send({ environment: 'test', email: EMAIL(slug) });

    // Exhaust the key's write budget from a single client.
    const writer = nextClientIp();
    const statuses: number[] = [];
    for (let index = 0; index < WRITE_MAX; index += 1) {
      statuses.push((await create({ ip: writer, key: session.key!.key }, `dual-${index}`)).status);
    }
    expect(statuses).toEqual(Array.from({ length: WRITE_MAX }, () => 201));

    // A **fresh client** presenting the same key is throttled: the ip budget has
    // room, so the key budget is the one that was charged.
    const freshClient = await create({ ip: nextClientIp(), key: session.key!.key }, 'dual-fresh');
    expect(freshClient.status).toBe(429);
    expect(asInteger(header(freshClient, 'RateLimit-Limit'))).toBe(WRITE_MAX);
    expect(asInteger(header(freshClient, 'RateLimit-Remaining'))).toBe(0);
  });

  it('rejects on an exhausted ip budget while the key budget still has room (AC3/D4)', async () => {
    requireDependencies(reachable);
    const session = await setup('dual-scope-ip', { withKey: true });
    const create = (ip: string, slug: string) =>
      as({ ip, key: session.key!.key })
        .post(session.customersUrl)
        .send({ environment: 'test', email: EMAIL(slug) });

    const client = nextClientIp();
    const statuses: number[] = [];
    for (let index = 0; index < WRITE_MAX + 1; index += 1) {
      statuses.push((await create(client, `scope-${index}`)).status);
    }
    // The key budget only spent WRITE_MAX - 1 units before the ip budget ran out.
    expect(statuses).toEqual([...Array.from({ length: WRITE_MAX }, () => 201), 429]);

    // Reported budget is the closest to exhaustion: the exhausted ip bucket, not
    // the key bucket which still had units left.
    const blocked = await create(client, 'scope-over');
    expect(asInteger(header(blocked, 'RateLimit-Remaining'))).toBe(0);
  });

  it('charges a session-authenticated request to the ip budget alone (AC3/D5)', async () => {
    requireDependencies(reachable);
    const session = await setup('session-only', { withKey: true, withCustomer: true });

    const ip = nextClientIp();
    for (let index = 0; index < READ_MAX; index += 1) {
      expect(
        (await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`)).status,
      ).toBe(200);
    }
    const throttled = await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    expect(throttled.status).toBe(429);
    // The same session using the very same API key is not throttled by that
    // key's budget: a session request has no api_key bucket at all.
    expect(
      (await as({ ip: nextClientIp(), key: session.key!.key }).get(`${session.customersUrl}?environment=test`))
        .status,
    ).toBe(200);
  });

  it('isolates budgets across keys, projects and clients (AC4)', async () => {
    requireDependencies(reachable);
    const first = await setup('isolation-a', { withKey: true, withCustomer: true });
    const secondKey = await as({ ip: setupIp(), token: first.token })
      .post(`/api/v1/projects/${first.projectId}/api-keys`)
      .send({ environment: 'test' });
    expect(secondKey.status).toBe(201);
    const otherTenant = await setup('isolation-b', { withKey: true, withCustomer: true });

    // Exhaust the first key's write budget from one client.
    const writer = nextClientIp();
    for (let index = 0; index < WRITE_MAX; index += 1) {
      expect(
        (await as({ ip: writer, key: first.key!.key }).post(first.customersUrl).send({ environment: 'test', email: EMAIL(`iso-${index}`) }))
          .status,
      ).toBe(201);
    }
    const blocked = await as({ ip: writer, key: first.key!.key })
      .post(first.customersUrl)
      .send({ environment: 'test', email: EMAIL('iso-over') });
    expect(blocked.status).toBe(429);

    // From clients whose ip budget is intact, the exhausted key blocks nothing:
    // a second key of the same project...
    expect(
      (await as({ ip: nextClientIp(), key: secondKey.body.key })
        .post(first.customersUrl)
        .send({ environment: 'test', email: EMAIL('iso-second-key') })).status,
    ).toBe(201);
    // ...a key of another project...
    expect(
      (await as({ ip: nextClientIp(), key: otherTenant.key!.key })
        .post(otherTenant.customersUrl)
        .send({ environment: 'test', email: EMAIL('iso-other-tenant') })).status,
    ).toBe(201);
    // ...and session traffic, which has no key budget at all.
    expect(
      (await as({ ip: nextClientIp(), token: first.token })
        .post(first.customersUrl)
        .send({ environment: 'test', email: EMAIL('iso-session') })).status,
    ).toBe(201);

    // The exhausted key itself stays exhausted for every client.
    expect(
      (await as({ ip: nextClientIp(), key: first.key!.key })
        .post(first.customersUrl)
        .send({ environment: 'test', email: EMAIL('iso-still-blocked') })).status,
    ).toBe(429);
  });

  it('separates clients behind the trusted proxy, and charges the identity the chain reports (D1)', async () => {
    requireDependencies(reachable);
    await setup('proxy-trust');

    // Two clients, one socket, one trusted hop: they hold separate budgets,
    // which is what a load-balanced deployment needs to work at all.
    const first = nextClientIp();
    const second = nextClientIp();
    for (let index = 0; index < READ_MAX; index += 1) {
      expect((await as({ ip: first }).get('/api/v1/projects')).status).toBe(401);
    }
    expect((await as({ ip: first }).get('/api/v1/projects')).status).toBe(429);

    // Claiming a *spent* identity buys nothing: the header a client presents is
    // the identity the charge lands on, so an exhausted identity stays exhausted
    // and `first` is throttled throughout. A *fresh* claimed identity does get its
    // own budget — that is exactly what this trust model charges, and it is why
    // §10.7 requires the proxy to append rather than forward (behind an appending
    // proxy the caller never chooses which entry is read; here, with the trusted
    // peer acting as a pass-through, it does).
    for (let index = 0; index < READ_MAX; index += 1) {
      expect((await as({ ip: second }).get('/api/v1/projects')).status).toBe(401);
    }
    expect((await as({ ip: second }).get('/api/v1/projects')).status).toBe(429);
    expect((await as({ ip: first }).get('/api/v1/projects')).status).toBe(429);
  });

  // -------------------------------------------------------------------------
  // Headers (AC7, §4.4)
  // -------------------------------------------------------------------------

  it('reports the budget on allowed and rejected responses, with an integer Retry-After (AC7)', async () => {
    requireDependencies(reachable);
    const session = await setup('headers', { withCustomer: true });
    const ip = nextClientIp();

    const allowed = await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    expect(allowed.status).toBe(200);
    expect(asInteger(header(allowed, 'RateLimit-Limit'))).toBe(READ_MAX);
    expect(asInteger(header(allowed, 'RateLimit-Remaining'))).toBe(READ_MAX - 1);
    const reset = asInteger(header(allowed, 'RateLimit-Reset'));
    expect(Number.isInteger(reset)).toBe(true);
    expect(reset).toBeGreaterThan(0);
    expect(header(allowed, 'Retry-After')).toBeUndefined();

    await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);

    const rejected = await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    expect(rejected.status).toBe(429);
    expect(header(rejected, 'RateLimit-Limit')).toBe(String(READ_MAX));
    expect(header(rejected, 'RateLimit-Remaining')).toBe('0');

    const retryAfter = asInteger(header(rejected, 'Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // Derived from the same atomic read as the reset, never a guess.
    expect(header(rejected, 'RateLimit-Reset')).toBe(String(retryAfter));
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it('exposes exactly the four budget headers to a cross-origin browser client (AC7, §4.4 point 6)', async () => {
    requireDependencies(reachable);
    const session = await setup('cors');

    const preflight = await request(server())
      .options('/api/v1/projects')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'GET');
    expect([200, 204]).toContain(preflight.status);

    const exposed = String(header(preflight, 'Access-Control-Expose-Headers') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    expect(exposed.sort()).toEqual([
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ]);

    // Nothing internal is exposed: no scope, class or discriminator name, and no
    // session or credential material.
    const dump = exposed.join(' ');
    for (const secret of ['api_key', 'account', 'brinnpay:rl', session.token, session.userId]) {
      expect(dump).not.toContain(secret);
    }

    const allowed = await request(server())
      .get('/api/v1/projects')
      .set('Origin', 'http://localhost:3001')
      .set('X-Forwarded-For', nextClientIp());
    expect(header(allowed, 'Access-Control-Expose-Headers')).toContain('RateLimit-Remaining');
    expect(asInteger(header(allowed, 'RateLimit-Remaining'))).toBe(READ_MAX - 1);
  });

  // -------------------------------------------------------------------------
  // Exclusions (AC9)
  // -------------------------------------------------------------------------

  it('never counts and never throttles the excluded surfaces, even under saturation (AC9)', async () => {
    requireDependencies(reachable);
    const session = await setup('exclusions');
    const ip = nextClientIp();

    for (let index = 0; index < READ_MAX; index += 1) {
      await as({ ip, token: session.token }).get('/api/v1/projects');
    }
    const throttled = await as({ ip, token: session.token }).get('/api/v1/projects');
    expect(throttled.status).toBe(429);

    // Health probes must never receive a 429: a throttled readiness probe would
    // remove a healthy instance from rotation.
    await request(server()).get('/health/live').expect(200);
    await request(server()).get('/health/ready').expect(200);

    // Swagger UI traffic is outside the API prefix.
    const swagger = await request(server()).get('/docs');
    expect(swagger.status).not.toBe(429);

    // A CORS preflight on the saturated route.
    const preflight = await request(server())
      .options('/api/v1/projects')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'GET');
    expect([200, 204]).toContain(preflight.status);

    // The saturation is still in force afterwards: nothing above reset a bucket.
    expect((await as({ ip, token: session.token }).get('/api/v1/projects')).status).toBe(429);
  });

  // -------------------------------------------------------------------------
  // Observability (AC14) and idempotency (AC15)
  // -------------------------------------------------------------------------

  it('request-logs a throttled request and writes no audit entry for it (AC14, D13)', async () => {
    requireDependencies(reachable);
    const session = await setup('observability');

    const ip = nextClientIp();
    for (let index = 0; index < WRITE_MAX; index += 1) {
      await as({ ip, token: session.token })
        .post('/api/v1/organizations')
        .send({ name: `rl13-allowed-${index}-${RUN}` });
    }
    const blocked = await as({ ip, token: session.token })
      .post('/api/v1/organizations')
      .send({ name: `rl13-blocked-${RUN}` });
    expect(blocked.status).toBe(429);

    // A throttled request is still a request: it produces a request-log row...
    const requestId = blocked.headers['x-request-id'] as string;
    const row = await rowFor(requestId);
    expect(row).toMatchObject({ statusCode: 429, method: 'POST' });
    // The limiter runs before authentication, so no scope was resolved when the
    // request was rejected — phase 11 rule 5 records a null scope, exactly as it
    // does for a 401.
    expect(row.userId).toBeNull();
    expect(row.projectId).toBeNull();

    // ...and no audit entry: nothing was changed, so nothing is accountable.
    const auditEntries = await prisma.auditLogEntry.count({
      where: { organizationId: session.organizationId },
    });
    expect(auditEntries).toBe(0);
    expect(
      await prisma.organization.count({ where: { name: `rl13-blocked-${RUN}` } }),
    ).toBe(0);
  });

  it('counts an idempotent replay and keeps the key usable after a 429 (AC15)', async () => {
    requireDependencies(reachable);
    const session = await setup('idempotency', { withCustomer: true, withKey: true });
    const idempotencyKey = `rl13-idem-${RUN}`;

    const created = await as({ ip: nextClientIp(), key: session.key!.key })
      .post(session.paymentsUrl)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        environment: 'test',
        customer_id: session.customerId,
        amount: '10.00',
        currency: 'usd',
      });
    expect(created.status).toBe(201);

    // A replay is a countable request like any other, and it still replays.
    const replay = await as({ ip: nextClientIp(), key: session.key!.key })
      .post(session.paymentsUrl)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        environment: 'test',
        customer_id: session.customerId,
        amount: '10.00',
        currency: 'usd',
      });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created.body.id);
    expect(await prisma.payment.count({ where: { projectId: session.projectId } })).toBe(1);

    // Exhaust the key's write budget, which the payment creation already spent one
    // unit of, and get a 429 on an idempotent mutation.
    const ip = nextClientIp();
    const create = () =>
      as({ ip, key: session.key!.key })
        .post(session.paymentsUrl)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          environment: 'test',
          customer_id: session.customerId,
          amount: '10.00',
          currency: 'usd',
        });

    const statuses: number[] = [];
    for (let index = 0; index < WRITE_MAX + 1; index += 1) {
      statuses.push((await create()).status);
    }
    // The two replayed requests above are countable requests, so they spent two of
    // this key's WRITE_MAX units before the loop started: two replays are served
    // and the rest are throttled, which changes nothing about the stored response.
    expect(statuses).toEqual([201, 201, 429, 429, 429]);
    expect(await prisma.payment.count({ where: { projectId: session.projectId } })).toBe(1);

    // A 429 stores nothing for the idempotency capability, so the same key is
    // still usable by a later, correct request. Session mode is used here
    // precisely because that key's write budget is spent: what is being proven is
    // that the throttled attempts left no record behind, not that the key is
    // exempt from limits.
    const reused = await as({ ip: nextClientIp(), token: session.token })
      .post(session.paymentsUrl)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        environment: 'test',
        customer_id: session.customerId,
        amount: '10.00',
        currency: 'usd',
      });
    expect(reused.status).toBe(201);
    expect(reused.body.id).toBe(created.body.id);
  });

  it('never lets the limiter turn a 401 or a 404 into a 200 (AC6/§8)', async () => {
    requireDependencies(reachable);
    const session = await setup('no-escalation');

    // Unknown project: a 404, not a 200 and not a 429.
    const unknown = await as({ ip: nextClientIp(), token: session.token }).get(
      '/api/v1/projects/00000000-0000-7000-8000-000000000000/logs/requests',
    );
    expect(unknown.status).toBe(404);

    // A revoked/unknown API key: the generic 401 the key guard produces.
    const badKey = await as({ ip: nextClientIp(), key: 'sk_test_not-a-real-key' }).get(
      `${session.customersUrl}?environment=test`,
    );
    expect(badKey.status).toBe(401);
    expect(badKey.body.error.code).toBe('UNAUTHENTICATED');
    // The 401 discloses nothing about the limiter's state or any identity.
    expect(JSON.stringify(badKey.body)).not.toContain('203.0.113');
    expect(JSON.stringify(badKey.body)).not.toContain('brinnpay:rl');
  });

  it('keeps a 429 free of any identity (AC6/§8 non-disclosure)', async () => {
    requireDependencies(reachable);
    const session = await setup('non-disclosure', { withCustomer: true });
    const ip = nextClientIp();

    for (let index = 0; index < READ_MAX; index += 1) {
      await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    }
    const blocked = await as({ ip, token: session.token }).get(`${session.customersUrl}?environment=test`);
    expect(blocked.status).toBe(429);

    const dump = JSON.stringify(blocked.body);
    for (const secret of [ip, session.userId, session.projectId, session.token, 'brinnpay:rl']) {
      expect(dump).not.toContain(secret);
    }
    // Budget numbers only.
    expect(blocked.body.error.details).toEqual({
      limit: READ_MAX,
      remaining: 0,
      window_seconds: 900,
    });
    expect(blocked.headers['x-request-id']).toBe(blocked.body.error.request_id);
  });
});
/**
 * The Redis-unavailability posture end to end (phase 13 D8, AC12), in a second
 * application booted with an unreachable Redis and `RATE_LIMIT_FAIL_MODE=closed`.
 *
 * What matters is that a limiter outage is never an API outage: a request that
 * would otherwise succeed is answered `429`, never `5xx`, and liveness — the
 * signal an orchestrator uses to decide whether the *process* is alive — is
 * untouched. Readiness reports the `redis` dependency, which is phase 2 D9's
 * existing contract and is not something the limiter can or does alter.
 */
describe('rate limiting with Redis unavailable (Phase 13 D8)', () => {
  let degradedApp: INestApplication;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const overrides: Record<string, string> = {
      REDIS_URL: 'redis://127.0.0.1:1',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
    for (const key of Object.keys(overrides)) {
      saved[key] = process.env[key];
      process.env[key] = overrides[key];
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    degradedApp = moduleRef.createNestApplication();
    configureApp(degradedApp, degradedApp.get(ConfigService));
    await degradedApp.init();
  });

  afterAll(async () => {
    if (degradedApp) await degradedApp.close();
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('rejects with 429 rather than 5xx, and keeps liveness up', async () => {
    const rejected = await request(degradedApp.getHttpServer()).get('/api/v1/projects');
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.code).toBe('RATE_LIMITED');
    // Budget numbers only, and an integer retry hint: the client is told when to
    // come back, never anything about the outage.
    expect(rejected.body.error.details).toMatchObject({ remaining: 0 });
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);

    await request(degradedApp.getHttpServer()).get('/health/live').expect(200);

    const ready = await request(degradedApp.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(503);
    // Phase 2 D9: the failing dependency is named, and it is Redis itself — the
    // limiter contributes no separate readiness condition of its own.
    expect(Object.keys(ready.body.checks)).toEqual(['redis']);
  });
});
