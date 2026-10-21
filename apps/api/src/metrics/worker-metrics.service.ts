import { Injectable } from '@nestjs/common';
import { Counter, Gauge } from '@prometheus-io/client';

import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE_NAME } from '../webhooks/webhook-queue';
import { WebhookQueueService } from '../webhooks/webhook-queue.service';
import {
  DELIVERY_OUTCOMES,
  QUEUE_STATES,
  MetricsService,
  type DeliveryOutcome,
  type SweepPass,
} from './metrics.service';

/**
 * Worker-only metrics (phase 20 §6 M5). Registered in `WebhooksWorkerModule`
 * exclusively, so the API process never loads a Prisma-backed collect or a
 * BullMQ query into its own exposition (D3/§16): each process exposes exactly
 * the signals it can actually produce.
 *
 * Queue state and the oldest-pending age are **pull-scrape collectors** —
 * they query at exposition time rather than on a timer, so a stopped worker
 * stops reporting rather than reporting a frozen snapshot, and no background
 * interval is left to manage. The per-project age gauge is the fairness view
 * (§10): bounded to {@link MAX_PENDING_PROJECTS} tenants per scrape, chosen by
 * oldest work first, and silently reduced to the aggregate when the backlog
 * involves more tenants than that — a scrape must not become an unbounded
 * label fan-out, however real the backlog is.
 */

/** Ceiling on distinct `project_id` series for the fairness gauge (D5(a)). */
export const MAX_PENDING_PROJECTS = 50;

