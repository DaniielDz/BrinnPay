import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { WebhookMaintenanceService } from '../src/webhooks/webhook-maintenance.service';
import { WebhooksWorkerModule } from '../src/webhooks/webhooks-worker.module';

/**
 * Phase 10 retention e2e (AC12, D9).
 *
 * The cleanup pass is bounded and global: it deletes every event older than the
 * retention window, which cascades its delivery rows. This suite proves the two
 * halves of that behavior against real PostgreSQL and a real worker: an expired
 * event (and its deliveries) is gone from the database and the API — listing
 * omits it and replay is a 404 — while a fresh event of the same project is left
 * untouched.
 *
 * The default retention window is 30 days; the test backdates one event well past
 * it rather than shrinking the window, so no environment override is needed and
 * nothing can leak into other spec files.
 */
const stamp = Date.now().toString(36);
const password = 'password-123';
const RETENTION_DAYS = 30;

jest.setTimeout(60_000);

describe('webhook retention (Phase 10, real PostgreSQL + worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let destination: Server;
  let baseUrl: string;
  let available = false;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
    prisma = app.get(PrismaService);

    try {
      await prisma.ping();
      await app.get(RedisService).ping();
      await prisma.webhookEvent.count();

      // A local destination so deliveries settle without any outbound request.
      destination = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;

      const workerRef = await Test.createTestingModule({ imports: [WebhooksWorkerModule] }).compile();
      worker = await workerRef.init();

      available = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (app) await app.close();
    if (destination) await new Promise<void>((resolve) => destination.close(() => resolve()));
  });

  afterEach(async () => {
    if (!available) return;
    const projects = await prisma.project.findMany({
      where: { organization: { name: { startsWith: 'whr-', endsWith: `-${stamp}` } } },
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
      where: { email: { startsWith: 'whr-', endsWith: `-${stamp}@example.com` } },
    });
  });

  const call = (token: string) =>
    request.agent(app.getHttpServer()).use((req: request.Request) =>
      req.set('Authorization', `Bearer ${token}`),
    );

  async function setup(name: string) {
    const email = `whr-${name}-${stamp}@example.com`;
    const registration = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: `Webhook Retention ${name}` })
      .expect(201);
    const token = registration.body.access_token as string;
    const org = await call(token)
      .post('/api/v1/organizations')
      .send({ name: `whr-${name}-${stamp}` })
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

  it('drops events past retention (with their deliveries) and makes their replay a 404 (AC12, D9)', async () => {
    if (!available) return;
    const { token, projectId, customerId, endpointsUrl } = await setup('expiry');

    const endpoint = await call(token)
      .post(endpointsUrl)
      .send({ environment: 'test', url: `${baseUrl}/retention`, event_types: ['payment.created'] })
      .expect(201);

    // Event A will be pushed past the window; event B stays fresh.
    await createPayment(token, projectId, customerId);
    const old = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    await prisma.webhookEvent.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - (RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000) },
    });
    await createPayment(token, projectId, customerId);
    const fresh = await prisma.webhookEvent.findFirstOrThrow({
      where: { projectId, id: { not: old.id } },
      orderBy: { createdAt: 'desc' },
    });
    expect(await prisma.webhookDelivery.count({ where: { eventId: old.id } })).toBeGreaterThanOrEqual(1);

    const removed = await worker.get(WebhookMaintenanceService).cleanupExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    // The expired event and its deliveries are gone; the fresh one is untouched.
    expect(await prisma.webhookEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.webhookDelivery.count({ where: { eventId: old.id } })).toBe(0);
    expect(await prisma.webhookEvent.findUnique({ where: { id: fresh.id } })).not.toBeNull();

    // It vanishes from listings, and its replay is a 404.
    const events = await call(token)
      .get(`/api/v1/projects/${projectId}/webhook-events?environment=test`)
      .expect(200);
    const ids = events.body.data.map((row: { id: string }) => row.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(fresh.id);
    await call(token)
      .post(`${endpointsUrl}/${endpoint.body.id}/events/${old.id}/replay`)
      .expect(404);
  });
});
