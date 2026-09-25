import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ExecutionContext } from '@nestjs/common';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ApiKeyAuthGuard } from '../src/api-keys/api-key-auth.guard';
import { hashApiKey } from '../src/api-keys/api-key-crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Phase 5 e2e (§9): project CRUD, the project-scoped capability matrix
 * (§4.3/D3), tenant isolation (D1/D2), and the API-key lifecycle — including
 * hash-only persistence (D4/D5) and the DB-backed key lookup infrastructure
 * (which gains HTTP consumers in Phase 6). CI provides PostgreSQL/Redis as
 * service containers; locally the suite skips when they are unreachable (same
 * pattern as Phases 3–4).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-proj-${slug}-${RUN}@example.com`;
const PASSWORD = 'password-123';

interface Reachable {
  value: boolean;
}

describe('BrinnPay projects & API keys (e2e, phase 5)', () => {
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
      await prisma.apiKey.deleteMany();
      await prisma.project.deleteMany();
      await prisma.invitation.deleteMany();
      await prisma.organizationMember.deleteMany();
      await prisma.organization.deleteMany();
      await prisma.refreshSession.deleteMany();
      await prisma.user.deleteMany();
      // Reset the auth rate-limit counters so repeated local runs (and the
      // 900s window) stay deterministic (phase 3 D7).
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
      .send({ email: EMAIL(slug), password: PASSWORD, name: `Proj E2E ${slug}` });
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
    const org = await createOrg(owner.token, 'Project Team Org');

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
    return response.body as {
      id: string;
      organization_id: string;
      name: string;
      environments: string[];
      created_at: string;
      updated_at: string;
    };
  };

  const createApiKey = async (token: string, projectId: string, environment: string) => {
    const response = await auth(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment });
    expect(response.status).toBe(201);
    return response.body as {
      id: string;
      project_id: string;
      environment: string;
      key: string;
      created_at: string;
    };
  };

  // -------------------------------------------------------------------------
  // Projects (§4.2)
  // -------------------------------------------------------------------------

  it('create: membership in the org + projects.create required; environments are derived (§4.2, D3/D6)', async () => {
    if (!reachable.value) return;

    const { token } = await register('create');
    const org = await createOrg(token, 'Create Org');

    const project = await createProject(token, org.id, 'Payments API');
    expect(project).toMatchObject({
      organization_id: org.id,
      name: 'Payments API',
      environments: ['test', 'live'],
    });
    expect(project.created_at).toBeTruthy();
    expect(project.updated_at).toBeTruthy();

    const listed = await auth(token).get('/api/v1/projects').expect(200);
    expect(listed.body.data.map((p: { id: string }) => p.id)).toContain(project.id);
  });

  it('create: unknown org → 404; blank name → 400 VALIDATION_ERROR (§4.2)', async () => {
    if (!reachable.value) return;

    const { token } = await register('invalid-create');
    await createOrg(token, 'Invalid Org');

    const unknownOrg = await auth(token)
      .post('/api/v1/projects')
      .send({ organization_id: '00000000-0000-7000-8000-000000000000', name: 'X' });
    expect(unknownOrg.status).toBe(404);
    expect(unknownOrg.body.error.code).toBe('NOT_FOUND');

    for (const name of ['   ', 'x'.repeat(201)]) {
      const bad = await auth(token)
        .post('/api/v1/projects')
        .send({ organization_id: '00000000-0000-7000-8000-000000000000', name });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('project capability matrix: viewer reads, member denials, admin writes (§4.3, D3)', async () => {
    if (!reachable.value) return;

    const { owner, admin, member, viewer, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Matrix API');

    // Viewer can read the project (and its keys).
    const viewerRead = await auth(viewer.token).get(`/api/v1/projects/${project.id}`);
    expect(viewerRead.status).toBe(200);
    expect(viewerRead.body.name).toBe('Matrix API');

    // Member can read but cannot write.
    await auth(member.token).get(`/api/v1/projects/${project.id}`).expect(200);
    const memberRename = await auth(member.token)
      .patch(`/api/v1/projects/${project.id}`)
      .send({ name: 'Nope' });
    expect(memberRename.status).toBe(403);
    expect(memberRename.body.error.code).toBe('FORBIDDEN');

    const memberDelete = await auth(member.token).delete(`/api/v1/projects/${project.id}`);
    expect(memberDelete.status).toBe(403);

    const memberKey = await auth(member.token)
      .post(`/api/v1/projects/${project.id}/api-keys`)
      .send({ environment: 'test' });
    expect(memberKey.status).toBe(403);

    // Admin writes: rename and revoke are allowed.
    const renamed = await auth(admin.token)
      .patch(`/api/v1/projects/${project.id}`)
      .send({ name: 'Renamed by Admin' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed by Admin');
    expect(renamed.body.updated_at).not.toBe(renamed.body.created_at);

    const adminKey = await createApiKey(admin.token, project.id, 'test');
    await auth(admin.token).delete(`/api/v1/projects/${project.id}/api-keys/${adminKey.id}`).expect(204);
  });

  it('tenant isolation: non-members get 404 everywhere (no project disclosure, D1/D2)', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Isolated Project');
    const stranger = await register('isolation');

    const responses = await Promise.all([
      auth(stranger.token).get(`/api/v1/projects/${project.id}`),
      auth(stranger.token).patch(`/api/v1/projects/${project.id}`).send({ name: 'Hijack' }),
      auth(stranger.token).delete(`/api/v1/projects/${project.id}`),
      auth(stranger.token).get(`/api/v1/projects/${project.id}/api-keys`),
      auth(stranger.token).post(`/api/v1/projects/${project.id}/api-keys`).send({ environment: 'test' }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }

    // Malformed ids are equally invisible.
    const malformed = await auth(stranger.token).get('/api/v1/projects/not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(malformed.body.error.code).toBe('NOT_FOUND');
  });

  it('delete: owner/admin; subsequent access yields 404 (implicit key revocation, D7)', async () => {
    if (!reachable.value) return;

    const { owner, admin, member, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Doomed Project');
    const key = await createApiKey(owner.token, project.id, 'live');

    // member cannot delete (matrix) — admin can.
    await auth(member.token).delete(`/api/v1/projects/${project.id}`).expect(403);
    await auth(admin.token).delete(`/api/v1/projects/${project.id}`).expect(204);

    const after = await auth(owner.token).get(`/api/v1/projects/${project.id}`);
    expect(after.status).toBe(404);

    // Cascade wiped the keys (D7): the stored credential is gone.
    const stored = await prisma.apiKey.findUnique({ where: { id: key.id } });
    expect(stored).toBeNull();
  });

  it('projects.list paginates with limit and cursor (§4.5)', async () => {
    if (!reachable.value) return;

    const { token } = await register('pag-owner');
    const org = await createOrg(token, 'Project Paging Org');

    for (let i = 0; i < 7; i += 1) {
      await createProject(token, org.id, `Paged Project ${i}`);
    }

    const page1 = await auth(token).get('/api/v1/projects?limit=5').expect(200);
    expect(page1.body.data).toHaveLength(5);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await auth(token)
      .get(`/api/v1/projects?limit=5&cursor=${page1.body.next_cursor}`)
      .expect(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.has_more).toBe(false);
    expect(page1.body.data[4].id).not.toBe(page2.body.data[0].id);
  });

  // -------------------------------------------------------------------------
  // API keys (§4.2, D4/D5)
  // -------------------------------------------------------------------------

  it('create: returns sk_test_/sk_live_ plaintext once; only the SHA-256 hash is stored (D4/D5)', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Key Lifecycle');

    const testKey = await createApiKey(owner.token, project.id, 'test');
    const liveKey = await createApiKey(owner.token, project.id, 'live');

    expect(testKey.key).toMatch(/^sk_test_[A-Za-z0-9_-]{43}$/);
    expect(liveKey.key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(testKey.environment).toBe('test');
    expect(liveKey.environment).toBe('live');

    // Persisted rows hold the digest, never the credential.
    const testRow = await prisma.apiKey.findUnique({ where: { id: testKey.id } });
    const liveRow = await prisma.apiKey.findUnique({ where: { id: liveKey.id } });
    expect(testRow?.keyHash).toBe(hashApiKey(testKey.key));
    expect(testRow?.keyHash).not.toContain(testKey.key);
    expect(liveRow?.keyHash).toBe(hashApiKey(liveKey.key));
    expect(liveRow?.environment).toBe('live');
  });

  it('list: metadata only — both environments, revoked keys included, no plaintext (§4.2, D5)', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Key Listing');

    const a = await createApiKey(owner.token, project.id, 'test');
    await createApiKey(owner.token, project.id, 'live');
    await auth(owner.token).delete(`/api/v1/projects/${project.id}/api-keys/${a.id}`).expect(204);

    const listed = await auth(owner.token).get(`/api/v1/projects/${project.id}/api-keys`).expect(200);
    expect(listed.body.data).toHaveLength(2);

    for (const entry of listed.body.data) {
      expect(entry).toMatchObject({ project_id: project.id, created_at: expect.any(String) });
      expect(entry).not.toHaveProperty('key');
      expect(entry.environment).toMatch(/^(test|live)$/);
    }
    const revoked = listed.body.data.find((k: { id: string }) => k.id === a.id);
    expect(revoked.revoked_at).toBeTruthy();
    const active = listed.body.data.find((k: { id: string }) => k.id !== a.id);
    expect(active.revoked_at).toBeNull();
  });

  it('revoke: idempotent 204; cross-project revocation is 404 (no disclosure, D2)', async () => {
    if (!reachable.value) return;

    const ownerA = await register('key-owner-a');
    const ownerB = await register('key-owner-b');
    const orgA = await createOrg(ownerA.token, 'Key Org A');
    const orgB = await createOrg(ownerB.token, 'Key Org B');
    const projectA = await createProject(ownerA.token, orgA.id, 'Project A');
    const projectB = await createProject(ownerB.token, orgB.id, 'Project B');

    const keyA = await createApiKey(ownerA.token, projectA.id, 'test');

    await auth(ownerA.token).delete(`/api/v1/projects/${projectA.id}/api-keys/${keyA.id}`).expect(204);
    await auth(ownerA.token).delete(`/api/v1/projects/${projectA.id}/api-keys/${keyA.id}`).expect(204);

    const cross = await auth(ownerB.token).delete(`/api/v1/projects/${projectB.id}/api-keys/${keyA.id}`);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('NOT_FOUND');

    const unknown = await auth(ownerA.token).delete(
      `/api/v1/projects/${projectA.id}/api-keys/00000000-0000-7000-8000-000000000000`,
    );
    expect(unknown.status).toBe(404);
  });

  it('key lookup infrastructure: active keys authenticate with (project, environment); revoked keys are rejected (D4)', async () => {
    if (!reachable.value) return;

    const { owner, org } = await buildTeam();
    const project = await createProject(owner.token, org.id, 'Lookup Project');
    const created = await createApiKey(owner.token, project.id, 'test');

    // DB-backed boundary check of ApiKeyAuthGuard (its HTTP consumers arrive
    // in Phase 6; the guard is unit-tested against mocks elsewhere).
    const guard = app.get(ApiKeyAuthGuard);
    const activeCtx = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${created.key}` } }),
      }),
    } as unknown as ExecutionContext;

    const active = await guard.canActivate(activeCtx);
    expect(active).toBe(true);

    await auth(owner.token).delete(`/api/v1/projects/${project.id}/api-keys/${created.id}`).expect(204);

    const revokedCtx = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${created.key}` } }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(revokedCtx)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});