import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uuidv7 } from '../src/common/uuid/uuid';
import { PAYMENT_EVENT_SINK, type PaymentEvent } from '../src/payments/payment-events';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Phase 8 e2e (§8.1): the `payments.create` idempotency contract against the
 * running application with **real PostgreSQL/Redis** — claim/replay semantics
 * (D3), the (project, operation scope, key) uniqueness scope (D2), post-expiry
 * reuse (D5), the database-backed concurrency guarantee (D4), the retained 400
 * on an invalid header, and the "rejected requests do not poison the key" rule.
 *
 * The `payment.created` emission is observed through a recording sink
 * substituted for the phase 7 no-op sink, which is what proves that a replay
 * produces no second side effect. CI provides PostgreSQL/Redis as service
 * containers; locally the suite skips when they are unreachable (same pattern
 * as Phases 3–7).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-idem-${slug}-${RUN}@example.com`;
const PASSWORD = 'password-123';
const SCOPE = 'payments.create';

interface Reachable {
  value: boolean;
}

describe('BrinnPay idempotency — payments.create (e2e, phase 8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const reachable: Reachable = { value: false };
  const events: PaymentEvent[] = [];

  const server = () => app.getHttpServer();

  const resetDatabase = async () => {
    // Order respects the FK graph: payments → customers (ON DELETE RESTRICT).
    await prisma.payment.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.project.deleteMany();
    await prisma.invitation.deleteMany();
    await prisma.organizationMember.deleteMany();
    await prisma.organization.deleteMany();
    await prisma.refreshSession.deleteMany();
    await prisma.user.deleteMany();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_EVENT_SINK)
      .useValue({ emit: (event: PaymentEvent) => void events.push(event) })
      .compile();
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
      await resetDatabase();
      const rateLimitKeys = await redis.connection.keys('auth:rl:*');
      if (rateLimitKeys.length > 0) {
        await redis.connection.del(rateLimitKeys);
      }
    }
  });

  beforeEach(() => {
    events.length = 0;
  });

  afterAll(async () => {
    if (!app) return;
    if (reachable.value) {
      await resetDatabase();
    }
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const register = async (slug: string) => {
    const response = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: EMAIL(slug), password: PASSWORD, name: `Idem ${slug}` });
    expect(response.status).toBe(201);
    return { token: response.body.access_token as string };
  };

  const auth = (token: string) =>
    request
      .agent(server())
      .use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));

  const setup = async (slug: string) => {
    const { token } = await register(slug);
    const org = await auth(token).post('/api/v1/organizations').send({ name: `Idem ${slug} Org` });
    expect(org.status).toBe(201);
    const project = await auth(token)
      .post('/api/v1/projects')
      .send({ organization_id: org.body.id, name: `Idem ${slug} Project` });
    expect(project.status).toBe(201);
    const customer = await auth(token)
      .post(`/api/v1/projects/${project.body.id}/customers`)
      .send({ environment: 'test', email: `customer-${slug}@example.com` });
    expect(customer.status).toBe(201);
    return {
      token,
      orgId: org.body.id as string,
      projectId: project.body.id as string,
      customerId: customer.body.id as string,
    };
  };

  const paymentPayload = (customerId: string) => ({
    environment: 'test',
    customer_id: customerId,
    amount: '10.00',
    currency: 'usd',
  });

  const createPayment = (token: string, projectId: string, customerId: string, key?: string) => {
    const call = auth(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send(paymentPayload(customerId));
    return key === undefined ? call : call.set('Idempotency-Key', key);
  };

  const paymentCount = (projectId: string) =>
    prisma.payment.count({ where: { projectId } });

  const createdEvents = (projectId: string) =>
    events.filter((event) => event.type === 'payment.created' && event.project_id === projectId);

  const recordCount = (projectId: string) =>
    prisma.idempotencyRecord.count({ where: { projectId } });

  // -------------------------------------------------------------------------
  // Claim + replay (D3)
  // -------------------------------------------------------------------------

  it('stores the first successful response and replays it for a same-scope retry (§7.2, §7.3)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('replay');

    const first = await createPayment(token, projectId, customerId, 'order_replay_1').expect(201);
    const retry = await createPayment(token, projectId, customerId, 'order_replay_1').expect(201);

    // The contracted Payment body is returned again, unchanged.
    expect(retry.body).toEqual(first.body);
    expect(retry.body.status).toBe('pending');
    // Exactly one payment row and one payment.created event.
    expect(await paymentCount(projectId)).toBe(1);
    expect(createdEvents(projectId)).toHaveLength(1);
    expect(await recordCount(projectId)).toBe(1);
  });

  it('replays the stored snapshot even after the payment advanced (§4.2.4, §6.7)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('snapshot');

    const first = await createPayment(token, projectId, customerId, 'order_snapshot_1').expect(201);

    // The payment reaches a terminal state after the first response was stored.
    await prisma.payment.update({
      where: { id: first.body.id },
      data: { status: 'succeeded' },
    });
    const advanced = await auth(token)
      .get(`/api/v1/projects/${projectId}/payments/${first.body.id}`)
      .expect(200);
    expect(advanced.body.status).toBe('succeeded');

    const retry = await createPayment(token, projectId, customerId, 'order_snapshot_1').expect(201);

    expect(retry.body).toEqual(first.body);
    expect(retry.body.status).toBe('pending');
    expect(await paymentCount(projectId)).toBe(1);
    expect(createdEvents(projectId)).toHaveLength(1);
  });

  it('normalizes the key so a padded retry replays the same record (§4.1)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('normalize');

    const first = await createPayment(token, projectId, customerId, 'order_pad_1').expect(201);
    const padded = await createPayment(token, projectId, customerId, '  order_pad_1  ').expect(201);

    expect(padded.body).toEqual(first.body);
    expect(await paymentCount(projectId)).toBe(1);
  });

  it('answers each replay with its own request id (§4.3.2)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('request-id');

    const first = await createPayment(token, projectId, customerId, 'order_reqid_1').expect(201);
    const retry = await createPayment(token, projectId, customerId, 'order_reqid_1').expect(201);

    expect(first.headers['x-request-id']).toMatch(/^req_/);
    expect(retry.headers['x-request-id']).toMatch(/^req_/);
    expect(retry.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
    // The stored body carries no tracing data of the original request.
    expect(retry.body).not.toHaveProperty('request_id');
  });

  // -------------------------------------------------------------------------
  // Uniqueness scope (D2)
  // -------------------------------------------------------------------------

  it('treats the same key in another project as an independent operation (§7.5)', async () => {
    if (!reachable.value) return;
    const alpha = await setup('scope-a');
    const beta = await setup('scope-b');

    const first = await createPayment(alpha.token, alpha.projectId, alpha.customerId, 'shared_key').expect(201);
    const other = await createPayment(beta.token, beta.projectId, beta.customerId, 'shared_key').expect(201);

    expect(other.body.id).not.toBe(first.body.id);
    expect(await paymentCount(alpha.projectId)).toBe(1);
    expect(await paymentCount(beta.projectId)).toBe(1);
  });

  it('treats the same key under another operation scope as independent (§7.6)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('scope-op');
    const now = new Date();

    // A committed record for the reserved Phase 9 scope (ADR-0004).
    await prisma.idempotencyRecord.create({
      data: {
        id: uuidv7(),
        projectId,
        operationScope: 'refunds.create',
        idempotencyKey: 'shared_scope_key',
        responseStatus: 201,
        responseBody: { id: 'refund-shape-not-a-payment' },
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
    });

    const created = await createPayment(token, projectId, customerId, 'shared_scope_key').expect(201);

    expect(created.body).toMatchObject({ customer_id: customerId, amount: '10.00' });
    expect(await paymentCount(projectId)).toBe(1);
  });

  it('replays across authentication modes for the same project (§4.2.3)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('auth-mode');

    const first = await createPayment(token, projectId, customerId, 'order_mode_1').expect(201);

    const apiKey = await auth(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    const replayed = await request(server())
      .post(`/api/v1/projects/${projectId}/payments`)
      .set('Authorization', `Bearer ${apiKey.body.key}`)
      .set('Idempotency-Key', 'order_mode_1')
      .send(paymentPayload(customerId))
      .expect(201);

    // Project scope — not the auth mode — is the uniqueness boundary.
    expect(replayed.body).toEqual(first.body);
    expect(await paymentCount(projectId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Expiry (D5)
  // -------------------------------------------------------------------------

  it('treats reuse after the retention window as a new operation (§7.7, §5.2)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('expiry');

    const first = await createPayment(token, projectId, customerId, 'order_expiry_1').expect(201);
    const record = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { projectId, operationScope: SCOPE, idempotencyKey: 'order_expiry_1' },
    });
    // The stored window has passed; asynchronous cleanup has not run.
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
    await prisma.idempotencyRecord.update({
      where: { id: record.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const reused = await createPayment(token, projectId, customerId, 'order_expiry_1').expect(201);

    expect(reused.body.id).not.toBe(first.body.id);
    expect(await paymentCount(projectId)).toBe(2);
    // The stale record was replaced, not accumulated.
    expect(await recordCount(projectId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Concurrency (D4)
  // -------------------------------------------------------------------------

  it('creates exactly one payment for concurrent same-key retries (§7.4, D4)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('concurrent');
    const attempts = 6;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        createPayment(token, projectId, customerId, 'order_race_1'),
      ),
    );

    // Every caller observes the same committed 201 Payment.
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual(responses[0].body);
    }
    // One side effect, one event, one stored record.
    expect(await paymentCount(projectId)).toBe(1);
    expect(createdEvents(projectId)).toHaveLength(1);
    expect(await recordCount(projectId)).toBe(1);
  }, 20_000);

  it('keeps concurrent retries of different keys independent (no cross-talk)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('concurrent-keys');

    const responses = await Promise.all(
      ['order_a', 'order_b', 'order_c'].map((key) =>
        createPayment(token, projectId, customerId, key),
      ),
    );

    const ids = responses.map((response) => response.body.id);
    expect(new Set(ids).size).toBe(3);
    expect(await paymentCount(projectId)).toBe(3);
    expect(createdEvents(projectId)).toHaveLength(3);
  }, 20_000);

  // -------------------------------------------------------------------------
  // Header validation and non-poisoning (§7.8, §7.9)
  // -------------------------------------------------------------------------

  it('rejects an invalid Idempotency-Key with 400 VALIDATION_ERROR (§7.8)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('invalid-key');

    for (const key of ['   ', 'k'.repeat(256)]) {
      const response = await createPayment(token, projectId, customerId, key);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('idempotency-key');
    }
    expect(await paymentCount(projectId)).toBe(0);
    expect(await recordCount(projectId)).toBe(0);
  });

  it('does not let a rejected request poison the key (§7.9, §6.8)', async () => {
    if (!reachable.value) return;
    const { token, orgId, projectId, customerId } = await setup('poison');

    // (a) Business validation failure inside the mutation (unknown customer).
    const unknown = await createPayment(token, projectId, uuidv7(), 'order_poison_1');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    // (b) Request-shape failure before the mutation — rejected by the boundary.
    const malformed = await auth(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .set('Idempotency-Key', 'order_poison_1')
      .send({ environment: 'test', customer_id: 'not-a-uuid', amount: '10.00', currency: 'usd' });
    expect(malformed.status).toBe(400);

    // (c) Authorization failure — a caller without the create capability.
    const viewer = await register('poison-viewer');
    const invite = await auth(token)
      .post(`/api/v1/organizations/${orgId}/invitations`)
      .send({ email: EMAIL('poison-viewer'), role: 'viewer' });
    expect(invite.status).toBe(201);
    await auth(viewer.token).post(`/api/v1/invitations/${invite.body.id}/accept`).expect(201);
    const forbidden = await createPayment(viewer.token, projectId, customerId, 'order_poison_1');
    expect(forbidden.status).toBe(403);

    // (d) The same key still executes normally afterwards.
    const created = await createPayment(token, projectId, customerId, 'order_poison_1').expect(201);
    expect(created.body).toMatchObject({ customer_id: customerId, status: 'pending' });
    expect(await paymentCount(projectId)).toBe(1);
  });

  it('leaves no replayable record behind when the mutation is rejected (§6.8)', async () => {
    if (!reachable.value) return;
    const { token, projectId } = await setup('rollback');

    const failed = await createPayment(token, projectId, uuidv7(), 'order_rollback_1');
    expect(failed.status).toBe(404);

    const records = await prisma.idempotencyRecord.findMany({
      where: { projectId, operationScope: SCOPE, idempotencyKey: 'order_rollback_1' },
    });
    expect(records).toHaveLength(0);
  });

  it('keeps working without the header (idempotency is optional, §4.2.2)', async () => {
    if (!reachable.value) return;
    const { token, projectId, customerId } = await setup('no-key');

    const first = await createPayment(token, projectId, customerId).expect(201);
    const second = await createPayment(token, projectId, customerId).expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    expect(await paymentCount(projectId)).toBe(2);
    expect(await recordCount(projectId)).toBe(0);
    expect(createdEvents(projectId)).toHaveLength(2);
  });
});
