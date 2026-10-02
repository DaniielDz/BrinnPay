import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type JobsOptions } from 'bullmq';

import {
  deliverJobId,
  WEBHOOK_JOBS,
  WEBHOOK_QUEUE_NAME,
  type WebhookJobName,
} from './webhook-queue';

/** DI token for the delivery policy injected from configuration (D5). */
export const WEBHOOK_DELIVERY_POLICY = 'WEBHOOK_DELIVERY_POLICY';

/** DI token for the queue's job-retention defaults. */
export const WEBHOOK_JOB_RETENTION = 'WEBHOOK_JOB_RETENTION';

/**
 * Bound on one pass over the events the reconciliation job repairs, and over the
 * pending deliveries it re-queues (D2). The pass is resumable: the next one picks
 * up where this one stopped, so a large backlog cannot monopolize the worker.
 */
export const RECONCILIATION_BATCH = 200;

/**
 * An event is older than this before reconciliation considers repairing it, so a
 * just-committed event is never raced by its own reconciliation pass.
 */
export const RECONCILIATION_MIN_AGE_MS = 30_000;

/**
 * How long a due delivery must have been due before a reconciliation pass
 * re-queues it.
 *
 * **Why a grace window is needed.** `requeueDueDeliveries` selects pending
 * deliveries whose schedule is due, but "due" is not the same as "lost": a job
 * that was successfully enqueued sits in `wait` until a worker picks it up, and
 * a delivery whose `next_attempt_at` has just passed is in exactly that state
 * for as long as the consumer is busy. Because `deliverJobId` embeds a random
 * component (webhook-queue.ts), BullMQ cannot deduplicate those re-adds, so
 * without this window every pass adds a **second** job for a delivery that is
 * already queued. Two jobs for one row both pass the `status = 'pending'` check
 * in `WebhookDeliveryService.attempt` and both perform the outbound request: the
 * CAS then discards one outcome, so the attempt counter stays honest while the
 * destination sees a duplicate. At-least-once permits duplicates (§4.3.8), but
 * a pass that manufactures one for every delivery is a defect, not the
 * documented non-guarantee.
 *
 * A genuinely stranded job is therefore repaired only after this delay, which is
 * the accepted trade: the safety net exists for a crashed worker, and a worker
 * that is down comes back eventually. It is well inside the shortest backoff
 * rung (30 s), so a lost delivery is still retried comfortably within the
 * ladder. `next_attempt_at` remains the authoritative schedule; this only
 * decides when a duplicate of an already-queued job stops looking accidental.
 */
export const REQUEUE_GRACE_MS = 15_000;

/** Defaults for the reconciliation horizon and the queue's failed-job retention. */
const DEFAULT_RECONCILIATION_HORIZON_MS = 3_600_000; // 1 hour
const DEFAULT_FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_RETAINED_FAILED_JOBS = 1_000;

/**
 * How long a finished job's Redis hash is kept.
 *
 * Without it every attempt leaves a permanent job hash, so Redis grows without
 * bound; with a completed job removed on the spot, the queue stays proportional to
 * the work in flight. Failures are kept — bounded by both age and count — because
 * a failed job is what an operator investigates.
 */
export interface WebhookJobRetention {
  removeOnComplete: true;
  removeOnFail: { age: number; count: number };
}

export interface WebhookDeliveryPolicy {
  /** Total HTTP attempts per delivery, first attempt included (D5). */
  maxAttempts: number;
  /** Base of the exponential backoff (D5). */
  baseDelayMs: number;
  /** Ceiling of the backoff, also the clamp for `Retry-After` (D5/D6). */
  maxBackoffMs: number;
  /** Connect timeout of an outbound request (§5.4). */
  connectTimeoutMs: number;
  /** Total timeout of an outbound request (§5.4). */
  requestTimeoutMs: number;
  /** Event retention window in milliseconds (D9). */
  eventRetentionMs: number;
  /** Reconciliation interval in milliseconds (D2). */
  reconciliationIntervalMs: number;
  /**
   * How far back a reconciliation pass may repair (D2). The pass is bounded to
   * `now - horizon … now - RECONCILIATION_MIN_AGE_MS`, so it never walks the whole
   * retention window and a re-enabled endpoint is backfilled only for events that
   * recent.
   */
  reconciliationHorizonMs: number;
  /** Payment advancement sweep interval in milliseconds (D3). */
  advancementSweepIntervalMs: number;
  /** Retention cleanup interval in milliseconds (D9). */
  cleanupIntervalMs: number;
}

