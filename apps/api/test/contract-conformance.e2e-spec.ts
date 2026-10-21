import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uuidv7 } from '../src/common/uuid/uuid';
import { PrismaService } from '../src/prisma/prisma.service';
import { getConformance } from './support/conformance';
import { requireDependencies } from './support/db-e2e';
import { runPassword } from './support/run-password';

/**
 * Phase 17 D5(a) / ADR-0035: bounded response-schema conformance.
 *
 * The canonical contract (`docs/openapi.yaml`, ADR-0012) is compared against
 * **real** responses of real requests: a body produced by the running API is
 * validated against the schema the contract documents for that exact
 * `(operationId, status)` pair. A mismatch here is implementation↔contract
 * drift and fails the suite — not a warning, not a skip (phase 17 §17).
 *
 * Scope is deliberately bounded (D5 confirmed it, Q4 forbids widening it):
 * only the pairs in {@link COVERED_OPERATIONS} are validated, and a final test
 * fails if any listed pair was never exercised against a real response, so the
 * allowlist cannot rot into a list of untested claims (rule 5).
 *
 * `additionalProperties: false` is stripped by the helper before compilation,
 * so a legitimately additive response field never fails the build — the point
 * is drift in documented shape, not freezing the schema.
 */
jest.setTimeout(60_000);

const stamp = Date.now().toString(36);
// Phase 17 §8/F6: generated per run and per suite — no committed literal, no
// credential reused across suites (policy: Phase 3 D6, `runPassword`).
const password = runPassword('conformance');
const PREFIX = `conf-${stamp}`;

/**
 * The maintained allowlist of covered `(operationId, status)` pairs — the
 * bounded contract scope of D5(a). Every entry must be exercised against a
 * real response by this file (enforced by the last test of this suite).
 */
const COVERED_OPERATIONS: ReadonlyArray<readonly [operationId: string, status: number]> = [
  // Journey (C2): project → customer → payment → refund.
  ['projects.create', 201],
  ['projects.list', 200],
  ['customers.create', 201],
  ['customers.list', 200],
  ['customers.list', 400],
  ['payments.create', 201],
  ['payments.create', 400],
  ['payments.retrieve', 200],
  ['payments.retrieve', 404],
  ['payments.list', 200],
  ['payments.list', 401],
  ['refunds.create', 201],
  ['refunds.list', 200],
  // Webhook registration and the event/delivery projections (C6 inputs).
  ['webhooks.createEndpoint', 201],
  ['webhooks.listEndpoints', 200],
  ['webhooks.listEvents', 200],
  ['webhooks.listDeliveries', 200],
];

