import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { configureApp } from '../src/bootstrap';
import { setupSwagger } from '../src/openapi/swagger';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 20 e2e for the metrics surface (AC1/AC4/AC7/AC8): supertest against
 * the real application with real PostgreSQL/Redis.
 *
 * This is the layer where the exposition is proven end-to-end: the endpoint's
 * placement (outside `/api/v1`, out of OpenAPI), its exclusions (rate
 * limiting, request logs — the same classification health endpoints carry),
 * the closed catalog under live traffic, the induced-500 spike AC4 demands,
 * the D4 token gate, and the label-policy adversarial corpus (AC7) that no
 * unit double can carry through the full middleware stack.
 */
jest.setTimeout(120_000);

const METRICS_PATH = '/metrics';

/** Catalog metric names the exposition must expose after activity (§6 M1). */
const CATALOG = [
  'brinnpay_http_requests_total',
  'brinnpay_http_request_duration_seconds',
  'brinnpay_http_requests_in_flight',
  'brinnpay_rate_limit_throttled_requests_total',
  'brinnpay_rate_limit_window_exhaustion_total',
  'brinnpay_rate_limit_degraded',
  'brinnpay_rate_limit_degraded_episodes_total',
  'brinnpay_request_log_writes_total',
  'brinnpay_request_log_write_failures_total',
];

/** Default process metrics M1 requires (memory/event loop/start time). */
const PROCESS_DEFAULTS = [
  'process_resident_memory_bytes',
  'nodejs_eventloop_lag_seconds',
  'process_start_time_seconds',
];

describe('metrics exposition (Phase 20, real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reachable = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    setupSwagger(app, app.get(ConfigService));
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

  it('serves the Prometheus exposition with the closed catalog and default process metrics (AC1)', async () => {
    requireDependencies(reachable);
    // Real /api/v1 traffic first, so HTTP series have samples.
    await request(app.getHttpServer()).get('/api/v1/projects').expect(401);
    await request(app.getHttpServer()).get('/api/v1/not-a-real-route').expect(404);

    const response = await request(app.getHttpServer()).get(METRICS_PATH).expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    for (const metric of CATALOG) {
      expect(response.text).toContain(`# HELP ${metric}`);
    }
    for (const metric of PROCESS_DEFAULTS) {
      expect(response.text).toContain(metric);
    }
    // Live HTTP series: an unauthenticated read still produced a 4xx sample
    // (matched route or `unmatched` — never a raw path).
    expect(response.text).toMatch(/brinnpay_http_requests_total\{[^}]*status_class="4xx"/);
  });

  it('is excluded from rate limiting: a scrape is never throttled and never spends budget (AC7/§5)', async () => {
    requireDependencies(reachable);
    // Scrape repeatedly — none of these may 429 or shift any API budget.
    for (let index = 0; index < 5; index += 1) {
      await request(app.getHttpServer()).get(METRICS_PATH).expect(200);
    }
    // The API surface still answers normally afterwards.
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });

  it('is excluded from request-log persistence, mirroring the health classification (AC8/§5)', async () => {
    requireDependencies(reachable);
    await request(app.getHttpServer()).get(METRICS_PATH).expect(200);

    const rows = await prisma.requestLog.findMany({
      where: { path: METRICS_PATH },
      select: { id: true },
      take: 5,
    });
    expect(rows).toHaveLength(0);
  });

  it('never appears in the OpenAPI contract or Swagger UI (AC8)', async () => {
    requireDependencies(reachable);
    const document = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const serialized = JSON.stringify(document.body);
    expect(serialized).not.toContain(METRICS_PATH);

    const ui = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(ui.text).not.toContain(METRICS_PATH);
  });

  it('spikes the 5xx and unhandled-exception signals under an induced failure, by route template (AC4)', async () => {
    requireDependencies(reachable);
    // A real route, a real controller, and a service that fails like production
    // does: a plain (non-HttpException) error from the handler. That is the
    // exact path ApiExceptionFilter classifies as "unhandled" — no guard
    // tricks, no contract change.
    const failing = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthService)
      .useValue({
        login: () => Promise.reject(new Error('e2e induced failure')),
      })
      .compile();
    const failingApp = failing.createNestApplication();
    configureApp(failingApp, failingApp.get(ConfigService));
    await failingApp.init();

    try {
      const response = await request(failingApp.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'phase20@example.test', password: 'induced-failure' })
        .expect(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.request_id).toMatch(/^req_/);

      const body = await request(failingApp.getHttpServer()).get(METRICS_PATH).expect(200);
      // The unhandled exception is counted at the filter boundary, by template…
      expect(body.text).toContain('brinnpay_http_unhandled_exceptions_total{route="/auth/login"}');
      // …and the 5xx is visible in the HTTP request series by template.
      expect(body.text).toContain(
        'brinnpay_http_requests_total{route="/auth/login",method="POST",status_class="5xx"}',
      );
      // No stack, no message, no internals leaked into the exposition.
      expect(body.text).not.toContain('e2e induced failure');
      expect(body.text).not.toContain('at Object');
    } finally {
      await failingApp.close();
    }
  });

  it('keeps adversarial paths and methods out of the label space (AC7, cardinality bound)', async () => {
    requireDependencies(reachable);
    // Attacker-shaped URLs: raw UUIDs on a *matched* route, encoded traversal,
    // query strings, secret-shaped tokens. None may become a route label.
    const adversarial = [
      '/api/v1/projects/0192f2a0-0000-7000-8000-000000000004',
      '/api/v1/customers/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/api/v1/customers?email=leak@example.com',
      '/api/v1/customers/eyJhbGciOiJIUzI1NiJ9.e30.signature',
    ];
    for (const path of adversarial) {
      await request(app.getHttpServer()).get(path);
    }

    const body = (await request(app.getHttpServer()).get(METRICS_PATH).expect(200)).text;
    expect(body).not.toContain('0192f2a0-0000-7000-8000-000000000004');
    expect(body).not.toContain('leak@example.com');
    expect(body).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(body).not.toContain('%2e%2e');
    // The matched route collapsed to its template; the misses to `unmatched`.
    expect(body).toContain('route="/projects/:project_id"');
    expect(body).toContain('route="unmatched"');
  });
});

