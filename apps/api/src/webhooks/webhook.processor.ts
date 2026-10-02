import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookMaintenanceService } from './webhook-maintenance.service';
import {
  WEBHOOK_JOBS,
  WEBHOOK_QUEUE_NAME,
  type DeliverJobData,
} from './webhook-queue';

/**
 * The BullMQ consumer (phase 10 §5.3, D14).
 *
 * It runs in its own process (see `worker.ts`), sharing only PostgreSQL and Redis
 * with the API. Every handler is **idempotent**: the delivery handler re-reads
 * the delivery and its endpoint before acting and treats a missing row as a
 * successful no-op, so a removed job, a deleted endpoint, or a duplicate
 * concurrent run can never double-attempt or corrupt the aggregate (D4).
 *
 * A job that throws is retried by BullMQ itself only when the failure is
 * infrastructural (the database is down, for example). Destination failures are
 * * *never* thrown: they are recorded on the delivery row and re-queued with
 * backoff, so a permanently broken destination cannot exhaust BullMQ's retry
 * budget or spin the worker.
 */
@Processor(WEBHOOK_QUEUE_NAME)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly delivery: WebhookDeliveryService,
    private readonly maintenance: WebhookMaintenanceService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case WEBHOOK_JOBS.DELIVER:
        return this.deliver(job.data as DeliverJobData);
      case WEBHOOK_JOBS.RECONCILE:
        return this.reconcile();
      case WEBHOOK_JOBS.ADVANCE_PAYMENTS:
        return this.advancePayments();
      case WEBHOOK_JOBS.CLEANUP:
        return this.cleanup();
      default:
        // A job name this build does not understand is a deployment mismatch, not
        // a destination problem: logging it and completing keeps the queue moving.
        this.logger.warn({ job: job.name }, 'Ignoring an unknown webhook job name.');
        return null;
    }
  }

  private async deliver(data: DeliverJobData): Promise<string> {
    const deliveryId = data?.delivery_id;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      this.logger.warn('Discarding a delivery job without a delivery id.');
      return 'skipped';
    }
    return this.delivery.attempt(deliveryId);
  }

  /**
   * The pass's own structured log line is emitted by
   * {@link WebhookMaintenanceService.reconcile}, which knows the window bounds;
   * here the counts are only returned as the job's result.
   */
  private async reconcile(): Promise<unknown> {
    return this.maintenance.reconcile();
  }

  private async advancePayments(): Promise<number> {
    const advanced = await this.maintenance.advancePayments();
    if (advanced > 0) {
      this.logger.debug({ advanced }, 'Payment advancement sweep applied due edges.');
    }
    return advanced;
  }

  private async cleanup(): Promise<number> {
    return this.maintenance.cleanupExpired();
  }
}

/**
 * The consumer connection is **not** declared here: `@Processor` metadata is
 * evaluated at import time, before the injector exists, so the connection is
 * supplied by `BullModule.forRootAsync` in {@link WebhooksWorkerModule}, which
 * resolves it from `REDIS_URL` through the same parser the producer uses.
 */
