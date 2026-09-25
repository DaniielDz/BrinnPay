import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Phase 6 e2e (§9): the customers surface behind the dual-mode boundary
 * (D8) — session-mode CRUD + the project capability matrix (D5), API-key-mode
 * (project, environment) scoping with non-disclosure 404s (D6), the
 * environment-resolution/mismatch rules (D2), search (D3), metadata
 * constraints (D4), email normalization + non-uniqueness (D1), and the
 * no-op/updated_at semantics of partial updates (D7). CI provides
 * PostgreSQL/Redis as service containers; locally the suite skips when they
 * are unreachable (same pattern as Phases 3–5).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-cust-${slug}-${RUN}@example.com`;
const PASSWORD = 'password-123';

interface Reachable {
  value: boolean;
}

describe('BrinnPay customers (e2e, phase 6)', () => {
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
      await prisma.customer.deleteMany();
      await prisma.apiKey.deleteMany();
      await prisma.project.deleteMany();
      await prisma.invitation.deleteMany();
      await prisma.organizationMember.deleteMany();
      await prisma.organization.deleteMany();
      await prisma.refreshSession.deleteMany();
      await prisma.user.deleteMany();
      // Reset the auth rate-limit counters so repeated local runs (and the
      // 900s window) stay deterministic (phase 3 D7, phase 6 §9).
      const rateLimitKeys = await redis.connection.keys('auth:rl:*');
      if (rateLimitKeys.length > 0) {
        await redis.connection.del(rateLimitKeys);
      }
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const register = async (slug: string) => {
    const response = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: EMAIL(slug), password: PASSWORD, name: `Cust E2E ${slug}` });
    expect(response.status).toBe(201);
    return {
      token: response.body.access_token as string,
      user: response.body.user as { id: string; email: string },
    };
  };

  const auth = (token: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));

  const createOrg = async (token: string, name: string) => {
    const response = await auth(token).post('/api/v1/organizations').send({ name });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const invite = async (token: string, orgId: string, email: string, role: string) => {
    const response = await auth(token)
      .post(`/api/v1/organizations/${orgId}/invitations`)
      .send({ email, role });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const accept = (token: string, invitationId: string) => auth(token).post(`/api/v1/invitations/${invitationId}/accept`);

  /** Builds an org owned by `owner` with admin/member/viewer members. */
  let teamSeq = 0;
  const buildTeam = async () => {
    teamSeq += 1;
    const seq = teamSeq.toString(36);
    const owner = await register(`team-owner-${seq}`);
    const admin = await register(`team-admin-${seq}`);
    const member = await register(`team-member-${seq}`);
    const viewer = await register(`team-viewer-${seq}`);
    const org = await createOrg(owner.token, 'Customer Team Org');

    await invite(owner.token, org.id, admin.user.email, 'admin');
    await invite(owner.token, org.id, member.user.email, 'member');
    await invite(owner.token, org.id, viewer.user.email, 'viewer');
    const invitations = (
      await auth(owner.token).get(`/api/v1/organizations/${org.id}/invitations`).expect(200)
    ).body.data as { id: string; email: string }[];
    for (const invitation of invitations) {
      const target = invitation.email === admin.user.email ? admin : invitation.email === member.user.email ? member : viewer;
      await accept(target.token, invitation.id).expect(201);
    }
    return { owner, admin, member, viewer, org };
  };

  const createProject = async (token: string, organizationId: string, name: string) => {
    const response = await auth(token)
      .post('/api/v1/projects')
      .send({ organization_id: organizationId, name });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };

  const createApiKey = async (token: string, projectId: string, environment: string) => {
    const response = await auth(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment });
    expect(response.status).toBe(201);
    return response.body as { id: string; key: string; environment: string };
  };

  const createCustomer = async (token: string, projectId: string, body: Record<string, unknown>) => {
    const response = await auth(token).post(`/api/v1/projects/${projectId}/customers`).send(body);
    expect(response.status).toBe(201);
    return response.body as {
      id: string;
      project_id: string;
      environment: string;
      email: string;
      name: string | null;
      metadata: Record<string, string>;
      created_at: string;
      updated_at: string;
    };
  };

  // -------------------------------------------------------------------------
  // Session mode — create (§4.2, D1/D2/D4)
  // -------------------------------------------------------------------------

  it('create: environment required; email normalized, name trimmed, metadata defaulted; duplicates allowed (D1/D2/D4)', async () => {
    if (!reachable.value) return;

    const { token } = await register('create');
    const org = await createOrg(token, 'Customer Create Org');
    const project = await createProject(token, org.id, 'Create Project');

    const missing = await auth(token)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ email: 'ada@example.com' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    const created = await createCustomer(token, project.id, {
      environment: 'test',
      email: '  Ada@Example.COM  ',
      name: '  Ada Lovelace  ',
    });
    expect(created).toMatchObject({
      project_id: project.id,
      environment: 'test',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      metadata: {},
    });

    // D1: the same normalized email is accepted again.
    const duplicate = await createCustomer(token, project.id, {
      environment: 'test',
      email: 'ada@example.com',
    });
    expect(duplicate.id).not.toBe(created.id);
  });

  it('create: invalid payloads are rejected at the boundary (400)', async () => {
    if (!reachable.value) return;

    const { token } = await register('create-invalid');
    const org = await createOrg(token, 'Customer Invalid Org');
    const project = await createProject(token, org.id, 'Invalid Project');

    const cases: Record<string, unknown>[] = [
      { environment: 'test', email: 'not-an-email' },
      { environment: 'test', email: 'a@b.co', name: '   ' },
      { environment: 'test', email: 'a@b.co', name: null },
      { environment: 'test', email: 'a@b.co', metadata: { flag: true } },
      {
        environment: 'test',
        email: 'a@b.co',
        metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])),
      },
      { environment: 'prod', email: 'a@b.co' },
    ];
    for (const payload of cases) {
      const response = await auth(token).post(`/api/v1/projects/${project.id}/customers`).send(payload);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  // -------------------------------------------------------------------------
  // Session mode — list, search (§4.2, D2/D3)
  // -------------------------------------------------------------------------

  it('list: environment required; search is a case-insensitive substring on email/name (D2/D3)', async () => {
    if (!reachable.value) return;

    const { token } = await register('list');
    const org = await createOrg(token, 'Customer List Org');
    const project = await createProject(token, org.id, 'List Project');

    await createCustomer(token, project.id, { environment: 'test', email: 'ada@example.com', name: 'Ada Lovelace' });
    await createCustomer(token, project.id, { environment: 'test', email: 'grace@example.com', name: 'Grace Hopper' });

    // D2: session list without an explicit environment cannot be served.
    const missing = await auth(token).get(`/api/v1/projects/${project.id}/customers`);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    const all = await auth(token).get(`/api/v1/projects/${project.id}/customers?environment=test`).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.has_more).toBe(false);

    // D3: case-insensitive substring across email and name.
    const byEmail = await auth(token)
      .get(`/api/v1/projects/${project.id}/customers?environment=test&search=GRACE`)
      .expect(200);
    expect(byEmail.body.data).toHaveLength(1);
    expect(byEmail.body.data[0].email).toBe('grace@example.com');

    const byName = await auth(token)
      .get(`/api/v1/projects/${project.id}/customers?environment=test&search=ada`)
      .expect(200);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].name).toBe('Ada Lovelace');

    // Environment isolation: LIVE holds none of these.
    const live = await auth(token).get(`/api/v1/projects/${project.id}/customers?environment=live`).expect(200);
    expect(live.body.data).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Session mode — capability matrix (§4.3, D5)
  // -------------------------------------------------------------------------

  it('capability matrix: every role reads; only owner/admin create/update/delete (D5)', async () => {
    if (!reachable.value) return;

    const { owner, admin, member, viewer, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Matrix Project');

    const customer = await createCustomer(owner.token, project.id, {
      environment: 'test',
      email: 'matrix@example.com',
      name: 'Matrix Customer',
    });

    // Read is granted to every member role.
    await auth(viewer.token).get(`/api/v1/projects/${project.id}/customers?environment=test`).expect(200);
    const memberRead = await auth(member.token).get(
      `/api/v1/projects/${project.id}/customers/${customer.id}?environment=test`,
    );
    expect(memberRead.status).toBe(200);

    // Mutations are owner+admin only.
    const memberCreate = await auth(member.token)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ environment: 'test', email: 'member@example.com' });
    expect(memberCreate.status).toBe(403);
    expect(memberCreate.body.error.code).toBe('FORBIDDEN');

    const memberPatch = await auth(member.token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ name: 'Nope' });
    expect(memberPatch.status).toBe(403);

    const memberDelete = await auth(member.token).delete(
      `/api/v1/projects/${project.id}/customers/${customer.id}`,
    );
    expect(memberDelete.status).toBe(403);

    const viewerCreate = await auth(viewer.token)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ environment: 'test', email: 'viewer@example.com' });
    expect(viewerCreate.status).toBe(403);

    // Admin writes.
    const renamed = await auth(admin.token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ name: 'Renamed by Admin' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed by Admin');
  });

  // -------------------------------------------------------------------------
  // Session mode — retrieve/update/delete (§4.2, D6/D7)
  // -------------------------------------------------------------------------

  it('update: partial fields, normalized values, metadata replaced wholesale, no-op patches stable (D6/D7)', async () => {
    if (!reachable.value) return;

    const { token } = await register('update');
    const org = await createOrg(token, 'Customer Update Org');
    const project = await createProject(token, org.id, 'Update Project');

    const customer = await createCustomer(token, project.id, {
      environment: 'test',
      email: 'vm@example.com',
      name: 'Von Neumann',
      metadata: { vip: 'true' },
    });

    const patched = await auth(token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ email: '  VON@Example.COM  ', name: ' Von Neumann II ', metadata: { tier: 'gold' } })
      .expect(200);
    expect(patched.body).toMatchObject({
      email: 'von@example.com',
      name: 'Von Neumann II',
      metadata: { tier: 'gold' },
      environment: 'test',
      project_id: project.id,
    });
    expect(patched.body.updated_at).not.toBe(customer.updated_at);

    // No-op patch (no changed values): current state, updated_at unchanged.
    const noop = await auth(token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ email: 'von@example.com', name: 'Von Neumann II', metadata: { tier: 'gold' } })
      .expect(200);
    expect(noop.body.updated_at).toBe(patched.body.updated_at);

    // Empty patch is a no-op too.
    const empty = await auth(token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({})
      .expect(200);
    expect(empty.body.updated_at).toBe(patched.body.updated_at);

    // D7: `name` cannot be cleared to null (400).
    const nullName = await auth(token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ name: null });
    expect(nullName.status).toBe(400);
    expect(nullName.body.error.code).toBe('VALIDATION_ERROR');

    const nullEmail = await auth(token)
      .patch(`/api/v1/projects/${project.id}/customers/${customer.id}`)
      .send({ email: null });
    expect(nullEmail.status).toBe(400);
  });

  it('delete: 204 then 404 for everyone; repeated delete is 404', async () => {
    if (!reachable.value) return;

    const { token } = await register('delete');
    const org = await createOrg(token, 'Customer Delete Org');
    const project = await createProject(token, org.id, 'Delete Project');

    const customer = await createCustomer(token, project.id, { environment: 'test', email: 'gone@example.com' });

    await auth(token).delete(`/api/v1/projects/${project.id}/customers/${customer.id}`).expect(204);
    await auth(token).delete(`/api/v1/projects/${project.id}/customers/${customer.id}`).expect(404);

    const after = await auth(token).get(`/api/v1/projects/${project.id}/customers/${customer.id}`);
    expect(after.status).toBe(404);
    expect(after.body.error.code).toBe('NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Tenant isolation (§4.2, D1/D2 non-disclosure)
  // -------------------------------------------------------------------------

  it('tenant isolation: strangers and cross-project ids are 404 everywhere (D1/D2)', async () => {
    if (!reachable.value) return;

    const ownerA = await register('iso-owner-a');
    const ownerB = await register('iso-owner-b');
    const stranger = await register('iso-stranger');
    const orgA = await createOrg(ownerA.token, 'Customer Org A');
    const orgB = await createOrg(ownerB.token, 'Customer Org B');
    const projectA = await createProject(ownerA.token, orgA.id, 'Project A');
    const projectB = await createProject(ownerB.token, orgB.id, 'Project B');

    const customerA = await createCustomer(ownerA.token, projectA.id, {
      environment: 'test',
      email: 'isolated@example.com',
    });

    const crossProject = await auth(ownerB.token).get(
      `/api/v1/projects/${projectB.id}/customers/${customerA.id}`,
    );
    expect(crossProject.status).toBe(404);

    const strangerResponses = await Promise.all([
      auth(stranger.token).get(`/api/v1/projects/${projectA.id}/customers?environment=test`),
      auth(stranger.token).post(`/api/v1/projects/${projectA.id}/customers`).send({ environment: 'test', email: 'x@y.co' }),
      auth(stranger.token).get(`/api/v1/projects/${projectA.id}/customers/${customerA.id}`),
      auth(stranger.token).patch(`/api/v1/projects/${projectA.id}/customers/${customerA.id}`).send({ name: 'Hijack' }),
      auth(stranger.token).delete(`/api/v1/projects/${projectA.id}/customers/${customerA.id}`),
      auth(stranger.token).get(`/api/v1/projects/${projectA.id}/customers/not-a-uuid`),
    ]);
    for (const response of strangerResponses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  // -------------------------------------------------------------------------
  // API-key mode (§4.3, D2/D6)
  // -------------------------------------------------------------------------

  it('api-key mode: CRUD within the key scope; explicit environment mismatches → 422 (D2/D6)', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Key Scope Project');
    const testKey = await createApiKey(owner.token, project.id, 'test');
    const liveKey = await createApiKey(owner.token, project.id, 'live');

    const keyAuth = (key: string) =>
      request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${key}`));

    // Create within the key's environment; a conflicting payload environment → 422.
    const created = await keyAuth(testKey.key)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ environment: 'test', email: 'keyed@example.com', name: 'Keyed Customer' })
      .expect(201);
    expect(created.body.environment).toBe('test');

    const conflict = await keyAuth(testKey.key)
      .post(`/api/v1/projects/${project.id}/customers`)
      .send({ environment: 'live', email: 'wrong@example.com' });
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // List: scoped to the key's environment; a conflicting query → 422.
    const testScope = await keyAuth(testKey.key)
      .get(`/api/v1/projects/${project.id}/customers`)
      .expect(200);
    expect(testScope.body.data).toHaveLength(1);
    expect(testScope.body.data[0].email).toBe('keyed@example.com');

    await keyAuth(testKey.key).get(`/api/v1/projects/${project.id}/customers?environment=live`).expect(422);
    await keyAuth(testKey.key).get(`/api/v1/projects/${project.id}/customers?environment=test`).expect(200);

    // The live key only sees its own (empty) environment.
    const liveScope = await keyAuth(liveKey.key).get(`/api/v1/projects/${project.id}/customers`).expect(200);
    expect(liveScope.body.data).toHaveLength(0);

    // Update/delete within the key scope.
    await keyAuth(testKey.key)
      .patch(`/api/v1/projects/${project.id}/customers/${created.body.id}`)
      .send({ name: 'Renamed by Key' })
      .expect(200);
    await keyAuth(testKey.key).delete(`/api/v1/projects/${project.id}/customers/${created.body.id}`).expect(204);
  });

  it('api-key mode: cross-project and cross-environment targets are 404 (D6, non-disclosure)', async () => {
    if (!reachable.value) return;

    const ownerA = await register('key-owner-a');
    const ownerB = await register('key-owner-b');
    const orgA = await createOrg(ownerA.token, 'Key Org A');
    const orgB = await createOrg(ownerB.token, 'Key Org B');
    const projectA = await createProject(ownerA.token, orgA.id, 'Key Project A');
    const projectB = await createProject(ownerB.token, orgB.id, 'Key Project B');

    const testKey = await createApiKey(ownerA.token, projectA.id, 'test');
    const liveKey = await createApiKey(ownerA.token, projectA.id, 'live');
    const customer = await createCustomer(ownerA.token, projectA.id, {
      environment: 'test',
      email: 'scoped@example.com',
    });

    const keyAuth = (key: string) =>
      request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${key}`));

    // Path project ≠ key project → 404.
    const wrongProject = await keyAuth(testKey.key).get(`/api/v1/projects/${projectB.id}/customers`);
    expect(wrongProject.status).toBe(404);
    expect(wrongProject.body.error.code).toBe('NOT_FOUND');

    // Same project, other environment → 404 (customer lives in TEST).
    const crossEnv = await keyAuth(liveKey.key).get(`/api/v1/projects/${projectA.id}/customers/${customer.id}`);
    expect(crossEnv.status).toBe(404);
    expect(crossEnv.body.error.code).toBe('NOT_FOUND');

    const crossEnvPatch = await keyAuth(liveKey.key)
      .patch(`/api/v1/projects/${projectA.id}/customers/${customer.id}`)
      .send({ name: 'Nope' });
    expect(crossEnvPatch.status).toBe(404);

    const crossEnvDelete = await keyAuth(liveKey.key).delete(
      `/api/v1/projects/${projectA.id}/customers/${customer.id}`,
    );
    expect(crossEnvDelete.status).toBe(404);

    // The test key reaches its own customer (sanity).
    await keyAuth(testKey.key).get(`/api/v1/projects/${projectA.id}/customers/${customer.id}`).expect(200);
  });

  it('api-key mode: missing/revoked/garbage credentials are 401', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Auth Project');
    const key = await createApiKey(owner.token, project.id, 'test');

    // Missing header (no API key, no session JWT) → 401.
    const anonymous = await request(server()).get(`/api/v1/projects/${project.id}/customers`);
    expect(anonymous.status).toBe(401);

    // A non-key, non-JWT bearer token → 401.
    const garbage = await request(server())
      .get(`/api/v1/projects/${project.id}/customers`)
      .set('Authorization', 'Bearer not-a-real-token');
    expect(garbage.status).toBe(401);

    // Revoked keys are rejected immediately.
    await auth(owner.token).delete(`/api/v1/projects/${project.id}/api-keys/${key.id}`).expect(204);
    const revoked = await request(server())
      .get(`/api/v1/projects/${project.id}/customers`)
      .set('Authorization', `Bearer ${key.key}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('UNAUTHENTICATED');
  });
});