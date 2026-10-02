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
import { WEBHOOK_JOBS, WEBHOOK_QUEUE_NAME } from '../src/webhooks/webhook-queue';
import { parseRedisUrl, REQUEUE_GRACE_MS } from '../src/webhooks/webhook-queue.service';
import { WebhookMaintenanceService } from '../src/webhooks/webhook-maintenance.service';
import { WebhooksWorkerModule } from '../src/webhooks/webhooks-worker.module';

/**
 * Phase 10 delivery failure-mode e2e (§9.5/§9.6, §10, D5/D6).
 *
 * The classification and the schedule are unit-tested as pure functions; this is
 * the layer that proves the *worker* honors them end to end: the failure is
 * recorded on the aggregate, the retry is re-queued with the ladder's delay, and
 * the final attempt settles the row as `delivered` or `failed`.
 *
 * The retry ladder is made deterministic by shrinking the policy through the
 * environment **before** the application context is built (D5 is env-driven,
 * §10). The values are restored afterwards so a run of another spec file in the
 * same process is not affected.
 */
const stamp = Date.now().toString(36);
const password = 'password-123';
const SETTLE_TIMEOUT_MS = 20_000;

jest.setTimeout(60_000);

/** Env the test owns and restores, so the fast ladder cannot leak to other files. */
const POLICY_ENV = {
  WEBHOOK_MAX_ATTEMPTS: '5',
  WEBHOOK_BASE_BACKOFF_MS: '20',
  WEBHOOK_MAX_BACKOFF_MS: '120',
  WEBHOOK_CONNECT_TIMEOUT_MS: '300',
  WEBHOOK_REQUEST_TIMEOUT_MS: '400',
} as const;

