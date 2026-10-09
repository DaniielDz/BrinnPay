import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';
import { runPassword } from './support/run-password';

/**
 * Phase 17 F4 / §7 catalog — the composed cross-module journeys C1, C2 and C5.
 *
 * Every individual step is proven by its own module suite (organizations,
 * projects, payments, refunds, idempotency); what none of them prove is that
 * the steps **compose**: that a session created by registration carries an
 * invite through acceptance into a project whose API key then drives the
 * payment journey in API-key mode, and that the idempotency guarantees hold
 * across the payment *and* refund flows of one journey (Phase 8 F5 handover).
 * Rule 3 names F4 composition journeys as the stated reason a behavior may be
 * re-proven at a more expensive layer — that is exactly this file.
 *
 * Determinism (rule 4): time is controlled by backdating `created_at`, the
 * schedule is advanced through the public read path, and nothing sleeps.
 */
jest.setTimeout(60_000);

const stamp = Date.now().toString(36);
// Phase 17 §8/F6: generated per run and per suite — no committed literal, no
// credential reused across suites (policy: Phase 3 D6, `runPassword`).
const password = runPassword('journey');
const PREFIX = `journey-${stamp}`;

describe('critical journeys C1/C2/C5 (phase 17, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;

  const server = () => app.getHttpServer();
  const auth = (token: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));
  const bearer = (key: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${key}`));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    try {
      await prisma.ping();
      await app.get(RedisService).ping();
      await prisma.$queryRaw`SELECT id FROM projects LIMIT 0`;
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
    // Prefix-scoped cleanup: only this suite's rows, never shared test data.
    const users = await prisma.user.findMany({
      where: { email: { startsWith: `${PREFIX}-` } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    const memberships = userIds.length
      ? await prisma.organizationMember.findMany({
          where: { userId: { in: userIds } },
          select: { organizationId: true },
        })
      : [];
    const orgIds = [...new Set(memberships.map((entry) => entry.organizationId))];
    const projects = orgIds.length
      ? await prisma.project.findMany({
          where: { organizationId: { in: orgIds } },
          select: { id: true },
        })
      : [];
    const projectIds = projects.map((project) => project.id);

    if (userIds.length || orgIds.length || projectIds.length) {
      await prisma.requestLog.deleteMany({
        where: {
          OR: [
            ...(userIds.length ? [{ userId: { in: userIds } }] : []),
            ...(orgIds.length ? [{ organizationId: { in: orgIds } }] : []),
            ...(projectIds.length ? [{ projectId: { in: projectIds } }] : []),
          ],
        },
      });
    }
    if (projectIds.length) {
      await prisma.webhookEvent.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.refund.deleteMany({ where: { payment: { projectId: { in: projectIds } } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }
    if (orgIds.length) {
      await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.auditLogEntry.deleteMany({ where: { organizationId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
    if (userIds.length) {
      await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function register(slug: string) {
    const email = `${PREFIX}-${slug}@example.com`;
    const response = await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Journey ${slug}` })
      .expect(201);
    return {
      token: response.body.access_token as string,
      userId: response.body.user.id as string,
      email: response.body.user.email as string,
    };
  }

  /** Session scaffolding shared by C2/C5: organization + project (no customer). */
  async function provision(slug: string) {
    const user = await register(slug);
    const org = await auth(user.token)
      .post('/api/v1/organizations')
      .send({ name: `${PREFIX}-${slug}` })
      .expect(201);
    const project = await auth(user.token)
      .post('/api/v1/projects')
      .send({ organization_id: org.body.id, name: `${PREFIX}-${slug}-project` })
      .expect(201);
    return {
      token: user.token,
      userId: user.userId,
      orgId: org.body.id as string,
      projectId: project.body.id as string,
    };
  }

  const paymentBody = (customerId: string) => ({
    environment: 'test',
    customer_id: customerId,
    amount: '10.00',
    currency: 'usd',
  });

  const paymentsUrl = (projectId: string) => `/api/v1/projects/${projectId}/payments`;

  /** Makes the whole simulated schedule already elapsed (rule 4: no sleeps). */
  const backdate = (paymentId: string) =>
    prisma.payment.update({
      where: { id: paymentId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

  // -------------------------------------------------------------------------
  // C1 — onboarding journey
  // -------------------------------------------------------------------------

  it('C1: register → default org → new org → invite/accept → project → API key once → revoke', async () => {
    requireDependencies(reachable);
    const alice = await register('c1-alice');
    const bob = await register('c1-bob');

    // Registration yields the default organization and its owner membership
    // (ADR-0010) — the journey's starting tenant, asserted before anything else.
    const initial = await auth(alice.token).get('/api/v1/organizations').expect(200);
    expect(initial.body.data).toHaveLength(1);
    const defaultOrgId = initial.body.data[0].id as string;
    const defaultMembers = await auth(alice.token)
      .get(`/api/v1/organizations/${defaultOrgId}/members`)
      .expect(200);
    const defaultRoles = new Map(
      (defaultMembers.body.data as Array<{ user_id: string; role: string }>).map((member) => [
        member.user_id,
        member.role,
      ]),
    );
    expect(defaultRoles.get(alice.userId)).toBe('owner');

    // Create a second organization: the creator becomes its owner directly.
    const org = await auth(alice.token)
      .post('/api/v1/organizations')
      .send({ name: `${PREFIX}-c1-org` })
      .expect(201);
    const listed = await auth(alice.token).get('/api/v1/organizations').expect(200);
    expect(listed.body.data).toHaveLength(2);

    // Invite/accept: Bob's account email binds the invitation to Bob alone.
    const invitation = await auth(alice.token)
      .post(`/api/v1/organizations/${org.body.id}/invitations`)
      .send({ email: bob.email, role: 'member' })
      .expect(201);
    const accepted = await auth(bob.token)
      .post(`/api/v1/invitations/${invitation.body.id}/accept`)
      .expect(201);
    expect(accepted.body).toMatchObject({ organization_id: org.body.id, role: 'member' });

    const members = await auth(alice.token)
      .get(`/api/v1/organizations/${org.body.id}/members`)
      .expect(200);
    const roles = new Map(
      (members.body.data as Array<{ user_id: string; role: string }>).map((member) => [
        member.user_id,
        member.role,
      ]),
    );
    expect(roles.size).toBe(2);
    expect(roles.get(alice.userId)).toBe('owner');
    expect(roles.get(bob.userId)).toBe('member');

    // The project lives in the new organization, not the default one.
    const project = await auth(alice.token)
      .post('/api/v1/projects')
      .send({ organization_id: org.body.id, name: `${PREFIX}-c1-project` })
      .expect(201);
    expect(project.body.organization_id).toBe(org.body.id);

    // The API key's plaintext is shown exactly once, at creation (ADR-0006)…
    const key = await auth(alice.token)
      .post(`/api/v1/projects/${project.body.id}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    expect(key.body.key).toMatch(/^sk_test_[A-Za-z0-9_-]{43}$/);
    const keyList = await auth(alice.token)
      .get(`/api/v1/projects/${project.body.id}/api-keys`)
      .expect(200);
    for (const entry of keyList.body.data as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty('key');
    }

    // …and the plaintext really authenticates, in API-key mode with no
    // environment parameter (the environment comes from the key).
    const customers = await bearer(key.body.key)
      .get(`/api/v1/projects/${project.body.id}/customers`)
      .expect(200);
    expect(customers.body).toMatchObject({ data: [], has_more: false });

    // Revoke, and the same plaintext stops working at the boundary (401).
    await auth(alice.token)
      .delete(`/api/v1/projects/${project.body.id}/api-keys/${key.body.id}`)
      .expect(204);
    const rejected = await bearer(key.body.key)
      .get(`/api/v1/projects/${project.body.id}/customers`)
      .expect(401);
    expect(rejected.body.error.code).toBe('UNAUTHENTICATED');
  });

  // -------------------------------------------------------------------------
  // C2 — payment journey in API-key mode
  // -------------------------------------------------------------------------

  it('C2: key-mode customer → payment → retrieve/list → advanced to succeeded → event rows', async () => {
    requireDependencies(reachable);
    const { token, projectId } = await provision('c2');

    const key = await auth(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    const apiKey = key.body.key as string;

    // The whole journey below runs with the API key, never the session.
    const customer = await bearer(apiKey)
      .post(`/api/v1/projects/${projectId}/customers`)
      .send({ environment: 'test', email: `${PREFIX}-c2-customer@example.com` })
      .expect(201);

    const created = await bearer(apiKey)
      .post(paymentsUrl(projectId))
      .send(paymentBody(customer.body.id))
      .expect(201);
    expect(created.body).toMatchObject({ status: 'pending', failure_code: null });

    // Retrieve and list, again in key mode, without an environment parameter.
    const retrieved = await bearer(apiKey)
      .get(`${paymentsUrl(projectId)}/${created.body.id}`)
      .expect(200);
    expect(retrieved.body).toMatchObject({ id: created.body.id, status: 'pending' });
    const list = await bearer(apiKey).get(paymentsUrl(projectId)).expect(200);
    expect((list.body.data as Array<{ id: string }>).map((payment) => payment.id)).toContain(
      created.body.id,
    );

    // The `payment.created` event row was persisted with the payment (§4.1.2).
    expect(
      await prisma.webhookEvent.count({ where: { projectId, type: 'payment.created' } }),
    ).toBe(1);

    // The simulation advances: backdate the schedule, then read once — the
    // read catch-up settles the payment and persists its terminal event.
    await backdate(created.body.id as string);
    const advanced = await bearer(apiKey)
      .get(`${paymentsUrl(projectId)}/${created.body.id}`)
      .expect(200);
    expect(advanced.body).toMatchObject({ status: 'succeeded', failure_code: null });
    expect(
      await prisma.webhookEvent.count({ where: { projectId, type: 'payment.succeeded' } }),
    ).toBe(1);

    // Environment binding: an explicit conflicting environment is a 422 and
    // discloses nothing (§9 rule 3 — isolation asserted, not assumed).
    const conflict = await bearer(apiKey).get(`${paymentsUrl(projectId)}?environment=live`);
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  // -------------------------------------------------------------------------
  // C5 — safe-retry journey across payment and refund creates (Phase 8 F5)
  // -------------------------------------------------------------------------

  it('C5: one Idempotency-Key across payment and refund creates replays verbatim and stays scope-isolated', async () => {
    requireDependencies(reachable);
    const { token, projectId, userId } = await provision('c5');

    const customer = await auth(token)
      .post(`/api/v1/projects/${projectId}/customers`)
      .send({ environment: 'test', email: `${PREFIX}-c5-customer@example.com` })
      .expect(201);
    const customerId = customer.body.id as string;

    // --- payment: a raced same key commits exactly one payment ---
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        auth(token)
          .post(paymentsUrl(projectId))
          .set('Idempotency-Key', 'c5-payment')
          .send(paymentBody(customerId)),
      ),
    );
    for (const response of raced) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual(raced[0]!.body);
    }
    const paymentId = raced[0]!.body.id as string;
    expect(await prisma.payment.count({ where: { projectId } })).toBe(1);

    // A later sequential retry replays the stored snapshot verbatim.
    const paymentReplay = await auth(token)
      .post(paymentsUrl(projectId))
      .set('Idempotency-Key', 'c5-payment')
      .send(paymentBody(customerId))
      .expect(201);
    expect(paymentReplay.body).toEqual(raced[0]!.body);

    // A different key is an independent operation: a second payment exists.
    const other = await auth(token)
      .post(paymentsUrl(projectId))
      .set('Idempotency-Key', 'c5-payment-other')
      .send(paymentBody(customerId))
      .expect(201);
    expect(other.body.id).not.toBe(paymentId);
    expect(await prisma.payment.count({ where: { projectId } })).toBe(2);

    // --- refund: same guarantees, same journey ---
    await backdate(paymentId);
    const advanced = await auth(token).get(`${paymentsUrl(projectId)}/${paymentId}`).expect(200);
    expect(advanced.body.status).toBe('succeeded');

    const refundsUrl = `/api/v1/payments/${paymentId}/refunds`;
    const refundRaced = await Promise.all(
      Array.from({ length: 4 }, () =>
        auth(token).post(refundsUrl).set('Idempotency-Key', 'c5-refund').send({ amount: '3.00' }),
      ),
    );
    for (const response of refundRaced) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual(refundRaced[0]!.body);
    }
    const refundId = refundRaced[0]!.body.id as string;
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(1);

    const refundReplay = await auth(token)
      .post(refundsUrl)
      .set('Idempotency-Key', 'c5-refund')
      .send({ amount: '3.00' })
      .expect(201);
    expect(refundReplay.body).toEqual(refundRaced[0]!.body);
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(1);

    // A different refund key stays independent: the remaining balance allows
    // a second, distinct refund.
    const secondRefund = await auth(token)
      .post(refundsUrl)
      .set('Idempotency-Key', 'c5-refund-other')
      .send({ amount: '2.00' })
      .expect(201);
    expect(secondRefund.body.id).not.toBe(refundId);

    // Cross-payment reuse of the refund key is a 409 that discloses nothing
    // about the original refund (§7 refunds, no IDOR through idempotency).
    await backdate(other.body.id as string);
    await auth(token).get(`${paymentsUrl(projectId)}/${other.body.id}`).expect(200);
    const cross = await auth(token)
      .post(`/api/v1/payments/${other.body.id}/refunds`)
      .set('Idempotency-Key', 'c5-refund')
      .send({ amount: '1.00' });
    expect(cross.status).toBe(409);
    expect(cross.body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(cross.body)).not.toContain(refundId);
    expect(JSON.stringify(cross.body)).not.toContain(raced[0]!.body.id);
    expect(await prisma.refund.count({ where: { paymentId: other.body.id as string } })).toBe(0);
    expect(userId).toBeTruthy();
  });
});