describe('metrics endpoint with a scrape token (Phase 20 D4(a))', () => {
  let app: INestApplication;
  const TOKEN = 't'.repeat(48);
  const OVERRIDES: Record<string, string> = { METRICS_SCRAPE_TOKEN: TOKEN };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of Object.keys(OVERRIDES)) {
      saved[key] = process.env[key];
      process.env[key] = OVERRIDES[key];
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    for (const key of Object.keys(OVERRIDES)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('rejects an unauthenticated scrape with 401 and never echoes the token (AC7)', async () => {
    const response = await request(app.getHttpServer()).get(METRICS_PATH).expect(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(JSON.stringify(response.body ?? {})).not.toContain(TOKEN);
  });

  it('accepts the configured bearer token and still refuses a wrong one', async () => {
    await request(app.getHttpServer())
      .get(METRICS_PATH)
      .set('Authorization', `Bearer ${'x'.repeat(48)}`)
      .expect(401);

    const response = await request(app.getHttpServer())
      .get(METRICS_PATH)
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(response.text).toContain('brinnpay_http_requests_total');
    expect(response.text).not.toContain(TOKEN);
  });

  it('leaves business traffic unaffected by the token (passive instrumentation, §4 rule 5)', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/v1/projects').expect(401);
  });
});

describe('metrics endpoint when disabled (Phase 20 D4(a)/D7(a))', () => {
  let app: INestApplication;
  const saved = process.env.METRICS_ENABLED;

  beforeAll(async () => {
    process.env.METRICS_ENABLED = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (saved === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = saved;
  });

  it('answers 404 on the exposition path while health stays up (D7(a))', async () => {
    await request(app.getHttpServer()).get(METRICS_PATH).expect(404);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready');
  });
});