@Injectable()
export class WorkerMetricsService {
  private readonly deliveryAttempts: Counter<'outcome'>;
  private readonly queueJobs: Gauge<'queue' | 'state'>;
  private readonly oldestPendingAge: Gauge<string>;
  private readonly oldestPendingByProject: Gauge<'project_id'>;
  private readonly sweepDuration: Gauge<'pass'>;
  private readonly sweepLastRun: Gauge<'pass'>;
  /** One exposition-level warning per gauge name, never one per scrape. */
  private readonly warnedCollects = new Set<string>();
  /**
   * The two age gauges are written by one database pass, but the registry
   * renders metrics in parallel and each gauge's `get()` awaits only *its own*
   * `collect`. Sharing the in-flight promise means the per-project gauge waits
   * for the pass that populates it instead of snapshotting an empty store —
   * which would otherwise omit the fairness series from the first scrape and
   * lag it by one scrape thereafter.
   */
  private oldestPendingCollect: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: WebhookQueueService,
    metrics: MetricsService,
  ) {
    const registers = [metrics.registry];

    this.deliveryAttempts = new Counter({
      name: 'brinnpay_delivery_attempts_total',
      help: 'Outbound webhook delivery attempts by outcome (phase 10 §5.4 outcomes, phase 20 §6 M5).',
      labelNames: ['outcome'],
      registers,
    });
    this.queueJobs = new Gauge({
      name: 'brinnpay_queue_jobs',
      help: 'Webhook delivery jobs in the watched BullMQ states, by state.',
      labelNames: ['queue', 'state'],
      registers,
      collect: async () => {
        // `jobCounts` never throws (zeros on failure); the values describe the
        // queue at scrape time, which is exactly when they are read.
        const counts = await this.queueService.jobCounts();
        for (const state of QUEUE_STATES) {
          this.queueJobs.set({ queue: WEBHOOK_QUEUE_NAME, state }, counts[state]);
        }
      },
    });
    this.oldestPendingAge = new Gauge({
      name: 'brinnpay_delivery_oldest_pending_age_seconds',
      help: 'Age of the oldest pending webhook delivery in seconds (0 when none are pending).',
      registers,
      collect: async () => {
        await this.collectOldestPendingOnce();
      },
    });
    this.oldestPendingByProject = new Gauge({
      name: 'brinnpay_delivery_oldest_pending_age_by_project_seconds',
      help:
        'Age of the oldest pending webhook delivery per project, for the top ' +
        `${MAX_PENDING_PROJECTS} projects by age (0 when none are pending).`,
      labelNames: ['project_id'],
      registers,
      collect: async () => {
        await this.collectOldestPendingOnce();
      },
    });
    this.sweepDuration = new Gauge({
      name: 'brinnpay_worker_sweep_duration_seconds',
      help: 'Duration of the most recent run of each worker sweep pass.',
      labelNames: ['pass'],
      registers,
    });
    this.sweepLastRun = new Gauge({
      name: 'brinnpay_worker_sweep_last_run_timestamp_seconds',
      help: 'Unix timestamp of the most recent start of each worker sweep pass.',
      labelNames: ['pass'],
      registers,
    });
  }

  /**
   * One delivery attempt, by outcome. Called from the processor — the worker
   * boundary where the outcome is known — so the shared delivery service stays
   * free of process-specific concerns.
   */
  incDeliveryAttempt(outcome: DeliveryOutcome): void {
    if ((DELIVERY_OUTCOMES as readonly string[]).includes(outcome)) {
      this.deliveryAttempts.inc({ outcome });
    }
  }

  /** One sweep observation; called by the maintenance service's timed passes. */
  observeSweep(pass: SweepPass, durationMs: number): void {
    this.sweepDuration.set({ pass }, Math.max(0, durationMs) / 1000);
    this.sweepLastRun.set({ pass }, Date.now() / 1000);
  }

  /**
   * One database pass serves both age gauges within a scrape: the first gauge
   * to collect starts it, the other awaits the same promise, and the promise is
   * cleared on resolution so the *next* scrape queries fresh state.
   */
  private collectOldestPendingOnce(): Promise<void> {
    this.oldestPendingCollect ??= this.collectOldestPending().finally(() => {
      this.oldestPendingCollect = null;
    });
    return this.oldestPendingCollect;
  }

  /**
   * One bounded pass serves both age gauges. Deliveries hang off endpoints, not
   * projects (schema: `webhook_deliveries` has no `project_id`), so the oldest
   * work is grouped by `endpointId`, the endpoints' projects are resolved in
   * one follow-up read, and the per-project view keeps the oldest endpoint per
   * project. Rows arrive oldest-first, the group is capped one past the
   * per-project ceiling so overflow is detectable rather than silently
   * truncated, and the aggregate survives any failure of the per-project view.
   */
  private async collectOldestPending(): Promise<void> {
    try {
      const rows = await this.prisma.webhookDelivery.groupBy({
        by: ['endpointId'],
        where: { status: 'pending' },
        _min: { createdAt: true },
        orderBy: { _min: { createdAt: 'asc' } },
        take: MAX_PENDING_PROJECTS + 1,
      });

      const nowMs = Date.now();
      this.oldestPendingByProject.reset();

      const first = rows[0]?._min?.createdAt;
      if (first === undefined || first === null) {
        this.oldestPendingAge.set(0);
        return;
      }
      this.oldestPendingAge.set(Math.max(0, (nowMs - first.getTime()) / 1000));

      if (rows.length > MAX_PENDING_PROJECTS) {
        // More endpoints with pending work than the label ceiling: the
        // aggregate stays truthful, the per-project view is withheld until the
        // fan-out fits (D5(a)).
        this.warnCollectOnce('oldest_pending_by_project');
        return;
      }

      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { id: { in: rows.map((row) => row.endpointId) } },
        select: { id: true, projectId: true },
      });
      const projectByEndpoint = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.projectId]));

      const oldestByProject = new Map<string, number>();
      for (const row of rows) {
        const createdAt = row._min?.createdAt;
        const projectId = projectByEndpoint.get(row.endpointId);
        if (createdAt === undefined || createdAt === null || projectId === undefined) {
          continue;
        }
        // Oldest-first order: the first row seen for a project is its oldest.
        if (!oldestByProject.has(projectId)) {
          oldestByProject.set(projectId, Math.max(0, (nowMs - createdAt.getTime()) / 1000));
        }
      }
      for (const [projectId, ageSeconds] of oldestByProject) {
        this.oldestPendingByProject.set({ project_id: projectId }, ageSeconds);
      }
    } catch {
      this.warnCollectOnce('oldest_pending');
      this.oldestPendingAge.set(0);
    }
  }

  private warnCollectOnce(key: string): void {
    if (this.warnedCollects.has(key)) {
      return;
    }
    this.warnedCollects.add(key);
    // Worker process has no request logger; one line per collect, never per scrape.
    console.warn(`[worker-metrics] collect for "${key}" failed or overflowed; reporting zeros/partial values.`);
  }
}
