import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uuidv7 } from '../src/common/uuid/uuid';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { RequestLogStoreService } from '../src/request-logging/request-log-store.service';

/**
 * Phase 11 e2e (§9/§10) against real PostgreSQL:
 *
 * - **capture (AC2/AC4)** — one row per `/api/v1` request whatever the outcome,
 *   correlated with `X-Request-Id` and the error envelope; exclusions (health,
 *   Swagger, CORS preflight) produce none; both auth modes populate scope.
 * - **redaction (AC6/§8)** — login, API-key creation, idempotent payment
 *   creation and webhook-endpoint creation leave no secret in any row.
 * - **read surface (AC7–AC10)** — session-only authority, the D2 matrix, 404
 *   non-disclosure, cursor pagination, and the two confirmed filters.
 * - **retention and cascade (AC11)** — the cleanup pass drops expired rows and
 *   deleting a project/organization leaves no orphaned row.
 *
 * Writes happen after the response is sent, so reads poll for the row rather
 * than assuming it is visible immediately (§4.2 rule 1 accepts that lag).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-logs-${slug}-${RUN}@example.com`;
const PASSWORD = 'Logs-Passw0rd-Sup3rSecret';
const RETENTION_DAYS = 30;

jest.setTimeout(120_000);

type Row = {
  id: string;
  requestId: string;
  projectId: string | null;
  organizationId: string | null;
  userId: string | null;
  apiKeyId: string | null;
  environment: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number | null;
  createdAt: Date;
};

describe('request logging (Phase 11, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let store: RequestLogStoreService;
  let reachable = false;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();

    prisma = app.get(PrismaService);
    store = app.get(RequestLogStoreService);
    try {
      await prisma.ping();
      await app.get(RedisService).ping();
      reachable = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(async () => {
    if (!reachable) return;
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: `logs11-`, endsWith: `-${RUN}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    const organizationIds = projects.map((project) => project.organizationId);
    if (projectIds.length) {
      await prisma.requestLog.deleteMany({ where: { projectId: { in: projectIds } } });
      // Payments reference customers with `onDelete: Restrict`, so they have to
      // go before the customers they point at; everything else cascades from the
      // project below.
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }
    // Rows captured for auth/organization traffic keep an organization scope
    // only; remove those explicitly so the suite is repeatable.
    const allOrgs = await prisma.organization.findMany({
      where: { name: { startsWith: `logs11-`, endsWith: `-${RUN}` } },
      select: { id: true },
    });
    const everyOrgId = [...new Set([...organizationIds, ...allOrgs.map((org) => org.id)])];
    if (everyOrgId.length) {
      await prisma.requestLog.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.invitation.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.organizationMember.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.organization.deleteMany({ where: { id: { in: everyOrgId } } });
    }
    // Auth-route rows (`/auth/*`) carry a user scope and nothing else.
    const users = await prisma.user.findMany({
      where: { email: { startsWith: 'e2e-logs-', endsWith: `-${RUN}@example.com` } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length) {
      await prisma.requestLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const auth = (token: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));

  const requestIdOf = (response: request.Response) =>
    response.headers['x-request-id'] as string;

  /** Polls for the post-response write (§4.2 rule 1 accepts a visibility lag). */
  async function rowFor(requestId: string): Promise<Row> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await prisma.requestLog.findMany({
        where: { requestId },
        orderBy: { id: 'asc' },
        take: 1,
      });
      if (rows.length > 0) return rows[0] as Row;
      if (Date.now() > deadline) {
        throw new Error(`No request log row appeared for ${requestId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const register = async (slug: string, password = PASSWORD) => {
    const response = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: EMAIL(slug), password, name: `Logs E2E ${slug}` });
    expect(response.status).toBe(201);
    return { token: response.body.access_token as string, user: response.body.user as { id: string; email: string } };
  };

  const createOrg = async (token: string, name: string) => {
    const response = await auth(token).post('/api/v1/organizations').send({ name });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const createProject = async (token: string, organizationId: string, name: string) => {
    const response = await auth(token).post('/api/v1/projects').send({ organization_id: organizationId, name });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const invite = async (token: string, organizationId: string, email: string, role: string) => {
    const response = await auth(token)
      .post(`/api/v1/organizations/${organizationId}/invitations`)
      .send({ email, role });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const accept = (token: string, invitationId: string) =>
    auth(token).post(`/api/v1/invitations/${invitationId}/accept`);

  const createApiKey = async (token: string, projectId: string, environment: string) => {
    const response = await auth(token).post(`/api/v1/projects/${projectId}/api-keys`).send({ environment });
    expect(response.status).toBe(201);
    return response.body as { id: string; key: string; environment: string };
  };

  /** Registers an owner with an org, a project and a customer, in one call. */
  async function setup(slug: string) {
    const owner = await register(`owner-${slug}`);
    const organization = await createOrg(owner.token, `logs11-${slug}-${RUN}`);
    const project = await createProject(owner.token, organization.id, `Logs ${slug}`);
    const customer = await auth(owner.token)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ environment: 'test', email: EMAIL(`customer-${slug}`) })
      .expect(201);
    return {
      owner,
      organizationId: organization.id,
      projectId: project.id,
      customerId: customer.body.id as string,
      logsUrl: `/api/v1/projects/${project.id}/logs/requests`,
      customersUrl: `/api/v1/projects/${project.id}/customers`,
    };
  }

  /** Writes a row directly, the way a captured request would have. */
  async function seed(overrides: Partial<Row> = {}): Promise<Row> {
    const createdAt = overrides.createdAt ?? new Date();
    const id = overrides.id ?? uuidv7(createdAt.getTime());
    const row = await prisma.requestLog.create({
      data: {
        id,
        requestId: overrides.requestId ?? `req_${id.replace(/-/g, '')}`,
        projectId: overrides.projectId ?? null,
        organizationId: overrides.organizationId ?? null,
        userId: overrides.userId ?? null,
        apiKeyId: overrides.apiKeyId ?? null,
        environment: overrides.environment ?? null,
        method: overrides.method ?? 'GET',
        path: overrides.path ?? '/api/v1/seeded',
        statusCode: overrides.statusCode ?? 200,
        durationMs: overrides.durationMs ?? 5,
        createdAt,
      },
    });
    return row as Row;
  }

  // -------------------------------------------------------------------------
  // Capture (AC2–AC4)
  // -------------------------------------------------------------------------

  it('persists one row per API request, correlated with the response header and the error envelope (AC2/AC3)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, customersUrl } = await setup('capture');

    const created = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('capture-row') })
      .expect(201);
    const createdRequestId = requestIdOf(created);
    expect(createdRequestId).toMatch(/^req_[0-9a-f]{32}$/);

    const row = await rowFor(createdRequestId);
    expect(row).toMatchObject({
      requestId: createdRequestId,
      projectId,
      organizationId,
      userId: owner.user.id,
      apiKeyId: null,
      method: 'POST',
      path: customersUrl,
      statusCode: 201,
    });
    expect(row.path).not.toContain('?');
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    // The write is post-response, so the timestamp is at or after the request.
    expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // A validation failure is a request like any other, and its envelope repeats
    // the very id stored on its row.
    const rejected = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: 'not-an-email-address' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    const rejectedRequestId = requestIdOf(rejected);
    expect(rejected.body.error.request_id).toBe(rejectedRequestId);

    const rejectedRow = await rowFor(rejectedRequestId);
    expect(rejectedRow).toMatchObject({
      method: 'POST',
      path: customersUrl,
      statusCode: 400,
      projectId,
      userId: owner.user.id,
    });
  });

  it('records nothing for health probes, Swagger UI traffic, or CORS preflights (AC2, D7)', async () => {
    if (!reachable) return;
    const { owner, organizationId } = await setup('excluded');
    const startedAt = new Date(Date.now() - 1_000);

    await request(server()).get('/health/live').expect(200);
    await request(server()).get('/health/ready').expect(200);
    // Swagger mounts outside the API prefix; whatever its status, it is not API
    // traffic and must not be persisted.
    await request(server()).get('/docs');
    const preflight = await request(server())
      .options(`/api/v1/projects`)
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect([200, 204]).toContain(preflight.status);

    const rows = await prisma.requestLog.findMany({
      where: {
        createdAt: { gte: startedAt },
        organizationId,
      },
    });
    const paths = rows.map((row) => row.path);
    expect(paths).not.toContain('/health/live');
    expect(paths).not.toContain('/health/ready');
    expect(paths).not.toContain('/docs');
    expect(rows.some((row) => row.method === 'OPTIONS')).toBe(false);
    // The setup's own project/customer creations are persisted, so the pass
    // above is not vacuous.
    expect(rows.length).toBeGreaterThan(0);
    expect(owner.user.id).toBeTruthy();
  });

  it('records unauthenticated and unknown-project requests with null scope (AC2/AC4)', async () => {
    if (!reachable) return;
    const { owner } = await setup('scope');

    const unauthorized = await request(server()).get('/api/v1/projects');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.code).toBe('UNAUTHENTICATED');
    const unauthorizedRow = await rowFor(requestIdOf(unauthorized));
    expect(unauthorizedRow).toMatchObject({
      statusCode: 401,
      projectId: null,
      organizationId: null,
      userId: null,
      apiKeyId: null,
      environment: null,
    });

    // Authenticated, but the project does not exist: scope stops where the
    // request failed (rule 5), and the 404 discloses nothing.
    const unknown = await auth(owner.token).get(
      '/api/v1/projects/00000000-0000-7000-8000-000000000000/logs/requests',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    const unknownRow = await rowFor(requestIdOf(unknown));
    expect(unknownRow).toMatchObject({
      statusCode: 404,
      projectId: null,
      organizationId: null,
      userId: owner.user.id,
      apiKeyId: null,
    });
  });

  it('records API-key requests with the key scope, and session requests with a validated environment (AC4, D1)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, customersUrl, logsUrl } = await setup('modes');
    const key = await createApiKey(owner.token, projectId, 'test');

    const viaKey = await request(server())
      .get(`${customersUrl}?environment=test&limit=5`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);
    const keyRow = await rowFor(requestIdOf(viaKey));
    expect(keyRow).toMatchObject({
      projectId,
      organizationId,
      userId: null,
      apiKeyId: key.id,
      environment: 'test',
      method: 'GET',
      statusCode: 200,
    });
    expect(keyRow.path).toBe(customersUrl);

    // Session mode: the environment comes from the validated query parameter,
    // and the query string itself is never stored (D6).
    const viaSession = await auth(owner.token).get(`${logsUrl}?environment=test`).expect(200);
    const sessionRow = await rowFor(requestIdOf(viaSession));
    expect(sessionRow).toMatchObject({
      projectId,
      organizationId,
      userId: owner.user.id,
      apiKeyId: null,
      environment: 'test',
      path: logsUrl,
    });
    expect(sessionRow.path).not.toContain('environment');
  });

  // -------------------------------------------------------------------------
  // Redaction / allowlist (AC6, §8)
  // -------------------------------------------------------------------------

  it('leaks no password, API key, Idempotency-Key, or signing secret into any row (AC6, §8)', async () => {
    if (!reachable) return;
    const owner = await register('secrets');
    const organization = await createOrg(owner.token, `logs11-secrets-${RUN}`);
    const project = await createProject(owner.token, organization.id, 'Logs secrets');
    const customersUrl = `/api/v1/projects/${project.id}/customers`;
    const seen: string[] = [];

    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL('secrets'), password: PASSWORD })
      .expect(200);
    seen.push(requestIdOf(login));

    const keyCreate = await auth(owner.token)
      .post(`/api/v1/projects/${project.id}/api-keys`)
      .send({ environment: 'test' });
    expect(keyCreate.status).toBe(201);
    seen.push(requestIdOf(keyCreate));
    const firstPlaintext = keyCreate.body.key as string;

    const keyCreateAgain = await auth(owner.token)
      .post(`/api/v1/projects/${project.id}/api-keys`)
      .send({ environment: 'test' });
    expect(keyCreateAgain.status).toBe(201);
    seen.push(requestIdOf(keyCreateAgain));
    const secondPlaintext = keyCreateAgain.body.key as string;

    const customer = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('secrets-customer') })
      .expect(201);
    seen.push(requestIdOf(customer));

    const idempotencyKey = `idem-${RUN}-secret-value`;
    const payment = await auth(owner.token)
      .post(`/api/v1/projects/${project.id}/payments`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        environment: 'test',
        customer_id: customer.body.id,
        amount: '10.00',
        currency: 'usd',
      })
      .expect(201);
    seen.push(requestIdOf(payment));

    const endpoint = await auth(owner.token)
      .post(`/api/v1/projects/${project.id}/webhook-endpoints`)
      .send({
        environment: 'test',
        url: 'https://example.com/hook',
        event_types: ['payment.created'],
      })
      .expect(201);
    seen.push(requestIdOf(endpoint));
    const signingSecret = endpoint.body.signing_secret as string;
    expect(signingSecret).toBeTruthy();

    const rows = await Promise.all(seen.map((requestId) => rowFor(requestId)));
    const dump = JSON.stringify(rows);

    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(firstPlaintext);
    expect(dump).not.toContain(secondPlaintext);
    expect(dump).not.toContain(idempotencyKey);
    expect(dump).not.toContain(signingSecret);
    // The stored shape is the metadata allowlist — never a body or a header.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'apiKeyId',
        'createdAt',
        'durationMs',
        'environment',
        'id',
        'method',
        'organizationId',
        'path',
        'projectId',
        'requestId',
        'statusCode',
        'userId',
      ]);
      expect(row.path).not.toContain('?');
    }
  });

  // -------------------------------------------------------------------------
  // Read surface (AC7–AC10)
  // -------------------------------------------------------------------------

  it('is session-only and available to every role of the D2 matrix (AC7, F6)', async () => {
    if (!reachable) return;

    // A four-role team so the matrix is exercised through real memberships.
    const owner = await register('matrix-owner');
    const admin = await register('matrix-admin');
    const member = await register('matrix-member');
    const viewer = await register('matrix-viewer');
    const organization = await createOrg(owner.token, `logs11-matrix-${RUN}`);
    const project = await createProject(owner.token, organization.id, 'Logs matrix');
    const logsUrl = `/api/v1/projects/${project.id}/logs/requests`;

    await invite(owner.token, organization.id, admin.user.email, 'admin');
    await invite(owner.token, organization.id, member.user.email, 'member');
    await invite(owner.token, organization.id, viewer.user.email, 'viewer');
    const invitations = (
      await auth(owner.token).get(`/api/v1/organizations/${organization.id}/invitations`).expect(200)
    ).body.data as { id: string; email: string }[];
    for (const invitation of invitations) {
      const target = invitation.email === admin.user.email
        ? admin
        : invitation.email === member.user.email
          ? member
          : viewer;
      await accept(target.token, invitation.id).expect(201);
    }

    // 401 — no session, a malformed session, and an API key (F6).
    const anonymous = await request(server()).get(logsUrl);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    await request(server()).get(logsUrl).set('Authorization', 'Bearer not-a-jwt').expect(401);

    const apiKey = await createApiKey(owner.token, project.id, 'test');
    const viaKey = await request(server()).get(logsUrl).set('Authorization', `Bearer ${apiKey.key}`);
    expect(viaKey.status).toBe(401);
    expect(viaKey.body.error.code).toBe('UNAUTHENTICATED');

    // 200 — every role of the confirmed matrix.
    for (const actor of [owner, admin, member, viewer]) {
      const response = await auth(actor.token).get(logsUrl).expect(200);
      expect(Object.keys(response.body).sort()).toEqual(['data', 'has_more', 'next_cursor']);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(typeof response.body.has_more).toBe('boolean');
      expect(response.body.next_cursor === null || typeof response.body.next_cursor === 'string').toBe(true);
    }

    // 404 — unknown and foreign projects, indistinguishable from one another.
    await auth(owner.token)
      .get('/api/v1/projects/00000000-0000-7000-8000-000000000000/logs/requests')
      .expect(404);
    const stranger = await register('matrix-stranger');
    const foreign = await auth(stranger.token).get(logsUrl);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');

    // A non-member 404 is indistinguishable from an unknown project in the
    // request log too (rule 5): its row carries no project/organization scope,
    // so an outsider can never write rows into a foreign tenant's log.
    const foreignRow = await rowFor(requestIdOf(foreign));
    expect(foreignRow).toMatchObject({
      statusCode: 404,
      projectId: null,
      organizationId: null,
      userId: stranger.user.id,
    });
  });

  it('applies the D1 environment semantics and never crosses projects (AC9)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, logsUrl } = await setup('filter-env');

    const otherOwner = await register('filter-env-other');
    const otherOrg = await createOrg(otherOwner.token, `logs11-filter-other-${RUN}`);
    const otherProject = await createProject(otherOwner.token, otherOrg.id, 'Logs other');
    const otherRow = await seed({ projectId: otherProject.id, organizationId: otherOrg.id, environment: 'test' });

    const testRow = await seed({ projectId, organizationId, environment: 'test' });
    const liveRow = await seed({ projectId, organizationId, environment: 'live' });
    const withoutEnvironment = await seed({ projectId, organizationId, environment: null });

    const all = await auth(owner.token).get(logsUrl).expect(200);
    const allIds = (all.body.data as { id: string }[]).map((row) => row.id);
    expect(allIds).toEqual(expect.arrayContaining([testRow.id, liveRow.id, withoutEnvironment.id]));
    expect(allIds).not.toContain(otherRow.id);

    const testOnly = await auth(owner.token).get(`${logsUrl}?environment=test`).expect(200);
    const testIds = (testOnly.body.data as { id: string; environment: string | null }[]).map((row) => row.id);
    expect(testIds).toContain(testRow.id);
    expect(testIds).not.toContain(liveRow.id);
    expect(testIds).not.toContain(withoutEnvironment.id);
    expect(testOnly.body.data.every((row: { environment: string }) => row.environment === 'test')).toBe(true);

    const liveOnly = await auth(owner.token).get(`${logsUrl}?environment=live`).expect(200);
    const liveIds = (liveOnly.body.data as { id: string }[]).map((row) => row.id);
    expect(liveIds).toContain(liveRow.id);
    expect(liveIds).not.toContain(testRow.id);
    expect(liveIds).not.toContain(withoutEnvironment.id);

    // An invalid value is a field error, not an empty page.
    const invalid = await auth(owner.token).get(`${logsUrl}?environment=staging`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(invalid.body.error.details.fields)).toContain('environment');
  });

  it('returns stable, non-overlapping ascending pages and rejects malformed paging (AC8, D4)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, logsUrl } = await setup('paging');

    // Seeded rows are older than anything the suite captures, so the first page
    // is deterministic regardless of when a captured row lands.
    const base = Date.now() - 3_600_000;
    const seeded = [];
    for (let index = 0; index < 3; index += 1) {
      seeded.push(
        await seed({
          projectId,
          organizationId,
          createdAt: new Date(base + index * 1_000),
          path: `/api/v1/seeded/${index}`,
        }),
      );
    }

    const first = await auth(owner.token).get(`${logsUrl}?limit=2`).expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.has_more).toBe(true);
    expect(first.body.next_cursor).toBe(first.body.data[1].id);
    const firstIds = (first.body.data as { id: string }[]).map((row) => row.id);
    expect(firstIds).toEqual([seeded[0].id, seeded[1].id]);

    const second = await auth(owner.token)
      .get(`${logsUrl}?limit=2&cursor=${first.body.next_cursor}`)
      .expect(200);
    const secondIds = (second.body.data as { id: string }[]).map((row) => row.id);
    expect(secondIds[0]).toBe(seeded[2].id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    // The default limit is 20; an explicit one beyond the ceiling is rejected.
    const defaulted = await auth(owner.token).get(logsUrl).expect(200);
    expect(defaulted.body.data.length).toBeLessThanOrEqual(20);

    for (const query of ['?limit=101', '?limit=0', '?cursor=not-a-uuid', '?sort=desc', '?request_id=nope']) {
      const rejected = await auth(owner.token).get(`${logsUrl}${query}`);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('resolves an exact request id inside the project, or an empty page — never 404 (AC10, D8)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, logsUrl } = await setup('request-id');

    const otherOwner = await register('request-id-other');
    const otherOrg = await createOrg(otherOwner.token, `logs11-rid-other-${RUN}`);
    const otherProject = await createProject(otherOwner.token, otherOrg.id, 'Logs rid other');
    const otherRow = await seed({ projectId: otherProject.id, organizationId: otherOrg.id });

    const wanted = await seed({ projectId, organizationId });

    const found = await auth(owner.token).get(`${logsUrl}?request_id=${wanted.requestId}`).expect(200);
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].id).toBe(wanted.id);
    expect(found.body.data[0].request_id).toBe(wanted.requestId);

    const missing = await auth(owner.token)
      .get(`${logsUrl}?request_id=req_${'f'.repeat(32)}`)
      .expect(200);
    expect(missing.body).toEqual({ data: [], next_cursor: null, has_more: false });

    // Another project's request id is invisible through this project's filter.
    const crossProject = await auth(owner.token)
      .get(`${logsUrl}?request_id=${otherRow.requestId}`)
      .expect(200);
    expect(crossProject.body).toEqual({ data: [], next_cursor: null, has_more: false });

    const malformed = await auth(owner.token).get(`${logsUrl}?request_id=req_zzz`);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(malformed.body.error.details.fields)).toContain('request_id');
  });

  // -------------------------------------------------------------------------
  // Retention and tenant cascade (AC11)
  // -------------------------------------------------------------------------

  it('drops rows past retention and leaves the fresh ones, then follows tenant deletion (AC11, D5)', async () => {
    if (!reachable) return;
    const { owner, organizationId, projectId, logsUrl } = await setup('retention');

    const expired = await seed({
      projectId,
      organizationId,
      createdAt: new Date(Date.now() - (RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000),
      path: '/api/v1/expired',
    });
    const fresh = await seed({ projectId, organizationId, path: '/api/v1/fresh' });
    const orgScoped = await seed({ projectId: null, organizationId, path: '/api/v1/org-scoped' });

    const removed = await store.cleanupExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.requestLog.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.requestLog.findUnique({ where: { id: fresh.id } })).not.toBeNull();

    // Tenant cascade: the project's rows go with it, and the list is empty for a
    // project that no longer exists.
    await auth(owner.token).delete(`/api/v1/projects/${projectId}`).expect(204);
    expect(await prisma.requestLog.count({ where: { projectId } })).toBe(0);

    // Organization cascade: rows scoped to the organization only disappear too.
    expect(await prisma.requestLog.findUnique({ where: { id: orgScoped.id } })).not.toBeNull();
    await auth(owner.token).delete(`/api/v1/organizations/${organizationId}`).expect(204);
    expect(await prisma.requestLog.findUnique({ where: { id: orgScoped.id } })).toBeNull();

    // No orphaned tenant data remains queryable through the API either.
    const after = await auth(owner.token).get(logsUrl);
    expect([404, 403]).toContain(after.status);
  });
});
