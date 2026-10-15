import { randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';

import { MetricsService } from '../src/metrics/metrics.service';
import { WorkerHttpListener } from '../src/metrics/worker-http.listener';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { WEBHOOK_JOBS } from '../src/webhooks/webhook-queue';
import { WebhookMaintenanceService } from '../src/webhooks/webhook-maintenance.service';
import { WebhookProcessor } from '../src/webhooks/webhook.processor';
import { WebhooksWorkerModule } from '../src/webhooks/webhooks-worker.module';
import { requireDependencies } from './support/db-e2e';

/**
 * Phase 20 worker observability e2e (AC5/AC2, D3(a)/D7(a)): the M5 catalog
 * against the **real** worker application context over real PostgreSQL and
 * Redis.
 *
 * The delivery pipeline itself is exercised end-to-end in
 * `webhook-delivery.e2e-spec.ts`; this suite drives the same boundaries the
 * consumer drives — the processor's job handlers and the maintenance passes —
 * and asserts that the signals *move*: attempt outcomes, sweep gauges, queue
 * depth, oldest-pending age, and the worker's own liveness/exposition
 * listener. It boots the worker module exactly as `src/worker.ts` composes it,
 * minus the consumer's timers being asserted (the module registers them; the
 * delivery suite proves them).
 */
jest.setTimeout(120_000);

/** Minimal structural stand-in for a BullMQ job — only name/data are read. */
const fakeJob = (name: string, data: unknown): Job =>
  ({ name, data }) as unknown as Job;

describe('worker observability (Phase 20 M2/M5, real PostgreSQL + Redis)', () => {
  let worker: INestApplicationContext;
  let processor: WebhookProcessor;
  let maintenance: WebhookMaintenanceService;
  let listener: WorkerHttpListener;
  let metrics: MetricsService;
  let reachable = false;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [WebhooksWorkerModule] }).compile();
    worker = await ref.init();
    processor = worker.get(WebhookProcessor);
    maintenance = worker.get(WebhookMaintenanceService);
    listener = worker.get(WorkerHttpListener);
    metrics = worker.get(MetricsService);

    try {
      await worker.get(PrismaService).ping();
      await worker.get(RedisService).ping();
      reachable = true;
    } catch {
      /* Local development without docker compose. */
    }
  });

  afterAll(async () => {
    if (listener) await listener.stop();
    if (worker) await worker.close();
  });

  it('counts a malformed delivery job as skipped, without touching the domain (M5)', async () => {
    requireDependencies(reachable);
    const result = await processor.process(fakeJob(WEBHOOK_JOBS.DELIVER, {}));
    expect(result).toBe('skipped');

    const body = await metrics.render();
    expect(body).toMatch(/brinnpay_delivery_attempts_total\{outcome="skipped"\} [1-9]/);
  });

  it('counts a missing delivery row as skipped through the real attempt path (M5)', async () => {
    requireDependencies(reachable);
    const result = await processor.process(
      fakeJob(WEBHOOK_JOBS.DELIVER, { delivery_id: randomUUID() }),
    );
    // The delivery service re-reads the row and treats "gone" as a no-op
    // success path — the outcome is recorded, never thrown (D4).
    expect(result).toBe('skipped');

    const body = await metrics.render();
    const match = body.match(/brinnpay_delivery_attempts_total\{outcome="skipped"\} (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(2);
  });

  it('updates sweep duration and last-run gauges for every pass (M5, ADR-0039 PR-5)', async () => {
    requireDependencies(reachable);
    await maintenance.reconcile();
    await maintenance.advancePayments();
    await maintenance.cleanupExpired();

    const body = await metrics.render();
    for (const pass of ['reconciliation', 'requeue', 'advancement', 'retention']) {
      expect(body).toMatch(
        new RegExp(`brinnpay_worker_sweep_duration_seconds\\{pass="${pass}"\\} [0-9]`),
      );
      expect(body).toMatch(
        new RegExp(`brinnpay_worker_sweep_last_run_timestamp_seconds\\{pass="${pass}"\\} [0-9]`),
      );
    }
  });

  it('exposes queue depth by state and the oldest-pending age from the pull collectors (M5, PR-2/PR-5)', async () => {
    requireDependencies(reachable);
    const body = await metrics.render();
    for (const state of ['wait', 'delayed', 'active', 'failed']) {
      expect(body).toContain(`brinnpay_queue_jobs{queue="brinnpay-webhooks",state="${state}"}`);
    }
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_seconds');
    // The fairness gauge is registered even when the backlog is empty (it then
    // reports no project series — bounded by design, D5(a)).
    expect(body).toContain('# HELP brinnpay_delivery_oldest_pending_age_by_project_seconds');
  });

  it('serves liveness and the exposition on its own port (D3(a), D7(a))', async () => {
    requireDependencies(reachable);
    const port = await listener.start(0);
    expect(port).toBeGreaterThan(0);
    expect(listener.actualPort).toBe(port);

    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: 'ok' });

    const exposition = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(exposition.status).toBe(200);
    expect(exposition.headers.get('content-type')).toContain('text/plain');
    const text = await exposition.text();
    expect(text).toContain('brinnpay_queue_jobs');
    expect(text).toContain('brinnpay_delivery_attempts_total');
    expect(text).toContain('brinnpay_worker_sweep_duration_seconds');

    // Nothing else answers on the listener.
    await fetch(`http://127.0.0.1:${port}/not-a-route`).then((response) =>
      expect(response.status).toBe(404),
    );
    await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' }).then((response) =>
      expect(response.status).toBe(405),
    );
  });

  it('keeps liveness answering when the exposition is disabled (D7(a))', async () => {
    requireDependencies(reachable);
    // Same listener class, flag off — the exact posture of METRICS_ENABLED=false
    // in production, where liveness must stay probeable regardless.
    const disabled = new WorkerHttpListener(
      {
        getOrThrow: (key: string) => {
          if (key === 'metrics.enabled') return false;
          if (key === 'metrics.path') return '/metrics';
          if (key === 'metrics.scrapeToken') return null;
          if (key === 'metrics.workerPort') return 0;
          return undefined;
        },
      } as never,
      metrics,
    );

    const port = await disabled.start(0);
    try {
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
      await expect(live.json()).resolves.toEqual({ status: 'ok' });

      const exposition = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(exposition.status).toBe(404);
    } finally {
      await disabled.stop();
    }
  });

  it('stops answering after stop() — start/stop is safe under an application close (AC2)', async () => {
    requireDependencies(reachable);
    // The main listener is running from the earlier case; stop it and prove
    // the port is released. (The suite's afterAll stop is then a no-op.)
    const port = listener.actualPort;
    expect(port).toBeGreaterThan(0);
    await listener.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
  });
});
