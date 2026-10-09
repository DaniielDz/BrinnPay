import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { setupSwagger } from '../src/openapi/swagger';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { loadContractDocument } from './support/conformance';

/**
 * Phase 2 e2e (D2): supertest against the running Nest application with real
 * PostgreSQL/Redis. CI provides the dependencies as service containers (D8);
 * locally the suites that need them skip when they are unreachable.
 */
describe('BrinnPay API (e2e)', () => {
  let app: INestApplication;
  const dependenciesReachable = { value: false };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    setupSwagger(app, app.get(ConfigService));
    await app.init();

    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    try {
      await prisma.ping();
      await redis.ping();
      dependenciesReachable.value = true;
    } catch {
      // Dependencies are unavailable (local run without docker compose).
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live is unauthenticated and reports ok', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200).expect({ status: 'ok' });
  });

  it('GET /health/ready reflects dependency reachability', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');

    if (dependenciesReachable.value) {
      // CI/service containers provide PostgreSQL and Redis (D8).
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.checks.database).toEqual({ status: 'up' });
      expect(response.body.checks.redis).toEqual({ status: 'up' });
    } else {
      // Local run without docker compose: still assert a safe, minimal payload.
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('error');
      expect(JSON.stringify(response.body)).not.toContain('://');
      expect(JSON.stringify(response.body)).not.toContain('stack');
    }
  });

  it('every response carries an X-Request-Id using the req_ scheme', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('applies basic security headers (helmet)', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('enables CORS only for configured origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'http://localhost:3001')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3001');

    const denied = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'https://evil.example')
      .expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns the canonical envelope for unknown API routes', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/not-a-real-route').expect(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.any(String),
        request_id: expect.stringMatching(/^req_/),
      },
    });
  });

  it('serves Swagger UI from the canonical contract (D5, ADR-0012)', async () => {
    const response = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(response.text).toContain('swagger-ui');
  });

  it('serves Swagger UI at the canonical contract path outside /api/v1', async () => {
    await request(app.getHttpServer()).get('/api/v1/docs').expect(404);
  });

  it('serves the canonical contract document itself at /docs-json (F7, contract loads)', async () => {
    // `/docs-json` is what Swagger UI's "try it" fetches; serving the file
    // byte-for-byte is the app-level proof that the UI renders the canonical
    // contract and that no decorator-generated parallel contract exists.
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(response.body).toEqual(loadContractDocument());
  });

  it('answers a CORS preflight with no auth, echoing the requested headers for an allowed origin (F7)', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/projects')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
      .expect(204);

    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toBe(
      'authorization,content-type,idempotency-key',
    );
    // No authentication of any kind: a preflight carries no credentials by
    // definition and is excluded before auth and rate limiting (§10.3, AC12).
    expect(preflight.headers['www-authenticate']).toBeUndefined();
    expect(preflight.text).toBeFalsy();
  });

  it('carries no CORS allow headers when the preflight origin is not configured (F7)', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/projects')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    // Whatever status the CORS layer answers with, the browser-usable signal
    // is the absence of `access-control-allow-origin` for a denied origin —
    // without it the browser refuses the cross-origin call no matter what
    // else the response carries.
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
  });
});

describe('Readiness with an unavailable dependency (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        ping: jest
          .fn()
          .mockRejectedValue(new Error('database unreachable postgresql://user:pass@db:5432/x')),
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready returns 503 with a minimal, safe payload', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body.status).toBe('error');
    expect(response.body.service).toBe('brinnpay-api');
    expect(response.body.checks.database).toEqual({ status: 'down' });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('pass');
    expect(serialized).not.toContain('unreachable');
    expect(serialized).not.toContain('Error');
    expect(serialized).not.toContain('stack');
  });
});