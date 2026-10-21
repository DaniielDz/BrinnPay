import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { WEBHOOK_QUEUE_NAME } from '../src/webhooks/webhook-queue';
import { parseRedisUrl } from '../src/webhooks/webhook-queue.service';
import { WebhooksWorkerModule } from '../src/webhooks/webhooks-worker.module';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 10 delivery e2e (§9, D3/D7/D11/D14): the **real** pipeline — API process
 * and a real worker application context over the same PostgreSQL, Redis, and
 * BullMQ queue — delivering to a real HTTP destination.
 *
 * This is the only layer where the signature, the headers, the envelope, the
 * retry bookkeeping, and the queue-driven payment advancement are exercised
 * together. D13 permits loopback destinations by default, which is what the
 * throwaway destination below relies on.
 *
 * The maintenance repeatables run on their configured intervals (5s advancement
 * sweep by default), so the assertions poll with a generous timeout instead of
 * sleeping a fixed amount.
 */
const stamp = Date.now().toString(36);
const password = 'password-123';
const SETTLE_TIMEOUT_MS = 20_000;

/**
 * These assertions wait on the real queue, so the 5s default is not enough:
 * the consumer polls, and the advancement sweep runs on its own 5s interval.
 */
jest.setTimeout(60_000);

describe('webhook delivery (Phase 10, real PostgreSQL + Redis + worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let destination: Server;
  let baseUrl: string;
  let queue: Queue;
  let available = false;

  /** One recorded inbound delivery attempt. */
  interface Received {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }
  const received: Received[] = [];

  /** Per-path response, so one test can fail a delivery on purpose. */
  const responders = new Map<string, (res: ServerResponse) => void>();

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

      destination = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            rawBody: Buffer.concat(chunks).toString('utf8'),
          });
          const respond = responders.get(req.url ?? '');
          if (respond) {
            respond(res);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;

      // The real worker: consumer + the three repeatable maintenance passes.
      // An application context, not an application: no HTTP surface is booted,
      // exactly like `src/worker.ts` in production (D14).
      const workerRef = await Test.createTestingModule({ imports: [WebhooksWorkerModule] }).compile();
      worker = await workerRef.init();

      // The queue is process-wide Redis state: a run that was killed mid-test
      // can leave it paused, which would stall every assertion below.
      // `resume()` only; never `drain()`. Draining removes the *waiting* jobs
      // too, and a job-scheduler tick that has already been promoted from
      // `delayed` into `wait` is a waiting job — killing it breaks that
      // repeat chain for good, and the advancement sweep (a 5s scheduler) then
      // never ticks again.
      queue = new Queue(WEBHOOK_QUEUE_NAME, {
        connection: parseRedisUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      });
      await queue.resume();

      available = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (queue) {
      await queue.resume();
      await queue.close();
    }
    if (app) await app.close();
    if (destination) await new Promise<void>((resolve) => destination.close(() => resolve()));
  });

  afterEach(async () => {
    received.length = 0;
    responders.clear();
    requireDependencies(available);
    // A failed test must never be able to leave the shared queue paused.
    await queue.resume();
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'whd-', endsWith: `-${stamp}` } } },
      select: { id: true, organizationId: true },
    });
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      await prisma.webhookDelivery.deleteMany({ where: { endpoint: { projectId: { in: projectIds } } } });
      await prisma.webhookEndpoint.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.webhookEvent.deleteMany({ where: { projectId: { in: projectIds } } });
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
      where: { email: { startsWith: 'whd-', endsWith: `-${stamp}@example.com` } },
    });
  });

  const call = (token: string) =>
    request.agent(app.getHttpServer()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${token}`),
    );

  async function setup(name: string) {
    const email = `whd-${name}-${stamp}@example.com`;
    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Webhook Delivery ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `whd-${name}-${stamp}` })
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
      projectId: project.body.id as string,
      customerId: customer.body.id as string,
      endpointsUrl: `/api/v1/projects/${project.body.id}/webhook-endpoints`,
    };
  }

  const createPayment = (token: string, projectId: string, customerId: string) =>
    call(token)
      .post(`/api/v1/projects/${projectId}/payments`)
      .send({ environment: 'test', customer_id: customerId, amount: '10.00', currency: 'usd' })
      .expect(201);

  /** Polls until `check` is truthy or the timeout elapses. */
  async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const result = await check();
      if (result) {
        return result;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it('delivers a signed request the destination can verify, and records it as delivered', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('deliver');

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({
        environment: 'test',
        url: `${baseUrl}/hook`,
        event_types: ['payment.created'],
      })
      .expect(201);
    const secret = endpoint.body.signing_secret as string;

    const payment = await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'desc' },
      });
      return row && row.status === 'delivered' ? row : null;
    }, 'the delivery to be marked delivered');

    expect(delivery).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200 });
    expect(delivery.lastError).toBeNull();
    expect(delivery.nextAttemptAt).toBeNull();

    const attempt = received.find((item) => item.url === '/hook');
    expect(attempt).toBeDefined();
    expect(attempt!.method).toBe('POST');

    // The transmitted bytes are exactly the stored envelope.
    const body = JSON.parse(attempt!.rawBody);
    expect(body).toMatchObject({
      type: 'payment.created',
      environment: 'test',
      project_id: projectId,
      data: { id: payment.body.id },
    });
    expect(Object.keys(body).sort()).toEqual([
      'created_at',
      'data',
      'environment',
      'id',
      'project_id',
      'type',
    ]);

    // D7: the contracted headers, and a signature a destination can verify.
    expect(attempt!.headers['content-type']).toBe('application/json');
    expect(attempt!.headers['brinnpay-event-id']).toBe(body.id);
    expect(attempt!.headers['brinnpay-event-type']).toBe('payment.created');
    expect(attempt!.headers['brinnpay-delivery-id']).toBe(delivery.id);
    expect(attempt!.headers['brinnpay-attempt']).toBe('1');

    const signature = String(attempt!.headers['brinnpay-signature']);
    expect(signature).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    const [, provided] = signature.split(',v1=');
    const timestamp = signature.slice(2, signature.indexOf(','));
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${attempt!.rawBody}`, 'utf8')
      .digest();
    // Constant-time comparison, exactly as a consumer must do it.
    expect(timingSafeEqual(Buffer.from(provided, 'hex'), expected)).toBe(true);
  });

  it('records a failing destination as a retry with a bounded backoff and no stored body', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('retry');

    responders.set('/boom', (res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html>leaked response body</html>');
    });

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/boom`, event_types: ['payment.created'] })
      .expect(201);
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'desc' },
      });
      return row && row.attempts >= 1 ? row : null;
    }, 'the failed attempt to be recorded');

    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.responseStatus).toBe(500);
    // A bounded, sanitized summary — never the destination's response body.
    expect(delivery.lastError).toContain('500');
    expect(delivery.lastError).not.toContain('leaked response body');
    expect(delivery.lastError!.length).toBeLessThanOrEqual(500);
    // D5: the next attempt is scheduled, not immediate.
    const delayMs = (delivery.nextAttemptAt?.getTime() ?? 0) - Date.now();
    expect(delayMs).toBeGreaterThan(0);
    expect(delayMs).toBeLessThanOrEqual(30_000);
  });

  it('never follows a redirect and records the 3xx as a terminal failure', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('redirect');

    responders.set('/redirect', (res) => {
      res.writeHead(302, { Location: '/followed' });
      res.end();
    });

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/redirect`, event_types: ['payment.created'] })
      .expect(201);
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'desc' },
      });
      return row && row.status !== 'pending' ? row : null;
    }, 'the redirect to be recorded');

    expect(delivery.status).toBe('failed');
    expect(delivery.responseStatus).toBe(302);
    expect(delivery.nextAttemptAt).toBeNull();
    // The redirect target was never contacted.
    expect(received.filter((item) => item.url === '/followed')).toHaveLength(0);
  });

  it('the advancement sweep delivers payment.succeeded without anybody reading the payment (D3/F2)', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('sweep');

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/sweep`, event_types: ['payment.succeeded'] })
      .expect(201);

    const payment = await createPayment(token, projectId, customerId);
    // Backdate the row so the whole schedule is due; no read follows.
    await prisma.payment.update({
      where: { id: payment.body.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'desc' },
      });
      return row && row.status === 'delivered' ? row : null;
    }, 'the sweep to emit and deliver payment.succeeded');

    const attempt = received.find((item) => item.url === '/sweep');
    expect(attempt).toBeDefined();
    expect(attempt!.headers['brinnpay-event-type']).toBe('payment.succeeded');
    expect(JSON.parse(attempt!.rawBody).data).toMatchObject({ id: payment.body.id, status: 'succeeded' });
  });

  it('a disabled endpoint still runs a queued delivery, and a deleted one is a no-op (D11)', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('enabled');

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/queued`, event_types: ['payment.created'] })
      .expect(201);
    const deleted = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/deleted`, event_types: ['payment.created'] })
      .expect(201);

    // Pausing the queue is what makes the ordering deterministic: the delivery
    // jobs are produced and sitting in `wait`, untouched by the worker, while
    // the endpoint flags change underneath them.
    // `afterEach` resumes the queue even if an assertion below throws, so a
    // failure here can never leave the shared queue paused for the next run.
    await queue.pause();

    const payment = await createPayment(token, projectId, customerId);
    const endpointIds = [endpoint.body.id as string, deleted.body.id as string];
    // Both deliveries exist and neither has been attempted: that is precisely the
    // "already queued" state D11 is about, and it is what the pause buys us.
    await waitFor(async () => {
      const rows = await prisma.webhookDelivery.findMany({
        where: { endpointId: { in: endpointIds } },
      });
      return rows.length === 2 && rows.every((row) => row.status === 'pending' && row.attempts === 0);
    }, 'both deliveries to be queued and unattempted');

    await call(token)
      .patch(`${endpointsUrl}/${endpoint.body.id}`)
      .send({ enabled: false })
      .expect(200);
    await call(token).delete(`${endpointsUrl}/${deleted.body.id}`).expect(204);

    // Let the worker drain the paused work.
    await queue.resume();

    const queued = await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'desc' },
      });
      return row && row.status === 'delivered' ? row : null;
    }, 'the queued delivery of a disabled endpoint to run');

    expect(queued.endpointId).toBe(endpoint.body.id);
    expect(queued.status).toBe('delivered');
    expect(received.some((item) => item.url === '/queued')).toBe(true);
    // The deleted endpoint's delivery cascaded away; the job it left behind is a
    // no-op rather than a 404 or a crash.
    expect(received.some((item) => item.url === '/deleted')).toBe(false);
    expect(payment.body.id).toBeTruthy();
  });

  it('C6 composed: register → payment → verified delivery → replay → second verified delivery', async () => {
    requireDependencies(available);
    const { token, projectId, customerId, endpointsUrl } = await setup('c6');

    // Registration: the signing secret is shown exactly once, at creation.
    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({
        environment: 'test',
        url: `${baseUrl}/c6`,
        event_types: ['payment.created'],
      })
      .expect(201);
    const secret = endpoint.body.signing_secret as string;
    expect(secret).toBeTruthy();
    expect(
      (
        (await call(token).get(`${endpointsUrl}?environment=test`).expect(200)).body.data as Array<
          Record<string, unknown>
        >
      ).some((entry) => entry.id === endpoint.body.id && !('signing_secret' in entry)),
    ).toBe(true);

    // Payment → event row persisted with the payment, fan-out queued.
    await createPayment(token, projectId, customerId);
    const first = await waitFor(async () => {
      const row = await prisma.webhookDelivery.findFirst({
        where: { endpointId: endpoint.body.id as string },
      });
      return row && row.status === 'delivered' ? row : null;
    }, 'the worker to deliver the original event');

    const event = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId, type: 'payment.created' },
    });

    // Replay is accepted (202) and the worker delivers it as a second attempt.
    await call(token)
      .post(
        `/api/v1/projects/${projectId}/webhook-endpoints/${endpoint.body.id}/events/${event.id}/replay`,
      )
      .expect(202);
    const rows = await waitFor(async () => {
      const found = await prisma.webhookDelivery.findMany({
        where: { endpointId: endpoint.body.id as string },
        orderBy: { createdAt: 'asc' },
      });
      const replayed = found.find((row) => row.isReplay);
      return found.length === 2 && replayed && replayed.status === 'delivered' ? found : null;
    }, 'the worker to deliver the replayed delivery');
    expect(rows.filter((row) => row.status === 'delivered')).toHaveLength(2);

    // A replay never mints a second event row (webhooks.e2e asserts the row
    // count too; asserted here because the composed flow is where drift in the
    // lifecycle would surface).
    expect(
      await prisma.webhookEvent.count({ where: { projectId, type: 'payment.created' } }),
    ).toBe(1);
    expect(first.status).toBe('delivered');

    // The receiver saw exactly two attempts, both signatures verifiable with
    // the endpoint secret (constant-time), same event id, distinct delivery ids.
    const attempts = received.filter((item) => item.url === '/c6');
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      const signature = String(attempt.headers['brinnpay-signature']);
      expect(signature).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
      const timestamp = signature.slice(2, signature.indexOf(','));
      const provided = signature.split(',v1=')[1];
      const expected = createHmac('sha256', secret)
        .update(`${timestamp}.${attempt.rawBody}`, 'utf8')
        .digest();
      expect(timingSafeEqual(Buffer.from(provided, 'hex'), expected)).toBe(true);
      expect(attempt.headers['brinnpay-event-id']).toBe(event.id);
    }
    expect(new Set(attempts.map((item) => item.headers['brinnpay-delivery-id'])).size).toBe(2);
  });
});
