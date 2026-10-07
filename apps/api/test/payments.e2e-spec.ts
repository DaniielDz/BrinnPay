import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AUDIT_LOG_PORT, type AuditLogPort } from '../src/audit-logging/audit-log.port';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uuidv7 } from '../src/common/uuid/uuid';
import { PaymentsService } from '../src/payments/payments.service';
import { FAILURE_CODES } from '../src/payments/payment-scenario';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 16 e2e (§11.3 — F11): the payments HTTP surface with the scenario
 * fields, exercised end-to-end against **real PostgreSQL and Redis**.
 *
 * This suite exists so Phase 16 "does not deepen the Phase 7 OQ-2 gap": the
 * `payments.create`/`payments.retrieve` routes previously had no HTTP-level
 * suite of their own, and the scenario rules are boundary rules (§4.2 AC4) whose
 * whole point is where they are enforced.
 *
 * The webhooks module's real `WEBHOOK_EVENT_PORT` is used — no port override —
 * so `payment.created`/`payment.failed` rows and the delivery fan-out they imply
 * are asserted for real (§11.2 "event row + delivery rows"). The BullMQ consumer
 * is a separate process (`webhooks-worker.module.ts` is deliberately not part of
 * `AppModule`), so deliveries stay `pending` with `attempts: 0` — exactly the
 * state the API surfaces.
 *
 * Timing is controlled by backdating `created_at`, the pattern `webhooks` and
 * `idempotency` already use: the schedule is a pure function of
 * `(scenario, created_at, delays)` (§4.3 rule 2), so backdating is the
 * deterministic equivalent of waiting. No sleeps.
 */
const stamp = Date.now().toString(36);
const password = 'password-123';
const PREFIX = `pay16-${stamp}`;

jest.setTimeout(60_000);

interface Scope {
  token: string;
  orgId: string;
  projectId: string;
  customerId: string;
}