describe('contract conformance against real responses (phase 17 D5(a))', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let available = false;

  const conformance = getConformance();
  /** Pairs actually exercised against a real response body. */
  const exercised = new Set<string>();

  const server = () => app.getHttpServer();
  const call = (token: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));

  /**
   * Validates a real response against the contract and records the pair as
   * exercised. The assertion message names the operation, status and failing
   * schema paths — never the response body (signing secrets must not leak).
   */
  const conform = (operationId: string, status: number, body: unknown): void => {
    conformance.assert(operationId, status, body);
    exercised.add(`${operationId}:${status}`);
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    try {
      await prisma.ping();
      await prisma.$queryRaw`SELECT id FROM projects LIMIT 0`;
      available = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(async () => {
    requireDependencies(available);
    // Only clean resources created by this suite; never wipe shared test data.
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: PREFIX, endsWith: `-${stamp}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      await prisma.webhookDelivery.deleteMany({ where: { endpoint: { projectId: { in: projectIds } } } });
      await prisma.webhookEndpoint.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.webhookEvent.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.refund.deleteMany({ where: { payment: { projectId: { in: projectIds } } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.organization.deleteMany({
        where: { id: { in: projects.map((project) => project.organizationId) } },
      });
    }
    await prisma.user.deleteMany({
      where: { email: { startsWith: PREFIX, endsWith: `-${stamp}@example.com` } },
    });
  });

  /** Registers a user and creates their organization; resources come next. */
  async function register(name: string): Promise<{ token: string; orgId: string }> {
    const email = `${PREFIX}-${name}-${stamp}@example.com`;
    const registration = await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Conformance ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `${PREFIX}-${name}-${stamp}` })
      .expect(201);
    return { token, orgId: org.body.id as string };
  }

  /** Polls until `check` is truthy or the timeout elapses (never a fixed sleep). */
  async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('validates a real journey: project, customer, payment, webhook and refund bodies', async () => {
    requireDependencies(available);
    const { token, orgId } = await register('journey');

    const project = await call(token)
      .post('/api/v1/projects')
      .send({ name: `${PREFIX}-journey-${stamp}`, organization_id: orgId })
      .expect(201);
    conform('projects.create', 201, project.body);
    const projectId = project.body.id as string;

    const projects = await call(token).get('/api/v1/projects').expect(200);
    conform('projects.list', 200, projects.body);

    const customer = await call(token)
      .post(`/api/v1/projects/${projectId}/customers`)
      .send({ environment: 'test', email: `${PREFIX}-journey-${stamp}@example.com` })
      .expect(201);
    conform('customers.create', 201, customer.body);
    const customerId = customer.body.id as string;

    const customers = await call(token)
      .get(`/api/v1/projects/${projectId}/customers?environment=test`)
      .expect(200);
    conform('customers.list', 200, customers.body);

    // The endpoint exists before the payment, so its event fans out into a
    // delivery row the deliveries projection can return.
    const endpoint = await call(token)
      .post(`/api/v1/projects/${projectId}/webhook-endpoints`)
      .send({
        environment: 'test',
        url: `http://127.0.0.1:9/${stamp}`,
        event_types: ['payment.created'],
      })
      .expect(201);
    conform('webhooks.createEndpoint', 201, endpoint.body);

    const endpoints = await call(token)
      .get(`/api/v1/projects/${projectId}/webhook-endpoints?environment=test`)
      .expect(200);
    conform('webhooks.listEndpoints', 200, endpoints.body);

    const payment = await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    conform('payments.create', 201, payment.body);
    const paymentId = payment.body.id as string;

    const payments = await call(token)
      .get(`/api/v1/projects/${projectId}/payments?environment=test`)
      .expect(200);
    conform('payments.list', 200, payments.body);

    const retrieved = await call(token)
      .get(`/api/v1/projects/${projectId}/payments/${paymentId}`)
      .expect(200);
    conform('payments.retrieve', 200, retrieved.body);

    const events = await call(token)
      .get(`/api/v1/projects/${projectId}/webhook-events?environment=test`)
      .expect(200);
    conform('webhooks.listEvents', 200, events.body);

    // The delivery row is written with the event's fan-out; poll rather than
    // assume the commit ordering (rule 4: no fixed sleeps).
    await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
      });
      return row ?? null;
    }, 'the fan-out delivery row of the payment.created event');

    const deliveries = await call(token)
      .get(`/api/v1/projects/${projectId}/webhook-endpoints/${endpoint.body.id}/deliveries`)
      .expect(200);
    conform('webhooks.listDeliveries', 200, deliveries.body);

    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'succeeded' } });
    const refund = await call(token)
      .post(`/api/v1/payments/${paymentId}/refunds`)
      .send({ amount: '3.00' })
      .expect(201);
    conform('refunds.create', 201, refund.body);

    const refunds = await call(token).get(`/api/v1/payments/${paymentId}/refunds`).expect(200);
    conform('refunds.list', 200, refunds.body);
  });

  it('validates the error envelope the contract documents for 400, 401 and 404', async () => {
    requireDependencies(available);
    const { token, orgId } = await register('errors');

    const project = await call(token)
      .post('/api/v1/projects')
      .send({ name: `${PREFIX}-errors-${stamp}`, organization_id: orgId })
      .expect(201);
    const projectId = project.body.id as string;

    // 400 VALIDATION_ERROR: a body missing every required field.
    const invalid = await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({})
      .expect(400);
    conform('payments.create', 400, invalid.body);

    // 400 on a session list without the required `environment` query.
    const missingEnvironment = await call(token)
      .get(`/api/v1/projects/${projectId}/customers`)
      .expect(400);
    conform('customers.list', 400, missingEnvironment.body);

    // 401 without any credentials.
    const unauthenticated = await request(server())
      .get(`/api/v1/projects/${projectId}/payments`)
      .expect(401);
    conform('payments.list', 401, unauthenticated.body);

    // 404 for a payment id that does not exist (the shared NotFound $ref).
    const notFound = await call(token)
      .get(`/api/v1/projects/${projectId}/payments/${uuidv7()}`)
      .expect(404);
    conform('payments.retrieve', 404, notFound.body);
  });

  it('only allowlists operation/status pairs the canonical contract documents', () => {
    for (const [operationId, status] of COVERED_OPERATIONS) {
      // Documented pairs validate (against `null`, which simply fails the
      // schema); undocumented pairs and unknown operation ids throw — so
      // "does not throw" is exactly "the pair exists in the contract".
      expect(() => conformance.validate(operationId, status, null)).not.toThrow();
    }
  });

  it('exercises every pair of the maintained allowlist against a real response', () => {
    const unexercised = COVERED_OPERATIONS.filter(
      ([operationId, status]) => !exercised.has(`${operationId}:${status}`),
    );
    expect(unexercised).toEqual([]);
  });
});
