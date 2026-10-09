import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 12 e2e (§10/§11) against real PostgreSQL:
 *
 * - **recording (AC2–AC4)** — the §5 catalog actions request-driven flows can
 *   produce, each with its organization, actor, resource, allowlisted `data`
 *   and `X-Request-Id` correlation; unknown-email logins and rejected logouts
 *   record nothing.
 * - **background attribution (AC6)** — a read-time catch-up
 *   `payment.succeeded` carries the payment's original creator and no
 *   `request_id`.
 * - **read surface (AC7/AC8)** — session-only authority (`sk_…` → 401), 404
 *   non-disclosure for foreign/malformed organizations, the D3 matrix under
 *   every legitimate role, ascending cursor pagination and the 400 edges.
 * - **immutability and lifecycle (AC9)** — the database rejects `UPDATE`, no
 *   API operation mutates an entry, a project delete leaves rows intact and an
 *   organization delete removes them.
 * - **secret/PII regression (AC10)** — no persisted entry contains the
 *   password, the key plaintext, the idempotency key, an email or free text.
 *
 * Every audit write happens inside the request's transaction (or before the
 * response is sent, for best-effort auth outcomes), so rows are readable
 * immediately after the response — no polling (unlike Phase 11 request logs).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-audit-${slug}-${RUN}@example.com`;
const PASSWORD = 'Audit-Passw0rd-Sup3rSecret';
const FREE_TEXT = 'gift for the delay — goodwill gesture';

jest.setTimeout(120_000);

type AuditRow = {
  id: string;
  organizationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  environment: string | null;
  data: unknown;
  createdAt: Date;
};

describe('audit logging (Phase 12, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();

    prisma = app.get(PrismaService);
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
    requireDependencies(reachable);
    // Payments reference customers with `onDelete: Restrict`, so they go first;
    // everything else cascades from the project or is removed explicitly below.
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'audit12-', endsWith: `-${RUN}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    const organizationIds = projects.map((project) => project.organizationId);
    if (projectIds.length) {
      await prisma.requestLog.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }
    const allOrgs = await prisma.organization.findMany({
      where: { name: { startsWith: 'audit12-', endsWith: `-${RUN}` } },
      select: { id: true },
    });
    const everyOrgId = [...new Set([...organizationIds, ...allOrgs.map((org) => org.id)])];
    if (everyOrgId.length) {
      await prisma.requestLog.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.invitation.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.organizationMember.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.auditLogEntry.deleteMany({ where: { organizationId: { in: everyOrgId } } });
      await prisma.organization.deleteMany({ where: { id: { in: everyOrgId } } });
    }
    const users = await prisma.user.findMany({
      where: { email: { startsWith: 'e2e-audit-', endsWith: `-${RUN}@example.com` } },
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

  const requestIdOf = (response: request.Response) => response.headers['x-request-id'] as string;

  /** Registers a user through the agent so the refresh cookie is retained. */
  async function registerAgent(slug: string, email = EMAIL(slug)) {
    const agent = request.agent(server());
    const response = await agent
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, name: `Audit ${slug}` });
    expect(response.status).toBe(201);
    return {
      agent,
      email,
      token: response.body.access_token as string,
      userId: response.body.user.id as string,
      requestId: requestIdOf(response),
    };
  }

  async function setup(slug: string) {
    const owner = await registerAgent(`owner-${slug}`);
    const organization = await auth(owner.token)
      .post('/api/v1/organizations')
      .send({ name: `audit12-${slug}-${RUN}` });
    expect(organization.status).toBe(201);
    const project = await auth(owner.token)
      .post('/api/v1/projects')
      .send({ organization_id: organization.body.id, name: `Audit ${slug}` });
    expect(project.status).toBe(201);
    return {
      owner,
      organizationId: organization.body.id as string,
      projectId: project.body.id as string,
      auditUrl: `/api/v1/organizations/${organization.body.id}/logs/audit`,
      customersUrl: `/api/v1/projects/${project.body.id}/customers`,
      paymentsUrl: `/api/v1/projects/${project.body.id}/payments`,
      apiKeysUrl: `/api/v1/projects/${project.body.id}/api-keys`,
    };
  }

  const entries = (organizationId: string, action?: string): Promise<AuditRow[]> =>
    prisma.auditLogEntry.findMany({
      where: { organizationId, ...(action ? { action } : {}) },
      orderBy: { id: 'asc' },
    }) as Promise<AuditRow[]>;

  const only = async (organizationId: string, action: string): Promise<AuditRow> => {
    const rows = await entries(organizationId, action);
    expect(rows).toHaveLength(1);
    return rows[0] as AuditRow;
  };

  const serialized = (rows: AuditRow[]) => JSON.stringify(rows);

  // -------------------------------------------------------------------------
  // Recording (§5.2 authentication outcomes, AC2/D4/D13)
  // -------------------------------------------------------------------------

  it('records each authentication outcome exactly once with its request correlation (AC2)', async () => {
    requireDependencies(reachable);
    const owner = await registerAgent('auth');
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: owner.userId },
      select: { organizationId: true },
    });
    // ADR-0010 default organization: the fan-out target for every auth outcome.
    expect(memberships).toHaveLength(1);
    const organizationId = memberships[0]!.organizationId;

    const registered = await only(organizationId, 'user.registered');
    expect(registered).toMatchObject({
      organizationId,
      actorType: 'user',
      actorId: owner.userId,
      resourceType: 'user',
      resourceId: owner.userId,
      projectId: null,
      environment: null,
    });
    expect(registered.data).toEqual({ request_id: owner.requestId });

    // Login success — best-effort entry written before the response.
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const loggedIn = await only(organizationId, 'user.logged_in');
    expect(loggedIn).toMatchObject({ actorId: owner.userId, resourceId: owner.userId });
    expect(loggedIn.data).toEqual({ request_id: requestIdOf(login) });

    // Known account, wrong password → 401 and the archetypal security event.
    const failed = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: 'definitely-not-the-password' });
    expect(failed.status).toBe(401);
    const loginFailed = await only(organizationId, 'user.login_failed');
    expect(loginFailed).toMatchObject({ actorId: owner.userId, resourceId: owner.userId });
    expect(loginFailed.data).toEqual({ request_id: requestIdOf(failed) });

    // Unknown email → identical 401, no entry (D4/F7: no user to attribute,
    // and the presented address is third-party PII).
    const before = (await entries(organizationId, 'user.login_failed')).length;
    const unknown = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL('ghost'), password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(await entries(organizationId, 'user.login_failed')).toHaveLength(before);

    // Logout: the refresh cookie is presented, the session revoked → 204.
    const logout = await owner.agent.post('/api/v1/auth/logout');
    expect(logout.status).toBe(204);
    const loggedOut = await only(organizationId, 'user.logged_out');
    expect(loggedOut).toMatchObject({ actorId: owner.userId, resourceId: owner.userId });
    expect(loggedOut.data).toEqual({ request_id: requestIdOf(logout) });

    // Every authentication entry is fan-out scoped, never platform-global.
    const all = await entries(organizationId);
    expect(all.map((row) => row.action).sort()).toEqual([
      'user.logged_in',
      'user.logged_out',
      'user.login_failed',
      'user.registered',
    ]);
    expect(all.every((row) => row.organizationId === organizationId)).toBe(true);
    // A rejected logout (no cookie) records nothing: another logout is a no-op.
    expect((await owner.agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect(await entries(organizationId, 'user.logged_out')).toHaveLength(1);
  });

  it('records invitation and membership changes with allowlisted data and no email (AC3/D13)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId } = await setup('acl');
    const invitationsUrl = `/api/v1/organizations/${organizationId}/invitations`;

    // --- invitation created; re-cancel is a no-op (§4.2 rule 6) ---
    const cancelInvite = await auth(owner.token)
      .post(invitationsUrl)
      .send({ email: EMAIL('guest-cancel'), role: 'viewer' });
    expect(cancelInvite.status).toBe(201);
    const created = await only(organizationId, 'invitation.created');
    expect(created).toMatchObject({
      actorType: 'user',
      actorId: owner.userId,
      resourceType: 'invitation',
      resourceId: cancelInvite.body.id,
    });
    expect(created.data).toEqual({ role: 'viewer', request_id: requestIdOf(cancelInvite) });

    const cancel = await auth(owner.token).delete(`${invitationsUrl}/${cancelInvite.body.id}`);
    expect(cancel.status).toBe(204);
    const canceled = await only(organizationId, 'invitation.canceled');
    expect(canceled).toMatchObject({ resourceId: cancelInvite.body.id, actorId: owner.userId });
    expect(canceled.data).toEqual({ role: 'viewer', request_id: requestIdOf(cancel) });
    expect((await auth(owner.token).delete(`${invitationsUrl}/${cancelInvite.body.id}`)).status).toBe(204);
    expect(await entries(organizationId, 'invitation.canceled')).toHaveLength(1);

    // --- invitation accepted → member.joined, actor is the joining user ---
    const joinInvite = await auth(owner.token)
      .post(invitationsUrl)
      .send({ email: EMAIL('guest-join'), role: 'member' });
    expect(joinInvite.status).toBe(201);
    const guest = await registerAgent('guest-join');
    // Session authority: the accept route authenticates with the bearer token,
    // exactly like every other session route (the refresh cookie is not a
    // credential here).
    const accept = await auth(guest.token).post(`/api/v1/invitations/${joinInvite.body.id}/accept`);
    expect(accept.status).toBe(201);
    const joined = await only(organizationId, 'member.joined');
    expect(joined).toMatchObject({
      actorType: 'user',
      actorId: guest.userId,
      resourceType: 'member',
      resourceId: guest.userId,
    });
    expect(joined.data).toEqual({
      role: 'member',
      invitation_id: joinInvite.body.id,
      request_id: requestIdOf(accept),
    });

    // --- role change → member.role_changed with old/new bounded scalars ---
    const change = await auth(owner.token)
      .patch(`/api/v1/organizations/${organizationId}/members/${guest.userId}`)
      .send({ role: 'viewer' });
    expect(change.status).toBe(200);
    const roleChanged = await only(organizationId, 'member.role_changed');
    expect(roleChanged).toMatchObject({ actorId: owner.userId, resourceId: guest.userId });
    expect(roleChanged.data).toEqual({
      previous_role: 'member',
      new_role: 'viewer',
      request_id: requestIdOf(change),
    });

    // --- removal → member.removed keeps the plain ids after the row is gone ---
    const remove = await auth(owner.token).delete(
      `/api/v1/organizations/${organizationId}/members/${guest.userId}`,
    );
    expect(remove.status).toBe(204);
    const removed = await only(organizationId, 'member.removed');
    expect(removed).toMatchObject({
      actorId: owner.userId,
      resourceType: 'member',
      resourceId: guest.userId,
    });
    expect(removed.data).toEqual({ role: 'viewer', request_id: requestIdOf(remove) });
    expect(
      await prisma.organizationMember.findFirst({ where: { organizationId, userId: guest.userId } }),
    ).toBeNull();

    // Neither invited address reaches any entry (D13).
    expect(serialized(await entries(organizationId))).not.toContain(EMAIL('guest-cancel'));
    expect(serialized(await entries(organizationId))).not.toContain(EMAIL('guest-join'));
  });

  it('records project mutations, an idempotent replay and the background terminal edge (AC3–AC6)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, projectId, customersUrl, paymentsUrl, apiKeysUrl } =
      await setup('project');

    // --- API key create/revoke: session route, user actor, no plaintext ---
    const key = await auth(owner.token).post(apiKeysUrl).send({ environment: 'test' });
    expect(key.status).toBe(201);
    const keyCreated = await only(organizationId, 'api_key.created');
    expect(keyCreated).toMatchObject({
      actorType: 'user',
      actorId: owner.userId,
      resourceType: 'api_key',
      resourceId: key.body.id,
      projectId,
      environment: 'test',
    });
    expect(keyCreated.data).toEqual({ request_id: requestIdOf(key) });
    expect(serialized([keyCreated])).not.toContain(key.body.key);

    const revoke = await auth(owner.token).delete(`${apiKeysUrl}/${key.body.id}`);
    expect(revoke.status).toBe(204);
    const keyRevoked = await only(organizationId, 'api_key.revoked');
    expect(keyRevoked).toMatchObject({ resourceId: key.body.id, projectId, environment: 'test' });

    // --- customer create/update (values are never echoed) ---
    const customer = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('customer'), name: 'Ada Lovelace' });
    expect(customer.status).toBe(201);
    const customerCreated = await only(organizationId, 'customer.created');
    expect(customerCreated).toMatchObject({
      resourceType: 'customer',
      resourceId: customer.body.id,
      projectId,
      environment: 'test',
      actorId: owner.userId,
    });
    expect(customerCreated.data).toEqual({ request_id: requestIdOf(customer) });

    const update = await auth(owner.token)
      .patch(`${customersUrl}/${customer.body.id}`)
      .send({ name: 'Grace Hopper' });
    expect(update.status).toBe(200);
    const customerUpdated = await only(organizationId, 'customer.updated');
    expect(customerUpdated).toMatchObject({ resourceId: customer.body.id });
    expect(customerUpdated.data).toEqual({ request_id: requestIdOf(update) });

    // --- payment create + idempotent replay → exactly one entry (AC5) ---
    const payment = await auth(owner.token)
      .post(paymentsUrl)
      .set('Idempotency-Key', `idem-audit-${RUN}`)
      .send({
        environment: 'test',
        customer_id: customer.body.id,
        amount: '10.00',
        currency: 'usd',
        description: FREE_TEXT,
      });
    expect(payment.status).toBe(201);
    const paymentCreated = await only(organizationId, 'payment.created');
    expect(paymentCreated).toMatchObject({
      resourceType: 'payment',
      resourceId: payment.body.id,
      projectId,
      environment: 'test',
      actorType: 'user',
      actorId: owner.userId,
    });
    expect(paymentCreated.data).toEqual({
      amount: '10.00',
      currency: 'usd',
      request_id: requestIdOf(payment),
    });

    const replay = await auth(owner.token)
      .post(paymentsUrl)
      .set('Idempotency-Key', `idem-audit-${RUN}`)
      .send({
        environment: 'test',
        customer_id: customer.body.id,
        amount: '10.00',
        currency: 'usd',
        description: FREE_TEXT,
      });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(payment.body.id);
    expect(await entries(organizationId, 'payment.created')).toHaveLength(1);

    // --- read-time catch-up → payment.succeeded attributed to the creator ---
    // Backdating `created_at` makes the whole simulated schedule already
    // elapsed, which is the deterministic equivalent of waiting for it: the
    // schedule is a pure function of (scenario, created_at, delays). Phase 17
    // rule 4 forbids the fixed sleep this test used to perform here.
    await prisma.payment.update({
      where: { id: payment.body.id as string },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    const advanced = await auth(owner.token).get(`${paymentsUrl}/${payment.body.id}`);
    expect(advanced.status).toBe(200);
    expect(advanced.body.status).toBe('succeeded');

    const succeeded = await only(organizationId, 'payment.succeeded');
    expect(succeeded).toMatchObject({
      actorType: 'user',
      actorId: owner.userId,
      resourceType: 'payment',
      resourceId: payment.body.id,
      projectId,
      environment: 'test',
      organizationId,
    });
    // Background/read-time edges carry no request correlation (AC6).
    expect(succeeded.data).toEqual({ amount: '10.00', currency: 'usd' });
    expect(succeeded.data).not.toHaveProperty('request_id');

    // --- refund create → refund.created without the free-text reason (D13) ---
    const refund = await auth(owner.token)
      .post(`/api/v1/payments/${payment.body.id}/refunds`)
      .send({ amount: '4.00', reason: FREE_TEXT });
    expect(refund.status).toBe(201);
    const refundCreated = await only(organizationId, 'refund.created');
    expect(refundCreated).toMatchObject({
      actorType: 'user',
      actorId: owner.userId,
      resourceType: 'refund',
      resourceId: refund.body.id,
      projectId,
      environment: 'test',
    });
    expect(refundCreated.data).toMatchObject({
      payment_id: payment.body.id,
      amount: '4.00',
      currency: 'usd',
      request_id: requestIdOf(refund),
    });

    // No description, email, plaintext or free text anywhere in this trail.
    const trail = serialized(await entries(organizationId));
    expect(trail).not.toContain(FREE_TEXT);
    expect(trail).not.toContain(EMAIL('customer'));
    expect(trail).not.toContain(key.body.key);
    expect(trail).not.toContain(`idem-audit-${RUN}`);
  });

  it('serializes concurrent same-key creates into one payment and one audit row (AC5/C5)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, projectId, customersUrl, paymentsUrl } =
      await setup('audit-race');

    const customer = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('audit-race') });
    expect(customer.status).toBe(201);

    // The idempotency suites prove one payment and one event for concurrent
    // same-key retries; the audit dimension is asserted here because an audit
    // write riding a losing retry would duplicate `payment.created`.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        auth(owner.token)
          .post(paymentsUrl)
          .set('Idempotency-Key', `audit-race-${RUN}`)
          .send({
            environment: 'test',
            customer_id: customer.body.id,
            amount: '10.00',
            currency: 'usd',
          }),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual(responses[0]!.body);
    }

    expect(await prisma.payment.count({ where: { projectId } })).toBe(1);
    expect(await entries(organizationId, 'payment.created')).toHaveLength(1);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Atomicity of the write path (§6.2, AC4)
  // -------------------------------------------------------------------------

  it('rolls a mutation back when its audit insert fails, and leaves login and readiness untouched (AC4)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, projectId, paymentsUrl, customersUrl } = await setup('atomic');

    const customer = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('atomic'), name: 'Ada Lovelace' });
    expect(customer.status).toBe(201);

    // Injection (§11): a database trigger fails the audit insert itself — the
    // real failure mode — for `payment.created` (a mutation) and for
    // `user.logged_in` (a best-effort auth outcome).
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS "audit_entries_forced_failure_payment" ON "audit_log_entries"',
    );
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS "audit_entries_forced_failure_login" ON "audit_log_entries"',
    );
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "audit_entries_forced_failure"() RETURNS trigger AS $fn$
      BEGIN
          RAISE EXCEPTION 'forced audit failure';
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "audit_entries_forced_failure_payment"
      BEFORE INSERT ON "audit_log_entries"
      FOR EACH ROW WHEN (NEW."action" = 'payment.created')
      EXECUTE FUNCTION "audit_entries_forced_failure"()
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "audit_entries_forced_failure_login"
      BEFORE INSERT ON "audit_log_entries"
      FOR EACH ROW WHEN (NEW."action" = 'user.logged_in')
      EXECUTE FUNCTION "audit_entries_forced_failure"()
    `);

    try {
      const paymentsBefore = await prisma.payment.count({ where: { projectId } });

      // Fail-closed mutation: the payment, its idempotency claim, its webhook
      // event and its entry share one transaction, so the failed insert rolls
      // the whole change back and the caller receives the canonical envelope.
      const attempt = await auth(owner.token)
        .post(paymentsUrl)
        .set('Idempotency-Key', `idem-atomic-${RUN}`)
        .send({
          environment: 'test',
          customer_id: customer.body.id,
          amount: '10.00',
          currency: 'usd',
        });
      expect(attempt.status).toBe(500);
      expect(attempt.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        request_id: expect.any(String),
      });
      // No committed change without its audit entry (AC4).
      expect(await prisma.payment.count({ where: { projectId } })).toBe(paymentsBefore);
      expect(await entries(organizationId, 'payment.created')).toHaveLength(0);

      // Readiness is never coupled to the audit store (§6.2).
      await request(server()).get('/health/ready').expect(200);

      // Best-effort authentication outcome: the login is issued regardless of
      // the failed audit write — status, body and headers unchanged.
      const loginUser = await registerAgent('atomic-login');
      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({ email: loginUser.email, password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.access_token).toEqual(expect.any(String));
      // The dropped entry belongs to the login user's own organization fan-out
      // (D4) — nothing was recorded anywhere for this outcome.
      const loginMemberships = await prisma.organizationMember.findMany({
        where: { userId: loginUser.userId },
        select: { organizationId: true },
      });
      expect(loginMemberships.length).toBeGreaterThan(0);
      for (const membership of loginMemberships) {
        expect(await entries(membership.organizationId, 'user.logged_in')).toHaveLength(0);
      }
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "audit_entries_forced_failure_payment" ON "audit_log_entries"',
      );
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "audit_entries_forced_failure_login" ON "audit_log_entries"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "audit_entries_forced_failure"()');
    }

    // With the injection removed the same create commits exactly one entry:
    // the idempotency claim rolled back with the payment, so nothing was left
    // behind for the retry to replay (AC4/AC5).
    const retry = await auth(owner.token)
      .post(paymentsUrl)
      .set('Idempotency-Key', `idem-atomic-${RUN}`)
      .send({
        environment: 'test',
        customer_id: customer.body.id,
        amount: '10.00',
        currency: 'usd',
      });
    expect(retry.status).toBe(201);
    expect(await entries(organizationId, 'payment.created')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Read surface (§4.3, AC7)
  // -------------------------------------------------------------------------

  it('enforces session-only authority and organization non-disclosure (AC7)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, auditUrl, apiKeysUrl } = await setup('read');
    // At least one entry so a 200 is never vacuously empty.
    const key = await auth(owner.token).post(apiKeysUrl).send({ environment: 'test' });
    expect(key.status).toBe(201);

    // Missing session → 401.
    const anonymous = await request(server()).get(auditUrl);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    // API-key bearer: `logs/*` is session-only authority (api-conventions §3),
    // so an sk_… token is rejected before any capability or row is considered.
    const apiKeyBearer = await request(server())
      .get(auditUrl)
      .set('Authorization', `Bearer ${key.body.key}`);
    expect(apiKeyBearer.status).toBe(401);
    expect(apiKeyBearer.body.error.code).toBe('UNAUTHENTICATED');

    // Malformed and unknown organization ids → 404 (existence never disclosed).
    const malformed = await auth(owner.token).get('/api/v1/organizations/not-a-uuid/logs/audit');
    expect(malformed.status).toBe(404);
    const unknown = await auth(owner.token)
      .get('/api/v1/organizations/0192f2a0-0000-7000-8000-00000000dead/logs/audit')
      .expect(404);

    // A foreign organization (owned by somebody else) → 404, same body shape.
    const outsider = await registerAgent('outsider');
    const foreignOrg = await auth(outsider.token)
      .post('/api/v1/organizations')
      .send({ name: `audit12-foreign-${RUN}` });
    expect(foreignOrg.status).toBe(201);
    // The outsider also gets a trail of their own, so the isolation check below
    // has something real to hide.
    const foreignProject = await auth(outsider.token)
      .post('/api/v1/projects')
      .send({ organization_id: foreignOrg.body.id, name: 'Foreign' });
    expect(foreignProject.status).toBe(201);
    await auth(outsider.token)
      .post(`/api/v1/projects/${foreignProject.body.id}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    const foreign = await auth(owner.token).get(
      `/api/v1/organizations/${foreignOrg.body.id}/logs/audit`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe(unknown.body.error.code);

    // Every legitimate role holds `logs.read` under the D3 matrix → a viewer
    // reads the same trail the owner writes (AC7).
    const invite = await auth(owner.token)
      .post(`/api/v1/organizations/${organizationId}/invitations`)
      .send({ email: EMAIL('viewer'), role: 'viewer' });
    expect(invite.status).toBe(201);
    const viewer = await registerAgent('viewer');
    await auth(viewer.token).post(`/api/v1/invitations/${invite.body.id}/accept`).expect(201);
    const viewerRead = await auth(viewer.token).get(auditUrl);
    expect(viewerRead.status).toBe(200);
    expect(viewerRead.body.data.length).toBeGreaterThan(0);

    // Tenant isolation: the reader's organization rows only — the foreign
    // organization's entries never appear, even through a cursor walk.
    const foreignRows = await entries(foreignOrg.body.id);
    expect(foreignRows.length).toBeGreaterThan(0);
    const foreignIds = new Set(foreignRows.map((row) => row.id));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const url: string = cursor ? `${auditUrl}?limit=2&cursor=${cursor}` : `${auditUrl}?limit=2`;
      const page = await auth(owner.token).get(url).expect(200);
      for (const row of page.body.data as Array<{ id: string; organization_id: string }>) {
        expect(row.organization_id).toBe(organizationId);
        expect(foreignIds.has(row.id)).toBe(false);
        seen.push(row.id);
      }
      if (!page.body.has_more) break;
      cursor = page.body.next_cursor as string;
    }
    expect(seen).toEqual((await entries(organizationId)).map((row) => row.id));
  });

  // -------------------------------------------------------------------------
  // Pagination and validation (AC8)
  // -------------------------------------------------------------------------

  it('paginates ascending with the contracted projection and rejects invalid queries (AC8)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, auditUrl, apiKeysUrl, customersUrl } = await setup('page');

    // Four API keys + one customer → five project-scoped entries, in order.
    for (let index = 0; index < 4; index += 1) {
      await auth(owner.token).post(apiKeysUrl).send({ environment: 'test' }).expect(201);
    }
    await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'test', email: EMAIL('page-customer') })
      .expect(201);
    const expected = (await entries(organizationId)).map((row) => row.id);
    expect(expected).toHaveLength(5);

    // Page 1 (limit=2) and page 2 through the cursor: ascending, non-overlapping.
    const page1 = await auth(owner.token).get(`${auditUrl}?limit=2`).expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.next_cursor).toBe(page1.body.data[1].id);
    const page2 = await auth(owner.token)
      .get(`${auditUrl}?limit=2&cursor=${page1.body.next_cursor}`)
      .expect(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.data[0].id > page1.body.data[1].id).toBe(true);
    const page3 = await auth(owner.token)
      .get(`${auditUrl}?limit=2&cursor=${page2.body.next_cursor}`)
      .expect(200);
    expect(page3.body.data).toHaveLength(1);
    expect(page3.body.has_more).toBe(false);
    expect(page3.body.next_cursor).toBeNull();
    expect(
      [...page1.body.data, ...page2.body.data, ...page3.body.data].map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(expected);

    // Default limit is 20 (all five rows, no cursor).
    const defaultPage = await auth(owner.token).get(auditUrl).expect(200);
    expect(defaultPage.body.data).toHaveLength(5);
    expect(defaultPage.body.next_cursor).toBeNull();

    // The contracted projection — exactly the §6.1 fields plus the D6 pair.
    const projection = defaultPage.body.data[0] as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual(
      [
        'action',
        'actor_id',
        'actor_type',
        'created_at',
        'data',
        'environment',
        'id',
        'organization_id',
        'project_id',
        'resource_id',
        'resource_type',
      ].sort(),
    );
    expect(projection.organization_id).toBe(organizationId);
    // The D6 pair is always present — `null` for a non-project-scoped action,
    // a value for a project-scoped one — never absent from the contract.
    expect(projection).toHaveProperty('project_id');
    expect(projection).toHaveProperty('environment');
    expect(projection.project_id === null || typeof projection.project_id === 'string').toBe(true);
    expect(projection.environment === null || ['test', 'live'].includes(projection.environment as string)).toBe(
      true,
    );

    // Validation edges: 400 for limits, cursor and undeclared parameters.
    await auth(owner.token).get(`${auditUrl}?limit=0`).expect(400);
    await auth(owner.token).get(`${auditUrl}?limit=101`).expect(400);
    await auth(owner.token).get(`${auditUrl}?limit=not-a-number`).expect(400);
    await auth(owner.token).get(`${auditUrl}?cursor=not-a-uuid`).expect(400);
    await auth(owner.token).get(`${auditUrl}?action=payment.created`).expect(400);
    await auth(owner.token).get(`${auditUrl}?limit=100`).expect(200);
  });

  // -------------------------------------------------------------------------
  // Immutability and lifecycle (AC9)
  // -------------------------------------------------------------------------

  it('keeps entries append-only in the database and bound to their organization (AC9)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, projectId, auditUrl, apiKeysUrl } = await setup('life');
    const key = await auth(owner.token).post(apiKeysUrl).send({ environment: 'test' });
    expect(key.status).toBe(201);
    const rows = await entries(organizationId);
    expect(rows.length).toBeGreaterThan(0);

    // The database itself rejects an UPDATE (D8 trigger, defense in depth) …
    await expect(
      prisma.$executeRaw`UPDATE "audit_log_entries" SET "action" = 'tampered' WHERE "organization_id" = ${organizationId}::uuid`,
    ).rejects.toThrow(/append-only/);
    // … and the row is untouched.
    expect((await entries(organizationId)).every((row) => row.action !== 'tampered')).toBe(true);

    // … and no API operation exists that would modify or delete an entry.
    await auth(owner.token).patch(auditUrl).expect(404);
    await auth(owner.token).delete(`${auditUrl}/${rows[0]!.id}`).expect(404);

    // Deleting the project leaves the trail intact with stable ids (no FK).
    await auth(owner.token).delete(`/api/v1/projects/${projectId}`).expect(204);
    const afterProjectDelete = await entries(organizationId);
    expect(afterProjectDelete.map((row) => row.id)).toEqual(rows.map((row) => row.id));

    // Deleting the organization cascades the single FK: no orphaned entry.
    await auth(owner.token).delete(`/api/v1/organizations/${organizationId}`).expect(204);
    expect(await entries(organizationId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Secret / PII regression (AC10, §9)
  // -------------------------------------------------------------------------

  it('never persists a secret, email or free text in any entry (AC10)', async () => {
    requireDependencies(reachable);
    const { owner, organizationId, paymentsUrl, apiKeysUrl, customersUrl, auditUrl } =
      await setup('leak');
    const defaultOrg = (
      await prisma.organizationMember.findMany({
        where: { userId: owner.userId },
        select: { organizationId: true },
      })
    ).map((membership) => membership.organizationId);
    expect(defaultOrg).toContain(organizationId);

    // Representative flows that handle sensitive material.
    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);
    await request(server())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: 'a-different-wrong-password' })
      .expect(401);
    const key = await auth(owner.token).post(apiKeysUrl).send({ environment: 'live' }).expect(201);
    const customer = await auth(owner.token)
      .post(customersUrl)
      .send({ environment: 'live', email: EMAIL('leak-customer'), name: 'Ada Lovelace' })
      .expect(201);
    await auth(owner.token)
      .post(`/api/v1/organizations/${organizationId}/invitations`)
      .send({ email: EMAIL('leak-invite'), role: 'admin' })
      .expect(201);
    await auth(owner.token)
      .post(paymentsUrl)
      .set('Idempotency-Key', `idem-secret-${RUN}`)
      .send({
        environment: 'live',
        customer_id: customer.body.id,
        amount: '10.00',
        currency: 'usd',
        description: FREE_TEXT,
      })
      .expect(201);

    // Scan every entry of both organizations the owner's actions touched.
    const orgIds = [...new Set([...defaultOrg, organizationId])];
    const trail: AuditRow[] = (await Promise.all(orgIds.map((id) => entries(id)))).flat();
    expect(trail.length).toBeGreaterThan(3);
    const text = serialized(trail);

    for (const forbidden of [
      PASSWORD, // password (login/register)
      key.body.key, // API key plaintext shown exactly once
      `idem-secret-${RUN}`, // Idempotency-Key header value
      owner.email, // account address
      EMAIL('leak-customer'),
      EMAIL('leak-invite'),
      FREE_TEXT, // free-text inputs (description/reason)
      'Ada Lovelace', // customer display name
      'Authorization', // header material
      'sk_live_', // any key material
    ]) {
      expect(text).not.toContain(forbidden);
    }

    // The read surface returns the same trail — no hidden field leaks either.
    const listed = await auth(owner.token).get(auditUrl).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(listed.body)).not.toContain(key.body.key);
    expect(JSON.stringify(listed.body)).not.toContain(EMAIL('leak-invite'));
  });
});
