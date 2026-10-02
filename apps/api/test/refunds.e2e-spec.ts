import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uuidv7 } from '../src/common/uuid/uuid';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RefundEvent } from '../src/refunds/refund-events';
import { WEBHOOK_EVENT_PORT, type WebhookEventPort } from '../src/webhooks/webhook-events';

const stamp = Date.now().toString(36);
const password = 'password-123';

describe('refunds (Phase 9, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let available = false;
  const events: RefundEvent[] = [];
  const server = () => app.getHttpServer();
  const call = (token: string) => request.agent(server()).use((req: request.Request) =>
    req.set('Authorization', `Bearer ${token}`));

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WEBHOOK_EVENT_PORT)
      .useValue({
        persist: async (_tx: unknown, event: RefundEvent) => { events.push(event); },
        dispatch: async () => undefined,
      } satisfies WebhookEventPort)
      .compile();
    app = ref.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    try {
      await prisma.ping();
      // A migrated database is required; never operate on an older schema.
      await prisma.refund.count();
      available = true;
    } catch { /* Local development without a migrated PostgreSQL instance. */ }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function setup(name: string) {
    const email = `refund-${name}-${stamp}@example.com`;
    const registration = await request(server()).post('/api/v1/auth/register')
      .send({ email, password, name }).expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token).post('/api/v1/organizations').send({ name: `refund-${name}-${stamp}` }).expect(201);
    const project = await call(token).post('/api/v1/projects')
      .send({ name, organization_id: org.body.id }).expect(201);
    const customer = await call(token).post(`/api/v1/projects/${project.body.id}/customers`)
      .send({ environment: 'test', email }).expect(201);
    const payment = await call(token).post(`/api/v1/projects/${project.body.id}/payments`)
      .send({ environment: 'test', customer_id: customer.body.id, amount: '10.00', currency: 'usd' })
      .expect(201);
    await prisma.payment.update({ where: { id: payment.body.id }, data: { status: 'succeeded' } });
    return {
      token, orgId: org.body.id as string, projectId: project.body.id as string,
      paymentId: payment.body.id as string,
    };
  }

  afterEach(async () => {
    if (!available) return;
    // Only clean resources created by this suite; never wipe shared test data.
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'refund-', endsWith: `-${stamp}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      await prisma.refund.deleteMany({ where: { payment: { projectId: { in: projectIds } } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: projects.map((p) => p.organizationId) } } });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: 'refund-', endsWith: `-${stamp}@example.com` } } });
    events.length = 0;
  });

  it('partial then full remaining, rejects excess and exhausted; lists and retrieves scoped projections', async () => {
    if (!available) return;
    const { token, paymentId, projectId } = await setup('balance');
    const url = `/api/v1/payments/${paymentId}/refunds`;
    const first = await call(token).post(url).send({ amount: '3.25', reason: '  duplicate  ' }).expect(201);
    expect(first.body).toMatchObject({ payment_id: paymentId, project_id: projectId,
      environment: 'test', amount: '3.25', status: 'succeeded', reason: 'duplicate' });
    const second = await call(token).post(url).send({}).expect(201);
    expect(second.body.amount).toBe('6.75');
    expect(second.body.reason).toBeNull();
    await call(token).post(url).send({}).expect(422);
    const list = await call(token).get(url).expect(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.has_more).toBe(false);
    const page = await call(token).get(`${url}?limit=1`).expect(200);
    expect(page.body.next_cursor).toBe(first.body.id);
    expect((await call(token).get(`${url}?cursor=${page.body.next_cursor}`).expect(200)).body.data[0].id).toBe(second.body.id);
    expect((await call(token).get(`${url}/${first.body.id}`).expect(200)).body).toEqual(first.body);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('succeeded');
    expect(events.filter((item) => item.type === 'refund.created')).toHaveLength(2);
  });

  it('serializes simultaneous different-key and unkeyed attempts and replays a single keyed success', async () => {
    if (!available) return;
    const { token, paymentId, projectId } = await setup('race');
    const url = `/api/v1/payments/${paymentId}/refunds`;
    const results = await Promise.all([
      call(token).post(url).set('Idempotency-Key', 'race-a').send({ amount: '7.00' }),
      call(token).post(url).set('Idempotency-Key', 'race-b').send({ amount: '7.00' }),
      call(token).post(url).send({ amount: '7.00' }),
    ]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 422)).toHaveLength(2);
    expect(await prisma.refund.count({ where: { payment: { projectId } } })).toBe(1);
    const winner = results.find((result) => result.status === 201)!;
    const winnerIndex = results.indexOf(winner);
    if (winnerIndex < 2) {
      const replay = await call(token).post(url).set('Idempotency-Key',
        winnerIndex === 0 ? 'race-a' : 'race-b').send({ amount: '7.00' }).expect(201);
      expect(replay.body).toEqual(winner.body);
    }
    expect(events.filter((item) => item.type === 'refund.created')).toHaveLength(1);
  });

  it('enforces key environment and session membership, validates body, and rejects cross-parent replay', async () => {
    if (!available) return;
    const a = await setup('isolation');
    const b = await setup('isolation-b');
    const url = `/api/v1/payments/${a.paymentId}/refunds`;
    const key = await call(a.token).post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'live' }).expect(201);
    await request(server()).get(url).set('Authorization', `Bearer ${key.body.key}`).expect(404);
    await call(b.token).get(url).expect(404);
    await call(a.token).post(url).send({ amount: '0.00' }).expect(400);
    await call(a.token).post(url).send({ reason: '  ' }).expect(400);
    await call(a.token).post(url).send({ amount: '12.00' }).expect(422);
    // Malformed pagination is a field error, never a database cast failure.
    await call(a.token).get(`${url}?cursor=not-a-uuid`).expect(400);
    await call(a.token).get(`${url}?limit=101`).expect(400);
    const first = await call(a.token).post(url).set('Idempotency-Key', 'shared-key').send({ amount: '2.00' }).expect(201);
    const secondPayment = await prisma.payment.create({
      data: { id: uuidv7(), projectId: a.projectId,
        customerId: (await prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).customerId,
        environment: 'test', amountMinor: BigInt(1000), currency: 'usd', status: 'succeeded',
        createdAt: new Date(), updatedAt: new Date() },
    });
    await call(a.token).post(`/api/v1/payments/${secondPayment.id}/refunds`)
      .set('Idempotency-Key', 'shared-key').send({ amount: '2.00' }).expect(409);
    // Cross-parent retrieval cannot expose even a known refund ID.
    await call(b.token).get(`/api/v1/payments/${b.paymentId}/refunds/${first.body.id}`).expect(404);
  });

  it('enforces member/viewer read-only access and API-key TEST/LIVE isolation including replay', async () => {
    if (!available) return;
    const a = await setup('isolation');
    const url = `/api/v1/payments/${a.paymentId}/refunds`;
    const register = await request(server()).post('/api/v1/auth/register')
      .send({ email: `refund-member-${stamp}@example.com`, password }).expect(201);
    const member = register.body.user.id as string;
    await prisma.organizationMember.create({ data: {
      id: uuidv7(), organizationId: a.orgId, userId: member, role: 'member',
      createdAt: new Date(), updatedAt: new Date(),
    } });
    await call(register.body.access_token).get(url).expect(200);
    await call(register.body.access_token).post(url).send({ amount: '1.00' }).expect(403);

    const testKey = await call(a.token).post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'test' }).expect(201);
    const liveKey = await call(a.token).post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'live' }).expect(201);
    const first = await request(server()).post(url)
      .set('Authorization', `Bearer ${testKey.body.key}`)
      .set('Idempotency-Key', 'environment-key').send({ amount: '1.00' }).expect(201);

    const liveCustomer = await call(a.token).post(`/api/v1/projects/${a.projectId}/customers`)
      .send({ environment: 'live', email: `live-${stamp}@example.com` }).expect(201);
    const livePayment = await call(a.token).post(`/api/v1/projects/${a.projectId}/payments`)
      .send({ environment: 'live', customer_id: liveCustomer.body.id, amount: '10.00', currency: 'usd' }).expect(201);
    await prisma.payment.update({ where: { id: livePayment.body.id }, data: { status: 'succeeded' } });
    const liveUrl = `/api/v1/payments/${livePayment.body.id}/refunds`;
    await request(server()).get(url).set('Authorization', `Bearer ${liveKey.body.key}`).expect(404);
    await request(server()).get(liveUrl).set('Authorization', `Bearer ${testKey.body.key}`).expect(404);
    const rejected = await request(server()).post(liveUrl)
      .set('Authorization', `Bearer ${liveKey.body.key}`)
      .set('Idempotency-Key', 'environment-key').send({ amount: '1.00' }).expect(409);
    expect(JSON.stringify(rejected.body)).not.toContain(first.body.id);
    expect(await prisma.refund.count({ where: { paymentId: livePayment.body.id } })).toBe(0);
  });

  it('replays one successful result across modes, rejects non-succeeded payments, and reevaluates expired keys', async () => {
    if (!available) return;
    const a = await setup('balance');
    const url = `/api/v1/payments/${a.paymentId}/refunds`;
    // Terminal `failed` is deterministic: the payment read-time transition
    // cannot advance it, so the 422 comes from the refund rule and not timing.
    await prisma.payment.update({ where: { id: a.paymentId }, data: { status: 'failed' } });
    await call(a.token).post(url).send({ amount: '1.00' }).expect(422);
    await prisma.payment.update({ where: { id: a.paymentId }, data: { status: 'succeeded' } });
    const first = await call(a.token).post(url).set('Idempotency-Key', 'expires-test')
      .send({ amount: '3.00' }).expect(201);
    const key = await call(a.token).post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'test' }).expect(201);
    const replay = await request(server()).post(url)
      .set('Authorization', `Bearer ${key.body.key}`)
      .set('Idempotency-Key', 'expires-test').send({ amount: '9.00' }).expect(201);
    expect(replay.body).toEqual(first.body);
    // The port carries the payment's own events too (phase 10 §4.1.2), so the
    // assertion is on the refund events this request produced: the idempotent
    // replay created none.
    expect(events.filter((item) => item.type === 'refund.created')).toHaveLength(1);
    await prisma.idempotencyRecord.updateMany({
      where: { projectId: a.projectId, operationScope: 'refunds.create' },
      data: { expiresAt: new Date(0) },
    });
    const next = await call(a.token).post(url).set('Idempotency-Key', 'expires-test')
      .send({}).expect(201);
    expect(next.body.amount).toBe('7.00');
    expect(events.filter((item) => item.type === 'refund.created')).toHaveLength(2);
  });
});