/**
 * The API-side queue producer (phase 10 §5.3, D14).
 *
 * Every enqueue is **best-effort by design** (§4.3.7): the business request that
 * produced the event has already committed, and a Redis or queue failure must
 * never turn that committed mutation into a failed response. Failures are logged
 * structurally and swallowed; the reconciliation job creates the missing
 * deliveries afterwards.
 *
 * Repeatable jobs are registered on module init by the worker process, not here —
 * the API only produces delivery work. The BullMQ connection is a separate
 * `ioredis` instance from the readiness probe's, because a connection used for
 * blocking consumer commands cannot be the one that answers a `ping`.
 */
@Injectable()
export class WebhookQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookQueueService.name);
  /**
   * Built eagerly but dialed lazily, so an unreachable Redis is *not* a boot
   * failure (Phase 2 D9: readiness, not configuration, reports dependency health)
   * while a malformed `REDIS_URL` still fails fast at construction — that is a
   * deployment error, not a runtime condition.
   */
  private readonly queue: Queue;

  constructor(
    config: ConfigService,
    @Inject(WEBHOOK_DELIVERY_POLICY) private readonly policy: WebhookDeliveryPolicy,
    @Inject(WEBHOOK_JOB_RETENTION) private readonly retention: WebhookJobRetention,
  ) {
    this.queue = new Queue(WEBHOOK_QUEUE_NAME, {
      connection: {
        // BullMQ accepts a connection URL through `connection.host/port`; the URL
        // is parsed here so credentials never reach a log line.
        ...parseRedisUrl(config.get<string>('redisUrl') as string),
        // The enqueue path must fail fast rather than queue commands behind a
        // reconnect: a slow Redis is a missed enqueue, which reconciliation fixes.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      },
      // Retention is declared on the **producer's** queue because that is where
      // every job is added: a completed job's hash is removed by the worker using
      // the option the job was created with, so a default declared only on the
      // consumer's queue would leave every API-produced job in Redis forever. The
      // worker registers the same defaults, so both ends of the queue agree.
      defaultJobOptions: this.retention,
    });

    // Connection URLs may carry credentials — never log the error object.
    this.queue.on('error', (error: Error) => {
      this.logger.warn(
        { queue: WEBHOOK_QUEUE_NAME, reason: error.message },
        'Webhook queue error; enqueueing is best-effort and reconciliation will recover.',
      );
    });
  }

  onModuleInit(): void {
    // BullMQ dials lazily; nothing to await here. A failure to connect surfaces
    // through the individual (already best-effort) enqueue calls.
  }

  /**
   * Queues one delivery attempt. `attempt` is 1-based and is part of the job id
   * for debuggability; the id is unique per enqueue, so a re-queue of the same
   * attempt is a new job rather than a deduplicated no-op. A failure here is
   * logged and ignored.
   */
  async enqueueDelivery(deliveryId: string, attempt: number, delayMs: number): Promise<boolean> {
    return this.enqueue(
      WEBHOOK_JOBS.DELIVER,
      { delivery_id: deliveryId },
      { jobId: deliverJobId(deliveryId, attempt), delay: Math.max(0, Math.round(delayMs)) },
    );
  }

  /**
   * Registers the three periodic passes as BullMQ job schedulers. Idempotent by
   * construction: `upsertJobScheduler` updates an existing scheduler in place, so
   * a restarted worker refreshes the schedule instead of multiplying it.
   */
  async ensureRepeatables(): Promise<void> {
    const schedulers: { name: WebhookJobName; every: number }[] = [
      { name: WEBHOOK_JOBS.RECONCILE, every: this.policy.reconciliationIntervalMs },
      { name: WEBHOOK_JOBS.ADVANCE_PAYMENTS, every: this.policy.advancementSweepIntervalMs },
      { name: WEBHOOK_JOBS.CLEANUP, every: this.policy.cleanupIntervalMs },
    ];

    for (const scheduler of schedulers) {
      try {
        await this.queue.upsertJobScheduler(
          scheduler.name,
          { every: Math.max(1000, scheduler.every) },
          { name: scheduler.name, data: {} },
        );
      } catch (error) {
        this.logger.warn(
          { job: scheduler.name, reason: messageOf(error) },
          'Could not register a scheduled webhook job; the worker will retry on restart.',
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }

  /** Best-effort enqueue: never throws (§4.3.7). */
  private async enqueue(
    name: WebhookJobName,
    data: Record<string, unknown>,
    options: JobsOptions,
  ): Promise<boolean> {
    try {
      await this.queue.add(name, data, options);
      return true;
    } catch (error) {
      this.logger.warn(
        { job: name, jobId: options.jobId, reason: messageOf(error) },
        'Could not enqueue a webhook job; reconciliation will recover.',
      );
      return false;
    }
  }
}

/** Builds the delivery policy from the environment-driven configuration (D5). */
export function provideDeliveryPolicy(config: ConfigService): WebhookDeliveryPolicy {
  const hours = config.get<number>('webhooks.eventRetentionDays') ?? 30;
  const reconciliationHorizonMs =
    config.get<number>('webhooks.reconciliationHorizonMs') ?? DEFAULT_RECONCILIATION_HORIZON_MS;
  // Fail fast at boot: a horizon at or below the minimum age would leave the pass
  // an empty window, i.e. silently disable the very safety net D2 requires.
  if (reconciliationHorizonMs <= RECONCILIATION_MIN_AGE_MS) {
    throw new Error(
      `WEBHOOK_RECONCILIATION_HORIZON_MS (webhooks.reconciliationHorizonMs) must be greater than ${RECONCILIATION_MIN_AGE_MS} (received "${reconciliationHorizonMs}")`,
    );
  }
  return {
    maxAttempts: config.get<number>('webhooks.maxAttempts') ?? 5,
    baseDelayMs: config.get<number>('webhooks.baseBackoffMs') ?? 30_000,
    maxBackoffMs: config.get<number>('webhooks.maxBackoffMs') ?? 3_600_000,
    connectTimeoutMs: config.get<number>('webhooks.connectTimeoutMs') ?? 5_000,
    requestTimeoutMs: config.get<number>('webhooks.requestTimeoutMs') ?? 10_000,
    eventRetentionMs: hours * 24 * 60 * 60 * 1000,
    reconciliationIntervalMs: config.get<number>('webhooks.reconciliationIntervalMs') ?? 60_000,
    reconciliationHorizonMs,
    advancementSweepIntervalMs:
      config.get<number>('webhooks.advancementSweepIntervalMs') ?? 5_000,
    cleanupIntervalMs: config.get<number>('webhooks.cleanupIntervalMs') ?? 3_600_000,
  };
}

/** Builds the queue's job-retention defaults from the configuration. */
export function provideJobRetention(config: ConfigService): WebhookJobRetention {
  return {
    removeOnComplete: true,
    removeOnFail: {
      age: config.get<number>('webhooks.failedJobRetentionMs') ?? DEFAULT_FAILED_JOB_RETENTION_MS,
      count: config.get<number>('webhooks.retainedFailedJobs') ?? DEFAULT_RETAINED_FAILED_JOBS,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, unknown>;
}

/**
 * Parses `REDIS_URL` into BullMQ's connection options. Parsed rather than
 * passed through so the credentials are only ever handed to the client, never
 * interpolated into a log line or an error message.
 */
export function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const parsed = new URL(redisUrl);
  const options: RedisConnectionOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.username) {
    options.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }
  const db = parsed.pathname.replace(/^\//, '');
  if (db.length > 0 && /^\d+$/.test(db)) {
    options.db = Number(db);
  }
  if (parsed.protocol === 'rediss:') {
    options.tls = {};
  }
  return options;
}