describe('webhook failure modes (Phase 10, real PostgreSQL + Redis + worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let destination: Server;
  let baseUrl: string;
  let queue: Queue;
  let available = false;
  let savedEnv: Record<string, string | undefined> = {};

  interface Received {
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }
  const received: Received[] = [];

  /** Per-path responder; the default is a 200. */
  const responders = new Map<string, (res: ServerResponse) => void>();
  /** Per-path attempt counter, so a responder can fail first and succeed later. */
  const attemptCounts = new Map<string, number>();

  const attemptsFor = (path: string): number => {
    const next = (attemptCounts.get(path) ?? 0) + 1;
    attemptCounts.set(path, next);
    return next;
  };

  beforeAll(async () => {
    savedEnv = Object.fromEntries(Object.keys(POLICY_ENV).map((key) => [key, process.env[key]]));
    Object.assign(process.env, POLICY_ENV);

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

      const workerRef = await Test.createTestingModule({ imports: [WebhooksWorkerModule] }).compile();
      worker = await workerRef.init();

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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    received.length = 0;
    responders.clear();
    attemptCounts.clear();
    if (!available) return;
    await queue.resume();
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'whf-', endsWith: `-${stamp}` } } },
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
      where: { email: { startsWith: 'whf-', endsWith: `-${stamp}@example.com` } },
    });
  });

  const call = (token: string) =>
    request.agent(app.getHttpServer()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${token}`),
    );

  async function setup(name: string) {
    const email = `whf-${name}-${stamp}@example.com`;
    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Webhook Failure ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `whf-${name}-${stamp}` })
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

  const subscribe = (token: string, endpointsUrl: string, path: string) =>
    call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}${path}`, event_types: ['payment.created'] })
      .expect(201);

  async function waitFor<T>(check: () => Promise<T | null | undefined | false>, what: string) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const deliveryFor = (endpointId: string) =>
    prisma.webhookDelivery.findFirst({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
    });

  it('runs the full retry ladder: fail, fail, succeed — same bytes, incrementing attempt header (D5)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('ladder');

    responders.set('/ladder', (res) => {
      if (attemptsFor('/ladder') < 3) {
        res.writeHead(500);
        res.end('nope');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    const endpoint = await subscribe(token, endpointsUrl, '/ladder');
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'delivered' ? row : null;
    }, 'the ladder to reach a delivered attempt');

    expect(delivery.attempts).toBe(3);
    expect(delivery.responseStatus).toBe(200);
    expect(delivery.nextAttemptAt).toBeNull();

    const attempts = received.filter((item) => item.url === '/ladder');
    expect(attempts).toHaveLength(3);
    // The attempt number is part of the contract and climbs with each try.
    expect(attempts.map((item) => item.headers['brinnpay-attempt'])).toEqual(['1', '2', '3']);
    // The body is serialized once and replayed: a retry is byte-identical.
    expect(attempts[1].rawBody).toBe(attempts[0].rawBody);
    expect(attempts[2].rawBody).toBe(attempts[0].rawBody);
  });

  it('honors Retry-After on a 429, clamped, and still delivers (D6)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('retry-after');

    responders.set('/retry-after', (res) => {
      if (attemptsFor('/retry-after') === 1) {
        // A huge Retry-After must be clamped to maxBackoffMs (120ms here).
        res.writeHead(429, { 'Retry-After': '3600' });
        res.end('slow down');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    const endpoint = await subscribe(token, endpointsUrl, '/retry-after');
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'delivered' ? row : null;
    }, 'the 429 to be retried and then delivered');

    expect(delivery.attempts).toBe(2);
    expect(delivery.responseStatus).toBe(200);
    // The first attempt recorded the 429, never a retry loop.
    expect(received.filter((item) => item.url === '/retry-after')).toHaveLength(2);
  });

  it('does not retry a 404: one attempt, terminal failed, schedule cleared (D6)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('not-found');

    responders.set('/missing', (res) => {
      res.writeHead(404);
      res.end('gone');
    });

    const endpoint = await subscribe(token, endpointsUrl, '/missing');
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'failed' ? row : null;
    }, 'the 404 to settle as failed');

    expect(delivery.attempts).toBe(1);
    expect(delivery.responseStatus).toBe(404);
    expect(delivery.nextAttemptAt).toBeNull();
    // A non-retryable status is contacted exactly once.
    expect(received.filter((item) => item.url === '/missing')).toHaveLength(1);
  });

  it('times out a hung destination, then redelivers after the timeout (D5/§5.4)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('timeout');

    responders.set('/slow', (res) => {
      if (attemptsFor('/slow') === 1) {
        // Never respond: the worker's request timeout has to fire.
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });

    const endpoint = await subscribe(token, endpointsUrl, '/slow');
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'delivered' ? row : null;
    }, 'the timeout to be retried and then delivered');

    expect(delivery.attempts).toBe(2);
    expect(received.filter((item) => item.url === '/slow')).toHaveLength(2);
  });

  it('persists the event when the enqueue is lost and reconciliation re-queues it (AC8, D2)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('reconcile');

    const endpoint = await subscribe(token, endpointsUrl, '/reconciled');

    // The delivery is queued and sitting in `wait`; pausing the consumer is what
    // makes "the enqueue never happened" observable and deterministic (the real
    // Redis outage is the same state from the worker's point of view).
    await queue.pause();
    const payment = await createPayment(token, projectId, customerId);
    expect(payment.status).toBe(201);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'pending' && row.attempts === 0 ? row : null;
    }, 'the delivery row to be persisted before any attempt');

    // The safety net is exactly for this: the job is gone, the durable rows are
    // not. Dropping only this delivery's job keeps the repeat schedulers intact.
    const queued = await queue.getJobs(['wait', 'delayed'], 0, -1);
    for (const job of queued) {
      if (job.name === WEBHOOK_JOBS.DELIVER && job.data?.delivery_id === delivery.id) {
        await job.remove();
      }
    }
    expect(
      (await queue.getJobs(['wait', 'delayed'], 0, -1)).filter(
        (job) => job.name === WEBHOOK_JOBS.DELIVER && job.data?.delivery_id === delivery.id,
      ),
    ).toHaveLength(0);

    // Immediately after the fan-out the row is *not* yet eligible: it looks
    // identical to a healthy job waiting in `wait`, so the pass must leave it
    // alone (REQUEUE_GRACE_MS, webhook-queue.service.ts). A pass that duplicated
    // it here would send a second request for one row on every single pass.
    const early = await worker.get(WebhookMaintenanceService).reconcile();
    expect(early.requeued).toBe(0);
    expect(
      (await queue.getJobs(['wait', 'delayed'], 0, -1)).filter(
        (job) => job.name === WEBHOOK_JOBS.DELIVER && job.data?.delivery_id === delivery.id,
      ),
    ).toHaveLength(0);

    // Age the schedule past the grace window. In production this is just time
    // passing between one pass and the next; backdating the column says the same
    // thing without a 15 s sleep in the suite.
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(Date.now() - REQUEUE_GRACE_MS - 1_000) },
    });

    // Reconciliation re-queues the pending, due delivery the lost enqueue stranded.
    const result = await worker.get(WebhookMaintenanceService).reconcile();
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    await queue.resume();
    const delivered = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'delivered' ? row : null;
    }, 'the reconciled delivery to be delivered');
    expect(delivered.attempts).toBe(1);
    expect(received.some((item) => item.url === '/reconciled')).toBe(true);
  });

  it('recovers a stranded delivery whose event is older than the reconciliation horizon (AC8, D2)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('beyond-horizon');

    responders.set('/beyond-horizon', (res) => {
      res.writeHead(200);
      res.end('ok');
    });

    const endpoint = await subscribe(token, endpointsUrl, '/beyond-horizon');

    await queue.pause();
    await createPayment(token, projectId, customerId);

    const delivery = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'pending' && row.attempts === 0 ? row : null;
    }, 'the delivery row to be persisted before any attempt');

    const eventId = await prisma.webhookDelivery
      .findUniqueOrThrow({ where: { id: delivery.id }, select: { eventId: true } })
      .then((row) => row.eventId);

    // Strand it the same way as above, then push the event's age past the
    // reconciliation horizon. The horizon deliberately bounds the *fan-out*
    // scan — it stops a pass from backfilling 30 days of events for a freshly
    // enabled endpoint — but a delivery that already exists is not a backfill
    // candidate, and refusing to re-queue it would strand real money-path
    // deliveries forever. `requeueDueDeliveries` therefore carries no age bound;
    // this test is the guard that keeps it that way.
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const queued = await queue.getJobs(['wait', 'delayed'], 0, -1);
    for (const job of queued) {
      if (job.name === WEBHOOK_JOBS.DELIVER && job.data?.delivery_id === delivery.id) {
        await job.remove();
      }
    }

    // Past the grace window, so the row is eligible on its `next_attempt_at`.
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(Date.now() - REQUEUE_GRACE_MS - 1_000) },
    });

    const result = await worker.get(WebhookMaintenanceService).reconcile();
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    await queue.resume();
    const delivered = await waitFor(async () => {
      const row = await deliveryFor(endpoint.body.id as string);
      return row && row.status === 'delivered' ? row : null;
    }, 'the delivery past the horizon to be delivered');
    expect(delivered.attempts).toBe(1);
    expect(received.some((item) => item.url === '/beyond-horizon')).toBe(true);
  });
});
