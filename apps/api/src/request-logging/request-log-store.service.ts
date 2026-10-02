import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import type { RequestLogRecord } from './request-log-record';

/** DI token for the retention policy injected from configuration (D5). */
export const REQUEST_LOG_RETENTION_POLICY = 'REQUEST_LOG_RETENTION_POLICY';

/**
 * Name of the periodic retention job (D5).
 *
 * It is scheduled on the existing webhook queue — phase 10 §14/§5.4 asks for
 * cleanup to ride the maintenance introduced there rather than a new job
 * runner. Request logs are *not* webhook events and emit nothing into the event
 * catalog (§6); the queue is used purely as a periodic, restart-surviving
 * timer in the worker process, never on the request path.
 */
export const REQUEST_LOG_CLEANUP_JOB = 'request-logs.cleanup';

/** Rows deleted per statement by one retention pass, bounded like phase 10 D9. */
const CLEANUP_BATCH = 500;

/**
 * How many pages one retention pass deletes. Bounds the pass's runtime: a
 * backlog larger than this carries over to the next pass instead of
 * monopolizing the worker.
 */
const CLEANUP_MAX_PAGES = 20;

export interface RequestLogRetentionPolicy {
  /** Retention window in milliseconds (D5). */
  retentionMs: number;
  /** How often the cleanup pass runs, in milliseconds (D5). */
  cleanupIntervalMs: number;
}

/** Builds the retention policy from the environment-driven configuration (D5). */
export function provideRequestLogRetentionPolicy(
  config: ConfigService,
): RequestLogRetentionPolicy {
  const retentionDays = config.get<number>('requestLogging.retentionDays') ?? 30;
  return {
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    cleanupIntervalMs: config.get<number>('requestLogging.cleanupIntervalMs') ?? 3_600_000,
  };
}

/**
 * Durability half of the request-logging capability (phase 11 §5.2, D3).
 *
 * `write` is deliberately best-effort: it runs *after* the response has been
 * produced, it never retries inline, and it never throws — a failed write is
 * logged (with the request id and the error class only, never the payload) and
 * the record is dropped. Observability data is allowed to be lost; the request
 * that produced it is not allowed to be affected by the loss (AC5).
 *
 * `cleanupExpired` is the D5 retention pass, driven by the worker's periodic
 * job (§14: schedule alongside Phase 10's maintenance, never couple readiness
 * to cleanup health).
 */
@Injectable()
export class RequestLogStoreService {
  private readonly logger = new Logger(RequestLogStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REQUEST_LOG_RETENTION_POLICY) private readonly policy: RequestLogRetentionPolicy,
  ) {}

  /**
   * Persists one record. Never throws (D3).
   *
   * The mapping below is the second half of the §4.2 rule 4 allowlist: only the
   * columns named here exist, so a future field added to `RequestLogRecord`
   * does not reach the database until it is deliberately mapped.
   */
  async write(record: RequestLogRecord): Promise<void> {
    try {
      await this.prisma.requestLog.create({
        data: {
          id: record.id,
          requestId: record.request_id,
          projectId: record.project_id,
          organizationId: record.organization_id,
          userId: record.user_id,
          apiKeyId: record.api_key_id,
          environment: record.environment,
          method: record.method,
          path: record.path,
          statusCode: record.status_code,
          durationMs: record.duration_ms,
          createdAt: record.created_at,
        },
      });
    } catch (error) {
      // §8: the request id and the error *class* only — never the message
      // (Prisma frames and validation messages can echo values), never the
      // record payload, never a header, never a query string.
      this.logger.error(
        { request_id: record.request_id, reason: errorClassOf(error) },
        'Failed to persist a request log record; the record is dropped.',
      );
    }
  }

  /**
   * D5: drop rows past the retention window.
   *
   * Batched rather than one unbounded `deleteMany`, for the same reason as the
   * phase 10 retention pass: a pass that has been off for a week would hand a
   * single statement the whole backlog and hold row locks for its duration.
   * Ids are selected in bounded pages on the `created_at` index and deleted per
   * page, so each statement is short, a failure loses at most one page, and a
   * very large backlog carries over to the next pass.
   *
   * A failure is logged and the count already removed is returned truthfully;
   * the next pass resumes from the cutoff.
   */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.policy.retentionMs);
    let removed = 0;

    for (let page = 0; page < CLEANUP_MAX_PAGES; page += 1) {
      try {
        // Only ids are read; the rows are not fetched just to delete them.
        const expired = await this.prisma.requestLog.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { createdAt: 'asc' },
          take: CLEANUP_BATCH,
          select: { id: true },
        });
        if (expired.length === 0) break;

        const { count } = await this.prisma.requestLog.deleteMany({
          where: { id: { in: expired.map((row) => row.id) } },
        });
        removed += count;

        if (expired.length < CLEANUP_BATCH) break; // last page; nothing older remains
      } catch (error) {
        this.logger.warn(
          { reason: errorClassOf(error), removed },
          'Request log retention cleanup failed; the next pass retries.',
        );
        return removed;
      }
    }

    if (removed > 0) {
      this.logger.log({ removed, cutoff: cutoff.toISOString() }, 'Expired request logs removed.');
    }
    return removed;
  }
}

function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}(${code})` : error.name;
}
