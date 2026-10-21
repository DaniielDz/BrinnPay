import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 10 e2e (§9): the webhook surface end-to-end against real PostgreSQL and
 * Redis — the endpoint registry behind the dual-mode boundary (D10), the closed
 * subscription catalog and URL rules (§4.6), the secret returned exactly once
 * (D8), the durable event fan-out produced by a real payment (D2), delivery
 * listing (D15), and manual replay (D12).
 *
 * The real `WebhookEventService` is used (no port override), so this suite
 * exercises the transactional persistence and fan-out for real. The BullMQ
 * *worker* is not running here, so deliveries stay `pending` — which is exactly
 * the state the API surfaces.
 */
const stamp = Date.now().toString(36);
const password = 'password-123';

describe('webhooks (Phase 10, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let available = false;
  const server = () => app.getHttpServer();
  const call = (token: string) =>
    request.agent(server()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${token}`),
    );

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);
    try {
      await prisma.ping();
      await app.get(RedisService).ping();
      await prisma.webhookDelivery.count();
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
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'wh-', endsWith: `-${stamp}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      // Deliveries and events cascade from their parents, but only after the
      // endpoints/rows that reference them are gone: explicit and ordered.
      await prisma.webhookDelivery.deleteMany({ where: { endpoint: { projectId: { in: projectIds } } } });
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
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'wh-', endsWith: `-${stamp}@example.com` } },
    });
  });

  /** Registers a user, an organization, a project, a customer, and a payment. */
  async function setup(name: string) {
    const email = `wh-${name}-${stamp}@example.com`;
    const registration = await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Webhook ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `wh-${name}-${stamp}` })
      .expect(201);
    const project = await call(token)
      .post('/api/v1/projects')
      .send({ name, organization_id: org.body.id })
      .expect(201);
    const customer = await call(token)
      .post(`/api/v1/projects/${project.body.id}/customers`)
      .send({ environment: 'test', email })
      .expect(201);
    return {
      token,
      email,
      organizationId: org.body.id as string,
      projectId: project.body.id as string,
      customerId: customer.body.id as string,
      endpointsUrl: `/api/v1/projects/${project.body.id}/webhook-endpoints`,
      eventsUrl: `/api/v1/projects/${project.body.id}/webhook-events`,
    };
  }

  const createEndpoint = (token: string, projectId: string, body: Record<string, unknown>) =>
    call(token)
      .post(`/api/v1/projects/${projectId}/webhook-endpoints`)
      .send(body);

  // -------------------------------------------------------------------------
  // Endpoint registry (§4.4, D1/D8/D16)
  // -------------------------------------------------------------------------

  it('registers an endpoint, returns the secret exactly once, and never leaks it again', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl } = await setup('secret');

    const created = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/hooks',
      event_types: ['payment.created', 'refund.created'],
    }).expect(201);

    expect(created.body).toMatchObject({
      project_id: projectId,
      environment: 'test',
      url: 'https://example.com/hooks',
      event_types: ['payment.created', 'refund.created'],
      enabled: true,
    });
    expect(created.body.signing_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const secret = created.body.signing_secret as string;

    // The stored form is ciphertext, never the plaintext.
    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.secretCipher).not.toBe(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);

    for (const response of [
      await call(token).get(`${endpointsUrl}/${created.body.id}`).expect(200),
      await call(token).get(`${endpointsUrl}?environment=test`).expect(200),
      await call(token)
        .patch(`${endpointsUrl}/${created.body.id}`)
        .send({ event_types: ['payment.created'] })
        .expect(200),
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(JSON.stringify(response.body)).not.toContain('signing_secret');
    }
  });

  it('rejects invalid registration payloads at the boundary (400)', async () => {
    requireDependencies(available);
    const { token, projectId } = await setup('invalid');

    const cases: Record<string, unknown>[] = [
      // §4.6: http/https only.
      { environment: 'test', url: 'ftp://example.com/hooks', event_types: ['payment.created'] },
      { environment: 'test', url: 'not-a-url', event_types: ['payment.created'] },
      // Credentials in a URL would be forwarded to the destination.
      { environment: 'test', url: 'https://user:pass@example.com/hooks', event_types: ['payment.created'] },
      { environment: 'test', url: `https://example.com/${'a'.repeat(2100)}`, event_types: ['payment.created'] },
      // D1: the catalog is closed.
      { environment: 'test', url: 'https://example.com/hooks', event_types: ['customer.created'] },
      { environment: 'test', url: 'https://example.com/hooks', event_types: [] },
      { environment: 'test', url: 'https://example.com/hooks', event_types: ['payment.created', 'payment.created'] },
      // The environment is required in the body.
      { url: 'https://example.com/hooks', event_types: ['payment.created'] },
    ];
    for (const payload of cases) {
      const response = await createEndpoint(token, projectId, payload);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(0);
  });

  it('allows a duplicate URL (D16) and rejects an empty patch (400)', async () => {
    requireDependencies(available);
    const { token, projectId } = await setup('duplicate');

    const first = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/hooks',
      event_types: ['payment.created'],
    }).expect(201);
    const second = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/hooks',
      event_types: ['refund.created'],
    }).expect(201);
    expect(second.body.id).not.toBe(first.body.id);

    const empty = await call(token)
      .patch(`/api/v1/projects/${projectId}/webhook-endpoints/${first.body.id}`)
      .send({})
      .expect(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires an explicit environment for session listings (400)', async () => {
    requireDependencies(available);
    const { token, endpointsUrl, eventsUrl } = await setup('env');

    await call(token).get(endpointsUrl).expect(400);
    await call(token).get(eventsUrl).expect(400);
    await call(token).get(`${endpointsUrl}?environment=test`).expect(200);
    await call(token).get(`${eventsUrl}?environment=test`).expect(200);
    // LIVE is a separate addressable space, never mixed with TEST.
    await call(token).get(`${endpointsUrl}?environment=live`).expect(200);
  });

  // -------------------------------------------------------------------------
  // Authorization (§4.5, D10)
  // -------------------------------------------------------------------------

  it('enforces the capability matrix: viewer reads, mutations are 403, non-member is 404', async () => {
    requireDependencies(available);
    const { token, email, organizationId, projectId, endpointsUrl } = await setup('rbac');

    for (const role of ['admin', 'member', 'viewer'] as const) {
      const invitee = `wh-rbac-${role}-${stamp}@example.com`;
      const registration = await request(server())
        .post('/api/v1/auth/register')
        .send({ email: invitee, password, name: `Webhook ${role}` })
        .expect(201);
      const inviteeToken = registration.body.access_token as string;
      const invitation = await call(token)
        .post(`/api/v1/organizations/${organizationId}/invitations`)
        .send({ email: invitee, role })
        .expect(201);
      await call(inviteeToken)
        .post(`/api/v1/invitations/${invitation.body.id}/accept`)
        .expect(201);

      // `webhooks.read` is granted to every role.
      await call(inviteeToken).get(`${endpointsUrl}?environment=test`).expect(200);

      const created = await createEndpoint(token, projectId, {
        environment: 'test',
        url: `https://example.com/${role}`,
        event_types: ['payment.created'],
      }).expect(201);

      if (role === 'viewer' || role === 'member') {
        const forbidden = await createEndpoint(inviteeToken, projectId, {
          environment: 'test',
          url: `https://example.com/${role}-x`,
          event_types: ['payment.created'],
        });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error.code).toBe('FORBIDDEN');

        await call(inviteeToken)
          .patch(`${endpointsUrl}/${created.body.id}`)
          .send({ enabled: false })
          .expect(403);
        await call(inviteeToken).delete(`${endpointsUrl}/${created.body.id}`).expect(403);
        await call(inviteeToken)
          .post(`${endpointsUrl}/${created.body.id}/events/0198f0c2-0000-7000-8000-0000000000e2/replay`)
          .expect(403);
      } else {
        await call(inviteeToken)
          .patch(`${endpointsUrl}/${created.body.id}`)
          .send({ enabled: false })
          .expect(200);
      }
    }

    // A user outside the organization learns nothing: 404, not 403.
    const outsiderEmail = `wh-outsider-${stamp}@example.com`;
    const outsider = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: outsiderEmail, password, name: 'Webhook Outsider' })
      .expect(201);
    const outsiderToken = outsider.body.access_token as string;
    const hidden = await call(outsiderToken).get(`${endpointsUrl}?environment=test`);
    expect(hidden.status).toBe(404);

    expect(email).toBeTruthy();
  });

  it('API-key mode: no environment parameter, a mismatch is 422, another project is 404', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl } = await setup('apikey');
    const other = await setup('apikey-other');

    const created = await call(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment: 'test' })
      .expect(201);
    const key = created.body.key as string;
    const withKey = request.agent(server()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${key}`),
    );

    // F6: the key's environment is derived, never a parameter.
    const registered = await withKey
      .post(endpointsUrl)
      .send({ environment: 'test', url: 'https://example.com/keyed', event_types: ['payment.created'] })
      .expect(201);
    expect(registered.body.environment).toBe('test');
    await withKey.get(endpointsUrl).expect(200);

    const mismatch = await withKey.get(`${endpointsUrl}?environment=live`);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // Tenant isolation: a key of another project cannot even address this one.
    const foreignProject = await withKey.get(
      `/api/v1/projects/${other.projectId}/webhook-endpoints`,
    );
    expect(foreignProject.status).toBe(404);

    // An endpoint of the key's project in the *other* environment is a 404 too.
    await createEndpoint(token, projectId, {
      environment: 'live',
      url: 'https://example.com/live',
      event_types: ['payment.created'],
    }).expect(201);
    const liveKey = await call(token)
      .post(`/api/v1/projects/${projectId}/api-keys`)
      .send({ environment: 'live' })
      .expect(201);
    const liveWithKey = request.agent(server()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${liveKey.body.key}`),
    );
    const testScoped = await liveWithKey.get(
      `/api/v1/projects/${projectId}/webhook-endpoints/${registered.body.id}`,
    );
    expect(testScoped.status).toBe(404);
  });

  it('API-key mode drives all eight operations without an environment parameter (F6, §4.4)', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('apikey-all');
    const key = (
      await call(token)
        .post(`/api/v1/projects/${projectId}/api-keys`)
        .send({ environment: 'test' })
        .expect(201)
    ).body.key as string;
    const withKey = request.agent(server()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${key}`),
    );
    const base = `/api/v1/projects/${projectId}/webhook-endpoints`;

    // 1. create
    const endpoint = await withKey
      .post(base)
      .send({ environment: 'test', url: 'https://example.com/all', event_types: ['payment.created'] })
      .expect(201);
    // 2. list
    const listed = await withKey.get(base).expect(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(endpoint.body.id);
    // 3. retrieve
    await withKey.get(`${base}/${endpoint.body.id}`).expect(200);
    // 4. update
    const updated = await withKey
      .patch(`${base}/${endpoint.body.id}`)
      .send({ enabled: false })
      .expect(200);
    expect(updated.body.enabled).toBe(false);
    await withKey.patch(`${base}/${endpoint.body.id}`).send({ enabled: true }).expect(200);

    // Produce an event + delivery (the payment itself is a session call; the
    // webhook surface is what must work under the key).
    await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    // 5. list events
    const events = await withKey.get(`/api/v1/projects/${projectId}/webhook-events`).expect(200);
    const event = events.body.data.find((row: { type: string }) => row.type === 'payment.created');
    expect(event).toBeTruthy();
    // 6. list deliveries
    const deliveries = await withKey.get(`${base}/${endpoint.body.id}/deliveries`).expect(200);
    expect(deliveries.body.data.length).toBeGreaterThanOrEqual(1);
    // 7. replay
    await withKey
      .post(`${base}/${endpoint.body.id}/events/${event.id}/replay`)
      .expect(202);
    // 8. delete
    await withKey.delete(`${base}/${endpoint.body.id}`).expect(204);
    await withKey.get(`${base}/${endpoint.body.id}`).expect(404);
  });

  it('paginates with stable opaque cursors and enforces the limit boundaries (D15)', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl, eventsUrl, customerId } = await setup('paging');
    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/paging',
      event_types: ['payment.created'],
    }).expect(201);
    for (let i = 0; i < 3; i += 1) {
      await call(token)
        .post(`/api/v1/projects/${projectId}/payments`)
        .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
        .expect(201);
    }

    // The cursor is the last id of the page, and pages do not overlap.
    const first = await call(token).get(`${eventsUrl}?environment=test&limit=1`).expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.next_cursor).toBe(first.body.data[0].id);
    const second = await call(token)
      .get(`${eventsUrl}?environment=test&limit=1&cursor=${first.body.next_cursor}`)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id > first.body.data[0].id).toBe(true);

    // Deliveries paginate the same way.
    const page = await call(token)
      .get(`${endpointsUrl}/${endpoint.body.id}/deliveries?limit=1`)
      .expect(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.next_cursor).toBeTruthy();

    // Boundaries: limit 0 and 101 are 400; a non-UUID cursor is 400.
    for (const query of ['limit=0', 'limit=101', 'cursor=not-a-uuid']) {
      const response = await call(token).get(`${eventsUrl}?environment=test&${query}`);
      expect(response.status).toBe(400);
    }
  });

  // -------------------------------------------------------------------------
  // Event fan-out and delivery listing (D2/D4, §4.4)
  // -------------------------------------------------------------------------

  it('persists the event and fans out one delivery per matching endpoint in the same transaction', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl, customerId } = await setup('fanout');

    const subscribed = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/subscribed',
      event_types: ['payment.created'],
    }).expect(201);
    // Not subscribed → no delivery, though the event still exists.
    await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/other-type',
      event_types: ['refund.created'],
    }).expect(201);
    // Disabled → `enabled` gates fan-out only, so this one is never a match.
    const disabled = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/disabled',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .patch(`${endpointsUrl}/${disabled.body.id}`)
      .send({ enabled: false })
      .expect(200);
    // A different environment is never a match.
    await createEndpoint(token, projectId, {
      environment: 'live',
      url: 'https://example.com/live',
      event_types: ['payment.created'],
    }).expect(201);

    const before = await prisma.webhookEvent.count({ where: { projectId } });
    const payment = await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);

    // D2: the event is committed with the payment, in the same transaction.
    expect(await prisma.webhookEvent.count({ where: { projectId } })).toBe(before + 1);
    const event = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.type).toBe('payment.created');
    expect((event.payload as { data: { id: string } }).data.id).toBe(payment.body.id);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { eventId: event.id },
      include: { endpoint: true },
    });
    // Exactly one delivery, for the one enabled endpoint subscribed to the type.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpoint.url).toBe('https://example.com/subscribed');
    expect(deliveries[0]).toMatchObject({ status: 'pending', attempts: 0, isReplay: false });
    expect(deliveries[0].responseStatus).toBeNull();
    expect(deliveries[0].nextAttemptAt).not.toBeNull();

    // §4.4: the listing projects the aggregate, never a response body.
    const listed = await call(token)
      .get(`${endpointsUrl}/${subscribed.body.id}/deliveries?status=pending`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      endpoint_id: subscribed.body.id,
      event_id: event.id,
      status: 'pending',
      attempts: 0,
      response_status: null,
      last_error: null,
      is_replay: false,
    });
    const filtered = await call(token)
      .get(`${endpointsUrl}/${subscribed.body.id}/deliveries?status=delivered`)
      .expect(200);
    expect(filtered.body.data).toHaveLength(0);
  });

  it('lists events of the environment with the exact stored envelope and a type filter (D15)', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, eventsUrl } = await setup('events');

    const payment = await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    // Backdate the row so the whole schedule (1s pending + 2s settlement) is
    // due; the read-time catch-up then applies the edges through the CAS, and the
    // winner emits `payment.succeeded` exactly once (D3/F2).
    await prisma.payment.update({
      where: { id: payment.body.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await call(token).get(`/api/v1/projects/${projectId}/payments/${payment.body.id}`).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.body.id } })).status).toBe(
      'succeeded',
    );

    const all = await call(token).get(`${eventsUrl}?environment=test`).expect(200);
    const types = all.body.data.map((item: { type: string }) => item.type);
    expect(types).toContain('payment.created');
    expect(types).toContain('payment.succeeded');
    for (const event of all.body.data) {
      // F4: exactly the phase 1 §9.5 envelope — no request id, no internal ids.
      expect(Object.keys(event).sort()).toEqual([
        'created_at',
        'data',
        'environment',
        'id',
        'project_id',
        'type',
      ]);
      expect(event.environment).toBe('test');
      expect(event.project_id).toBe(projectId);
    }

    const createdOnly = await call(token)
      .get(`${eventsUrl}?environment=test&type=payment.created`)
      .expect(200);
    expect(createdOnly.body.data.every((item: { type: string }) => item.type === 'payment.created')).toBe(true);

    const invalid = await call(token).get(`${eventsUrl}?environment=test&type=customer.created`);
    expect(invalid.status).toBe(400);
  });

  it('a read and the advancement sweep racing the same payment emit exactly one payment.succeeded (AC3, D3/F2)', async () => {
    requireDependencies(available);
    const { token, projectId, customerId } = await setup('race');

    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/race',
      event_types: ['payment.succeeded'],
    }).expect(201);
    const payment = await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    // Backdate so both edges are immediately due, then advance from two drivers
    // at once. The payments CAS — not luck — is what keeps it to one event.
    await prisma.payment.update({
      where: { id: payment.body.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const payments = app.get(PaymentsService);
    await Promise.all([
      call(token).get(`/api/v1/projects/${projectId}/payments/${payment.body.id}`).expect(200),
      payments.advanceDuePayments(new Date()),
      call(token).get(`/api/v1/projects/${projectId}/payments/${payment.body.id}`).expect(200),
    ]);

    const succeeded = await prisma.webhookEvent.findMany({
      where: { projectId, type: 'payment.succeeded' },
    });
    expect(succeeded).toHaveLength(1);
    const deliveries = await prisma.webhookDelivery.findMany({ where: { eventId: succeeded[0].id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].endpointId).toBe(endpoint.body.id);
  });

  // -------------------------------------------------------------------------
  // Replay (D12, §5.6)
  // -------------------------------------------------------------------------

  it('replays an event to an endpoint: 202, a new delivery, no new event, repeatable', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl, customerId } = await setup('replay');

    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/replay',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);

    const event = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId, type: 'payment.created' },
      orderBy: { createdAt: 'desc' },
    });
    const original = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: event.id } });
    const url = `${endpointsUrl}/${endpoint.body.id}/events/${event.id}/replay`;

    const accepted = await call(token).post(url).expect(202);
    // 202 with no body.
    expect(accepted.body).toEqual({});

    const after = await prisma.webhookDelivery.findMany({ where: { eventId: event.id } });
    expect(after).toHaveLength(2);
    const replay = after.find((row) => row.isReplay);
    expect(replay).toBeDefined();
    // Same event, same envelope, new aggregate; the original is untouched.
    expect(replay!.eventId).toBe(original.eventId);
    expect(replay!.status).toBe('pending');
    expect(original.status).toBe('pending');
    expect(original.attempts).toBe(0);
    // A replay must never create a second event row.
    expect(await prisma.webhookEvent.count({ where: { projectId } })).toBe(1);

    // Replay is not idempotency-key protected: a second call is another delivery.
    await call(token).post(url).expect(202);
    expect(await prisma.webhookDelivery.count({ where: { eventId: event.id } })).toBe(3);
  });

  it('replay preconditions: 404 for an unknown/foreign event, 422 for disabled or unsubscribed', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl, customerId } = await setup('replay-pre');
    const other = await setup('replay-pre-other');
    // A second project with its own payment, so the foreign-event case is real.
    await call(other.token)
      .post(`/api/v1/projects/${other.projectId}/payments`)
      .send({ environment: 'test', customer_id: other.customerId, amount: '10.00', currency: 'usd' })
      .expect(201);

    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/pre',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    const own = await prisma.webhookEvent.findFirstOrThrow({ where: { projectId } });
    const foreignEvent = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId: other.projectId },
    });

    const replayOf = (eventId: string) =>
      call(token).post(`${endpointsUrl}/${endpoint.body.id}/events/${eventId}/replay`);

    expect((await replayOf('0198f0c2-0000-7000-8000-0000000000e2')).status).toBe(404);
    expect((await replayOf('not-a-uuid')).status).toBe(404);
    // D6 non-disclosure: a foreign event is a 404, never a 403.
    expect((await replayOf(foreignEvent.id)).status).toBe(404);

    await call(token)
      .patch(`${endpointsUrl}/${endpoint.body.id}`)
      .send({ enabled: false })
      .expect(200);
    const disabled = await replayOf(own.id);
    expect(disabled.status).toBe(422);
    expect(disabled.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    await call(token)
      .patch(`${endpointsUrl}/${endpoint.body.id}`)
      .send({ enabled: true, event_types: ['refund.created'] })
      .expect(200);
    const unsubscribed = await replayOf(own.id);
    expect(unsubscribed.status).toBe(422);
    // The message must not reveal the endpoint's configuration.
    expect(unsubscribed.body.error.message).not.toContain('event_types');
    expect(await prisma.webhookDelivery.count({ where: { isReplay: true } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Deletion (D11)
  // -------------------------------------------------------------------------

  it('deleting an endpoint cascades its deliveries and leaves the events replayable elsewhere', async () => {
    requireDependencies(available);
    const { token, projectId, endpointsUrl, customerId } = await setup('delete');

    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/doomed',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { projectId } });
    expect(await prisma.webhookDelivery.count({ where: { eventId: event.id } })).toBe(1);

    await call(token).delete(`${endpointsUrl}/${endpoint.body.id}`).expect(204);
    expect(await prisma.webhookEndpoint.count({ where: { id: endpoint.body.id } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { eventId: event.id } })).toBe(0);
    // D11: events survive their endpoints.
    expect(await prisma.webhookEvent.count({ where: { id: event.id } })).toBe(1);

    // A survivor endpoint can still receive the retained event.
    const survivor = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/survivor',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .post(`${endpointsUrl}/${survivor.body.id}/events/${event.id}/replay`)
      .expect(202);
    expect(await prisma.webhookDelivery.count({ where: { eventId: event.id } })).toBe(1);

    // A second delete is a 404, not an idempotent 204.
    await call(token).delete(`${endpointsUrl}/${endpoint.body.id}`).expect(404);
  });

  it('deleting the project cascades its endpoints, deliveries, and events (AC9, D11)', async () => {
    requireDependencies(available);
    const { token, organizationId, projectId, customerId } = await setup('project-delete');

    const endpoint = await createEndpoint(token, projectId, {
      environment: 'test',
      url: 'https://example.com/cascade',
      event_types: ['payment.created'],
    }).expect(201);
    await call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);
    expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.body.id } })).toBe(1);

    await call(token).delete(`/api/v1/projects/${projectId}`).expect(204);

    // One cascade removes the whole webhook surface; no orphan survives it.
    expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { projectId } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.body.id } })).toBe(0);
    // The project's payments and customers cascade with it.
    expect(await prisma.payment.count({ where: { projectId } })).toBe(0);
    expect(await prisma.customer.count({ where: { projectId } })).toBe(0);
    // The organization outlives the project; remove it so the fixture stays tidy.
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  });
});