describe('payments scenarios (Phase 16, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let available = false;

  const server = () => app.getHttpServer();
  const call = (token: string) =>
    request.agent(server()).use((req: request.Request) => req.set('Authorization', `Bearer ${token}`));

  const header = (response: request.Response, name: string) => response.headers[name.toLowerCase()];
  const remaining = (response: request.Response) => Number(header(response, 'RateLimit-Remaining'));

  const base = (customerId: string) => ({
    environment: 'test',
    customer_id: customerId,
    amount: '10.00',
    currency: 'usd',
  });

  const create = (token: string, projectId: string, body: Record<string, unknown>, key?: string) => {
    const req = call(token).post(`/api/v1/projects/${projectId}/payments`).send(body);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    try {
      await prisma.ping();
      // A migrated database is required; never operate on an older schema —
      // `simulation_scenario` is phase 16's whole subject.
      await prisma.$queryRaw`SELECT simulation_scenario FROM payments LIMIT 0`;
      await app.get(RedisService).ping();
      available = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function setup(name: string): Promise<Scope> {
    const email = `${PREFIX}-${name}@example.com`;
    const registration = await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Pay16 ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `${PREFIX}-${name}` })
      .expect(201);
    const project = await call(token)
      .post('/api/v1/projects')
      .send({ name: `${name}-${stamp}`, organization_id: org.body.id })
      .expect(201);
    const customer = await call(token)
      .post(`/api/v1/projects/${project.body.id}/customers`)
      .send({ environment: 'test', email })
      .expect(201);
    return {
      token,
      orgId: org.body.id as string,
      projectId: project.body.id as string,
      customerId: customer.body.id as string,
    };
  }

  /** Makes the whole schedule (pending + settlement delay) already elapsed. */
  const backdate = (paymentId: string) =>
    prisma.payment.update({
      where: { id: paymentId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

  const row = (paymentId: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

  const eventsOf = (projectId: string, type: string) =>
    prisma.webhookEvent.count({ where: { projectId, type } });

  const auditOf = (paymentId: string) =>
    prisma.auditLogEntry.findMany({
      where: { resourceId: paymentId, action: { startsWith: 'payment.' } },
      orderBy: { id: 'asc' },
    });

  const fieldsOf = (response: request.Response) =>
    ((response.body.error.details as { fields: { field: string }[] }).fields ?? []).map(
      (entry) => entry.field,
    );

  afterEach(async () => {
    requireDependencies(available);
    // Only clean resources created by this suite; never wipe shared test data.
    const projects = await prisma.project.findMany({
      // `PREFIX` embeds this run's timestamp, so it is unique on its own — no
      // suffix matching is needed (and none would work: names carry the slug
      // after the stamp).
      where: { organization: { name: { startsWith: PREFIX } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      await prisma.webhookDelivery.deleteMany({
        where: { endpoint: { projectId: { in: projectIds } } },
      });
      await prisma.webhookEndpoint.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.webhookEvent.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.refund.deleteMany({ where: { payment: { projectId: { in: projectIds } } } });
      await prisma.payment.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.customer.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.organization.deleteMany({
        where: { id: { in: projects.map((project) => project.organizationId) } },
      });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  });

  // -------------------------------------------------------------------------
  // AC1 — success simulation intact; D6 — the scenario is never projected
  // -------------------------------------------------------------------------

  it('AC1: an unflagged create advances on schedule, succeeds, and exposes no scenario field', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('success');

    const created = await create(token, projectId, base(customerId)).expect(201);
    // D6 (a): no new response field — only the pre-existing `Payment` keys.
    expect(Object.keys(created.body).sort()).toEqual([
      'amount',
      'created_at',
      'currency',
      'customer_id',
      'description',
      'environment',
      'failure_code',
      'id',
      'project_id',
      'status',
      'updated_at',
    ]);
    expect(created.body).toMatchObject({ status: 'pending', failure_code: null });
    expect((await row(created.body.id)).simulationScenario).toBeNull();

    await backdate(created.body.id);
    const advanced = await call(token)
      .get(`/api/v1/projects/${projectId}/payments/${created.body.id}`)
      .expect(200);
    expect(advanced.body).toMatchObject({ status: 'succeeded', failure_code: null });
    expect(await eventsOf(projectId, 'payment.succeeded')).toBe(1);
    expect(await eventsOf(projectId, 'payment.failed')).toBe(0);
    expect((await auditOf(created.body.id)).map((entry) => entry.action)).toEqual([
      'payment.created',
      'payment.succeeded',
    ]);
  });

  // -------------------------------------------------------------------------
  // AC2/AC3 + F2 — decline through the sweep driver (§11.2, no reads)
  // -------------------------------------------------------------------------

  it.each(FAILURE_CODES)(
    'AC2/AC3: sweep-driven decline lands %s in one CAS with the event, the payload and the audit entry',
    async (code) => {
      requireDependencies(available);
      const { token, projectId, customerId } = await setup(`decline-${code}`);

      // The delivery fan-out is asserted too (§11.2), which needs an endpoint.
      const endpoint = await call(token)
        .post(`/api/v1/projects/${projectId}/webhook-endpoints`)
        .send({
          environment: 'test',
          url: `https://example.com/hooks/pay16-${code}`,
          event_types: ['payment.created', 'payment.succeeded', 'payment.failed'],
        })
        .expect(201);

      const created = await create(token, projectId, {
        ...base(customerId),
        scenario: 'decline',
        failure_code: code,
      }).expect(201);
      // D6 (a): the outcome is hidden at creation; only `status`/`failure_code` speak.
      expect(created.body).toMatchObject({ status: 'pending', failure_code: null });

      // The intent is persisted for the sweep, which has no request context.
      expect((await row(created.body.id)).simulationScenario).toBe(`decline:${code}`);

      await backdate(created.body.id);
      // One sweep pass, **no reads** — this is the §11.2 driver path.
      await payments.advanceDuePayments(new Date());

      const stored = await row(created.body.id);
      expect(stored).toMatchObject({ status: 'failed', failureCode: code });

      // Exactly one event, and its payload already carries the code (F2).
      expect(await eventsOf(projectId, 'payment.failed')).toBe(1);
      const event = await prisma.webhookEvent.findFirstOrThrow({
        where: { projectId, type: 'payment.failed' },
      });
      expect((event.payload as { data: { status: string; failure_code: string } }).data).toMatchObject({
        status: 'failed',
        failure_code: code,
      });

      // The delivery row exists in the same fan-out; no worker runs here.
      const deliveries = await prisma.webhookDelivery.findMany({ where: { eventId: event.id } });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        endpointId: endpoint.body.id,
        status: 'pending',
        attempts: 0,
        isReplay: false,
      });

      // Exactly one audit entry, carrying the same code (§4.3 rule 9).
      const entries = await auditOf(created.body.id);
      expect(entries.map((entry) => entry.action)).toEqual(['payment.created', 'payment.failed']);
      expect(entries[1].data).toMatchObject({ failure_code: code });

      // The API projection agrees with all three (AC2).
      const read = await call(token)
        .get(`/api/v1/projects/${projectId}/payments/${created.body.id}`)
        .expect(200);
      expect(read.body).toMatchObject({ status: 'failed', failure_code: code });
      // Terminal states are absorbing: a second pass changes nothing.
      await payments.advanceDuePayments(new Date());
      expect(await row(created.body.id)).toMatchObject({ status: 'failed', failureCode: code });
      expect(await eventsOf(projectId, 'payment.failed')).toBe(1);
      expect(await auditOf(created.body.id)).toHaveLength(2);
    },
  );

  it('AC2: decline without failure_code defaults to card_declined on the read-catch-up path', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('decline-default');

    const created = await create(token, projectId, {
      ...base(customerId),
      scenario: 'decline',
    }).expect(201);
    expect((await row(created.body.id)).simulationScenario).toBe('decline:card_declined');

    await backdate(created.body.id);
    const read = await call(token)
      .get(`/api/v1/projects/${projectId}/payments/${created.body.id}`)
      .expect(200);
    expect(read.body).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect(await eventsOf(projectId, 'payment.failed')).toBe(1);
    expect(await eventsOf(projectId, 'payment.succeeded')).toBe(0);
    const entries = await auditOf(created.body.id);
    expect(entries[entries.length - 1].data).toMatchObject({ failure_code: 'card_declined' });
  });

  it('AC12: a read and the sweep contending on the same declined payment emit exactly one failure', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('decline-race');

    const created = await create(token, projectId, {
      ...base(customerId),
      scenario: 'decline',
      failure_code: 'insufficient_funds',
    }).expect(201);
    await backdate(created.body.id);

    // Two drivers over the same row: only the CAS winner writes and emits (F2).
    await Promise.all([
      call(token).get(`/api/v1/projects/${projectId}/payments/${created.body.id}`).expect(200),
      payments.advanceDuePayments(new Date()),
    ]);

    expect(await row(created.body.id)).toMatchObject({
      status: 'failed',
      failureCode: 'insufficient_funds',
    });
    expect(await eventsOf(projectId, 'payment.failed')).toBe(1);
    expect(await auditOf(created.body.id)).toEqual([
      expect.objectContaining({ action: 'payment.created' }),
      expect.objectContaining({ action: 'payment.failed' }),
    ]);
  });

  it('§11.2 rollback: a failed edge transaction persists none of {status, code, event, audit}; the next pass retries cleanly', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('rollback');

    const created = await create(token, projectId, {
      ...base(customerId),
      scenario: 'decline',
      failure_code: 'insufficient_funds',
    }).expect(201);
    const paymentId = created.body.id as string;
    await backdate(paymentId);

    // The terminal edge writes {status, code} by CAS, then the event row, then
    // the audit entry — all inside one transaction (F2/§4.7). Failing on *this*
    // payment's audit write, after the first two already ran inside the
    // transaction, is what proves the rollback erases work already done in it
    // (the port is the same singleton the service injected, so the spy is the
    // real boundary). Other payments keep their real audit path: this is a
    // global sweep and a one-shot rejection could be consumed by a foreign row.
    const audit = app.get<AuditLogPort>(AUDIT_LOG_PORT);
    const record = audit.record.bind(audit);
    const spy = jest
      .spyOn(audit, 'record')
      .mockImplementation((tx, capture) =>
        'payment_id' in capture && capture.payment_id === paymentId
          ? Promise.reject(new Error('forced audit failure'))
          : record(tx, capture),
      );

    try {
      await payments.advanceDuePayments(new Date());
    } finally {
      spy.mockRestore();
    }

    // None of the four persists: the payment is mid-schedule with no code...
    expect(await row(paymentId)).toMatchObject({
      status: 'processing',
      failureCode: null,
      simulationScenario: 'decline:insufficient_funds',
    });
    // ...and neither the failure event nor its audit entry exists — no surface
    // may show a failure the payment did not commit.
    expect(await eventsOf(projectId, 'payment.failed')).toBe(0);
    expect((await auditOf(paymentId)).map((entry) => entry.action)).toEqual(['payment.created']);

    // The next pass retries the same edge cleanly: exactly one of each, and the
    // three surfaces agree on the code (AC2/AC3).
    await payments.advanceDuePayments(new Date());
    expect(await row(paymentId)).toMatchObject({
      status: 'failed',
      failureCode: 'insufficient_funds',
    });
    expect(await eventsOf(projectId, 'payment.failed')).toBe(1);
    const entries = await auditOf(paymentId);
    expect(entries.map((entry) => entry.action)).toEqual(['payment.created', 'payment.failed']);
    expect(entries[1].data).toMatchObject({ failure_code: 'insufficient_funds' });
  });

  // -------------------------------------------------------------------------
  // AC5 — timeout never settles
  // -------------------------------------------------------------------------

  it('AC5: a timeout payment reaches processing and never settles across reads and sweep passes', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('timeout');

    const created = await create(token, projectId, {
      ...base(customerId),
      scenario: 'timeout',
    }).expect(201);
    expect(created.body).toMatchObject({ status: 'pending', failure_code: null });
    expect((await row(created.body.id)).simulationScenario).toBe('timeout');

    await backdate(created.body.id);
    // The pending edge is due, the settlement edge is never computed.
    const sweep = await payments.advanceDuePayments(new Date());
    expect(sweep).toBeGreaterThanOrEqual(1);
    expect(await row(created.body.id)).toMatchObject({
      status: 'processing',
      failureCode: null,
    });

    // Repeated sweep passes and fresh reads change nothing: the outcome is
    // re-derived from the row (§4.3 rule 2), not from any in-memory timer.
    for (let pass = 0; pass < 3; pass += 1) {
      await payments.advanceDuePayments(new Date());
      const read = await call(token)
        .get(`/api/v1/projects/${projectId}/payments/${created.body.id}`)
        .expect(200);
      expect(read.body).toMatchObject({ status: 'processing', failure_code: null });
    }

    const stored = await row(created.body.id);
    expect(stored).toMatchObject({ status: 'processing', failureCode: null, simulationScenario: 'timeout' });
    // `payment.created` and nothing else, ever (§4.3 rule 8 / D7).
    expect(await eventsOf(projectId, 'payment.created')).toBe(1);
    expect(await eventsOf(projectId, 'payment.succeeded')).toBe(0);
    expect(await eventsOf(projectId, 'payment.failed')).toBe(0);
    expect((await auditOf(created.body.id)).map((entry) => entry.action)).toEqual(['payment.created']);

    // Refunds stay unavailable — the Phase 9 refundability rule is untouched.
    await call(token).post(`/api/v1/payments/${created.body.id}/refunds`).send({ amount: '1.00' }).expect(422);
  });

  it('explicit scenario: "succeed" is persisted and succeeds like the default', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('explicit-succeed');

    const created = await create(token, projectId, {
      ...base(customerId),
      scenario: 'succeed',
    }).expect(201);
    expect((await row(created.body.id)).simulationScenario).toBe('succeed');

    await backdate(created.body.id);
    await payments.advanceDuePayments(new Date());
    expect(await row(created.body.id)).toMatchObject({ status: 'succeeded', failureCode: null });
    expect(await eventsOf(projectId, 'payment.succeeded')).toBe(1);
    expect(await eventsOf(projectId, 'payment.failed')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC4 — boundary validation, no side effects, key stays reusable
  // -------------------------------------------------------------------------

  it('AC4: every scenario error is a 400 field error that creates nothing and leaves the key reusable', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('ac4');

    const cases: { body: Record<string, unknown>; fields: string[] }[] = [
      { body: { scenario: 'explode' }, fields: ['scenario'] },
      { body: { scenario: 'DECLINE' }, fields: ['scenario'] },
      { body: { failure_code: 'gateway_blah' }, fields: ['failure_code'] },
      { body: { ...base(customerId), scenario: 'succeed', failure_code: 'card_declined' }, fields: ['failure_code'] },
      { body: { ...base(customerId), scenario: 'timeout', failure_code: 'insufficient_funds' }, fields: ['failure_code'] },
      { body: { ...base(customerId), scenario: null }, fields: ['scenario'] },
      { body: { ...base(customerId), failure_code: null }, fields: ['failure_code'] },
      { body: { ...base(customerId), scenario: 'decline', failure_code: null }, fields: ['failure_code'] },
    ];

    const before = {
      payments: await prisma.payment.count({ where: { projectId } }),
      events: await prisma.webhookEvent.count({ where: { projectId } }),
      audit: await prisma.auditLogEntry.count({ where: { projectId } }),
    };

    for (const [index, scenarioCase] of cases.entries()) {
      const response = await create(
        token,
        projectId,
        scenarioCase.body,
        `ac4-key-${index}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      const fields = fieldsOf(response);
      for (const expected of scenarioCase.fields) {
        expect(fields).toContain(expected);
      }
    }

    expect(await prisma.payment.count({ where: { projectId } })).toBe(before.payments);
    expect(await prisma.webhookEvent.count({ where: { projectId } })).toBe(before.events);
    expect(await prisma.auditLogEntry.count({ where: { projectId } })).toBe(before.audit);

    // The first key was never claimed by its rejected request (§4.2, AC4).
    const reused = await create(
      token,
      projectId,
      { ...base(customerId), scenario: 'decline' },
      'ac4-key-0',
    ).expect(201);
    expect(reused.body).toMatchObject({ status: 'pending', failure_code: null });
    expect(await prisma.payment.count({ where: { projectId } })).toBe(before.payments + 1);
    expect(await prisma.idempotencyRecord.count({ where: { projectId } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC6 — idempotency
  // -------------------------------------------------------------------------

  it('AC6: same key + same body replays the stored 201 verbatim and creates no second side effect', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('ac6');

    const body = { ...base(customerId), scenario: 'decline', failure_code: 'processing_timeout' };
    const first = await create(token, projectId, body, 'scenario-idem-1').expect(201);
    const replay = await create(token, projectId, body, 'scenario-idem-1').expect(201);

    expect(replay.body).toEqual(first.body);
    // One payment, one `payment.created`, one `payment.created` audit entry —
    // the setup's own `customer.created` audit entry is not part of this.
    expect(await prisma.payment.count({ where: { projectId } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { projectId, type: 'payment.created' } })).toBe(1);
    expect(await prisma.auditLogEntry.count({ where: { projectId, action: 'payment.created' } })).toBe(1);

    // The replayed snapshot is stable after the payment advanced (§4.2.4).
    await backdate(first.body.id);
    await call(token).get(`/api/v1/projects/${projectId}/payments/${first.body.id}`).expect(200);
    const after = await create(token, projectId, body, 'scenario-idem-1').expect(201);
    expect(after.body).toEqual(first.body);
    expect(await prisma.payment.count({ where: { projectId } })).toBe(1);
    // The read added `payment.succeeded`, never a second `payment.created`.
    expect(await prisma.webhookEvent.count({ where: { projectId, type: 'payment.created' } })).toBe(1);
    expect(await prisma.auditLogEntry.count({ where: { projectId, action: 'payment.created' } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC10 — capability, tenant isolation and scope with the new fields
  // -------------------------------------------------------------------------

  it('AC10: member and viewer get 403 with the new fields present, and no payment is created', async () => {
    requireDependencies(available);
    const { token, orgId, projectId, customerId } = await setup('rbac');

    const roles = ['member', 'viewer'] as const;
    for (const role of roles) {
      const email = `${PREFIX}-${role}-${stamp}@example.com`;
      const registration = await request(server())
        .post('/api/v1/auth/register')
        .send({ email, password, name: `Pay16 ${role}` })
        .expect(201);
      await prisma.organizationMember.create({
        data: {
          id: uuidv7(),
          organizationId: orgId,
          userId: registration.body.user.id as string,
          role,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Read capability is unchanged: the member can still see payments.
      await call(registration.body.access_token as string)
        .get(`/api/v1/projects/${projectId}/payments`)
        .query({ environment: 'test' })
        .expect(200);

      const denied = await create(registration.body.access_token as string, projectId, {
        ...base(customerId),
        scenario: 'decline',
        failure_code: 'card_declined',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgId, role } });
    }

    // The owner still can — the scenario path adds no capability of its own.
    await create(token, projectId, { ...base(customerId), scenario: 'timeout' }).expect(201);
    expect(await prisma.payment.count({ where: { projectId } })).toBe(1);
  });

  it('cross-project and cross-environment lookups with the new fields still answer 404, and a key mismatch 422', async () => {
    requireDependencies(available);
    const a = await setup('iso-a');
    const b = await setup('iso-b');

    const created = await create(a.token, a.projectId, {
      ...base(a.customerId),
      scenario: 'decline',
    }).expect(201);

    // Session mode: another organization's token cannot reach the payment.
    const crossProject = await create(b.token, a.projectId, {
      ...base(a.customerId),
      scenario: 'decline',
    });
    expect(crossProject.status).toBe(404);
    expect(crossProject.body.error.code).toBe('NOT_FOUND');
    // Another organization's token cannot reach the payment either.
    await call(b.token).get(`/api/v1/projects/${a.projectId}/payments/${created.body.id}`).expect(404);
    // Addressing B's own project with A's payment id is equally 404.
    await call(b.token).get(`/api/v1/projects/${b.projectId}/payments/${created.body.id}`).expect(404);

    // API-key mode: TEST/LIVE are never mixed.
    const testKey = await call(a.token)
      .post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    const liveKey = await call(a.token)
      .post(`/api/v1/projects/${a.projectId}/api-keys`)
      .send({ environment: 'live' })
      .expect(201);

    const mismatch = await request(server())
      .post(`/api/v1/projects/${a.projectId}/payments`)
      .set('Authorization', `Bearer ${testKey.body.key}`)
      .send({ ...base(a.customerId), scenario: 'decline', failure_code: 'card_declined', environment: 'live' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // A test key cannot see a live payment and vice versa.
    await request(server())
      .get(`/api/v1/projects/${a.projectId}/payments/${created.body.id}`)
      .set('Authorization', `Bearer ${liveKey.body.key}`)
      .expect(404);

    // A cross-project key never reaches the route at all.
    const bKey = await call(b.token)
      .post(`/api/v1/projects/${b.projectId}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    await request(server())
      .post(`/api/v1/projects/${a.projectId}/payments`)
      .set('Authorization', `Bearer ${bKey.body.key}`)
      .send({ ...base(a.customerId), scenario: 'decline' })
      .expect(404);

    // The scenario create works normally inside the key's own scope.
    await request(server())
      .post(`/api/v1/projects/${a.projectId}/payments`)
      .set('Authorization', `Bearer ${testKey.body.key}`)
      .send({ ...base(a.customerId), scenario: 'decline', failure_code: 'insufficient_funds' })
      .expect(201);
  });

  // -------------------------------------------------------------------------
  // AC8 — rate limiting
  // -------------------------------------------------------------------------

  it('AC8: a scenario-flagged create charges the write class exactly once, like an unflagged one', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('ratelimit');

    // Setup traffic is done; measure the two creates back to back so the only
    // budget consumer between them is the flagged create itself.
    const unflagged = await create(token, projectId, base(customerId)).expect(201);
    const flagged = await create(token, projectId, {
      ...base(customerId),
      scenario: 'decline',
      failure_code: 'insufficient_funds',
    }).expect(201);

    // Headers observable (AC8) — the same `write` class, no scenario exemption.
    expect(header(flagged, 'ratelimit-limit')).toBeDefined();
    expect(header(unflagged, 'ratelimit-limit')).toBeDefined();
    expect(remaining(unflagged)).toBeGreaterThan(0);
    // Exactly one unit for the flagged request: the delta is one.
    expect(remaining(unflagged) - remaining(flagged)).toBe(1);
  });
});
