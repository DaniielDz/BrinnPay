import { PrismaService } from '../prisma/prisma.service';
import { WebhookQueueService } from '../webhooks/webhook-queue.service';
import { MetricsService } from './metrics.service';
import { MAX_PENDING_PROJECTS, WorkerMetricsService } from './worker-metrics.service';

/**
 * The worker-only half of the catalog (phase 20 §6 M5): delivery attempts by
 * outcome, queue depth by watched state, oldest-pending age (aggregate and
 * bounded per-project), and the sweep-pass timing stamps.
 */
describe('WorkerMetricsService (phase 20 §6 M5)', () => {
  let prisma: {
    webhookDelivery: { groupBy: jest.Mock };
    webhookEndpoint: { findMany: jest.Mock };
  };
  let queueService: { jobCounts: jest.Mock };
  let metrics: MetricsService;
  let workerMetrics: WorkerMetricsService;

  const endpoints = [
    { id: 'ep_1', projectId: 'proj_a' },
    { id: 'ep_2', projectId: 'proj_b' },
  ];

  beforeEach(() => {
    prisma = {
      webhookDelivery: {
        groupBy: jest.fn().mockResolvedValue([
          { endpointId: 'ep_1', _min: { createdAt: new Date(Date.now() - 120_000) } },
          { endpointId: 'ep_2', _min: { createdAt: new Date(Date.now() - 30_000) } },
        ]),
      },
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue(endpoints),
      },
    };
    queueService = {
      jobCounts: jest.fn().mockResolvedValue({ wait: 3, delayed: 2, active: 1, failed: 0 }),
    };
    metrics = new MetricsService();
    workerMetrics = new WorkerMetricsService(
      prisma as unknown as PrismaService,
      queueService as unknown as WebhookQueueService,
      metrics,
    );
  });

  it('registers the M5 catalog on the worker registry', async () => {
    const body = await metrics.render();
    expect(body).toContain('brinnpay_delivery_attempts_total');
    expect(body).toContain('brinnpay_queue_jobs');
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_seconds');
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_by_project_seconds');
    expect(body).toContain('brinnpay_worker_sweep_duration_seconds');
    expect(body).toContain('brinnpay_worker_sweep_last_run_timestamp_seconds');
  });

  it('counts delivery attempts by the closed outcome set', async () => {
    workerMetrics.incDeliveryAttempt('delivered');
    workerMetrics.incDeliveryAttempt('failed');
    workerMetrics.incDeliveryAttempt('delivered');
    // Not in the closed set: silently ignored, never a new label.
    workerMetrics.incDeliveryAttempt('exploded' as never);

    const body = await metrics.render();
    expect(body).toContain('brinnpay_delivery_attempts_total{outcome="delivered"} 2');
    expect(body).toContain('brinnpay_delivery_attempts_total{outcome="failed"} 1');
    expect(body).not.toContain('exploded');
  });

  it('pulls queue depth per watched state at scrape time', async () => {
    const body = await metrics.render();
    expect(queueService.jobCounts).toHaveBeenCalledTimes(1);
    expect(body).toContain('brinnpay_queue_jobs{queue="brinnpay-webhooks",state="wait"} 3');
    expect(body).toContain('brinnpay_queue_jobs{queue="brinnpay-webhooks",state="delayed"} 2');
    expect(body).toContain('brinnpay_queue_jobs{queue="brinnpay-webhooks",state="active"} 1');
    expect(body).toContain('brinnpay_queue_jobs{queue="brinnpay-webhooks",state="failed"} 0');
  });

  it('reports zeros for queue depth when Redis is unreachable', async () => {
    queueService.jobCounts.mockResolvedValue({ wait: 0, delayed: 0, active: 0, failed: 0 });
    const body = await metrics.render();
    expect(body).toContain('brinnpay_queue_jobs{queue="brinnpay-webhooks",state="wait"} 0');
  });

  it('maps endpoint groups to per-project ages, oldest first', async () => {
    const body = await metrics.render();
    // Aggregate: the oldest pending delivery overall (~120s old).
    const aggregateLine = body
      .split('\n')
      .find((line) => line.startsWith('brinnpay_delivery_oldest_pending_age_seconds '));
    expect(aggregateLine).toBeDefined();
    const aggregateAge = Number(aggregateLine?.split(' ')[1]);
    expect(aggregateAge).toBeGreaterThanOrEqual(119);
    expect(aggregateAge).toBeLessThan(131);

    // Per project: ep_1 (120s) belongs to proj_a, ep_2 (30s) to proj_b.
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_by_project_seconds{project_id="proj_a"}');
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_by_project_seconds{project_id="proj_b"}');
  });

  it('withholds the per-project view beyond the cardinality ceiling, keeping the aggregate', async () => {
    // One row past the ceiling is enough to prove the overflow branch: the
    // scrape must not fan out to an unbounded label set (D5(a)).
    prisma.webhookDelivery.groupBy.mockResolvedValue(
      Array.from({ length: MAX_PENDING_PROJECTS + 1 }, (_, index) => ({
        endpointId: `ep_${index}`,
        _min: { createdAt: new Date(Date.now() - (index + 1) * 1_000) },
      })),
    );

    const body = await metrics.render();
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_seconds');
    expect(body).not.toContain('project_id=');
    expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });

  it('reports zero age when nothing is pending', async () => {
    prisma.webhookDelivery.groupBy.mockResolvedValue([]);
    const body = await metrics.render();
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_seconds 0');
    expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });

  it('survives a database failure with the aggregate at zero (§4 rule 5)', async () => {
    prisma.webhookDelivery.groupBy.mockRejectedValue(new Error('db down'));
    const body = await metrics.render();
    expect(body).toContain('brinnpay_delivery_oldest_pending_age_seconds 0');
  });

  it('stamps sweep duration and last-run time per pass', async () => {
    workerMetrics.observeSweep('reconciliation', 1_500);
    workerMetrics.observeSweep('requeue', 250);

    const body = await metrics.render();
    expect(body).toContain('brinnpay_worker_sweep_duration_seconds{pass="reconciliation"} 1.5');
    expect(body).toContain('brinnpay_worker_sweep_duration_seconds{pass="requeue"} 0.25');
    expect(body).toContain('brinnpay_worker_sweep_last_run_timestamp_seconds{pass="reconciliation"}');
  });
});
