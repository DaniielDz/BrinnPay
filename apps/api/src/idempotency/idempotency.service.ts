import { Inject, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { uuidv7 } from '../common/uuid/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeIdempotencyKey } from './idempotency-key';
import type { IdempotencyOperationScope } from './idempotency-operation';

/** DI token for the retention policy (ADR-0004: a single configurable
 *  constant shared by storage and the API documentation). */
export const IDEMPOTENCY_RETENTION = 'IDEMPOTENCY_RETENTION';

export interface IdempotencyRetention {
  /** Retention window of an idempotency record, in milliseconds. */
  retentionMs: number;
}

/** ADR-0004 default: 24 hours. */
export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The mutation runs inside the claim transaction, so it must use the supplied
 * client exclusively. `PrismaService` is structurally a `TransactionClient`,
 * which is what the no-key path passes.
 */
export type IdempotencyTransaction = Prisma.TransactionClient;

export interface IdempotencyRequest {
  /** The project the mutation belongs to — the isolation boundary (ADR-0004). */
  projectId: string;
  operationScope: IdempotencyOperationScope;
  /** The raw, unvalidated `Idempotency-Key` header value (if the client sent one). */
  key: string | undefined;
}

export interface IdempotentExecution<T> {
  /** HTTP status to store for replay. */
  status: number;
  /** The API response projection to store for replay. */
  body: T;
  /**
   * Side effects that must happen only for the first *committed* execution
   * (e.g. `payment.created` emission, phase 8 §4.3.1/§6.3). Never invoked for a
   * replay or a rolled-back mutation, and deliberately fire-and-forget: a
   * post-commit failure must not fail an already-committed mutation.
   */
  afterCommit?: () => void;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** `true` when the response was replayed from a stored record. */
  replayed: boolean;
}

/** Interactive-transaction guardrails (phase 8 §4.4): the mutation is a short
 *  synchronous write, so the defaults are generous enough for the loser of a
 *  concurrent same-key race to wait for the winner and read its committed
 *  response. */
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** Bounded retries for the only losable step of the claim: the conflicting row
 *  disappearing between the failed insert and the read (a concurrent cleanup). */
const MAX_CLAIM_ATTEMPTS = 3;

/** Columns the claim/replay path reads. */
interface ClaimRecord {
  id: string;
  responseStatus: number | null;
  responseBody: Prisma.JsonValue | null;
  expiresAt: Date;
}

interface ClaimTarget {
  projectId: string;
  operationScope: IdempotencyOperationScope;
  key: string;
  now: Date;
  retentionMs: number;
}

type ClaimOutcome =
  | { acquired: true; id: string }
  | { acquired: false; record: ClaimRecord };

/** The stored projection is the API response body, not an ORM row: it is
 *  serialized exactly as the transport would serialize it (ISO-8601 dates,
 *  decimal-string amounts) and persisted as `jsonb`. Note that PostgreSQL
 *  `jsonb` normalizes object key order — the replayed JSON *value* is
 *  identical, which is what the contract guarantees. */
function toStoredBody(body: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
}

/**
 * Cross-cutting idempotency capability (phase 8 §4.1).
 *
 * A critical mutation calls {@link IdempotencyService.execute} with its
 * operation scope and the raw `Idempotency-Key` header, and the service
 * guarantees that the side effect happens **at most once** per
 * (project, operation scope, key) within the retention window (ADR-0004):
 *
 * - no key → the mutation runs normally, nothing is stored, no overhead beyond
 *   a direct call;
 * - fresh key → the key is claimed atomically inside a transaction, the
 *   mutation runs once, and its response projection is stored in the same
 *   transaction before commit, so a rolled-back mutation leaves no replayable
 *   record (§6.8);
 * - active key → the stored status/body is returned without running the
 *   mutation again (no second side effect, no duplicate event);
 * - expired key → the stale row is freed and the mutation runs as a new
 *   operation, without waiting for any asynchronous cleanup (§5.2).
 *
 * Concurrency is decided by the database, never by in-memory coordination
 * (§4.4): the claim is an `INSERT ... ON CONFLICT DO NOTHING` against the
 * compound unique index. A racing request therefore either inserts (winner) or
 * conflicts — and a conflict only becomes visible once the winner commits, so
 * the loser always reads a complete, committed record and replays it. If the
 * winner rolls back, the loser's insert proceeds and it executes the mutation
 * itself (§4.4.4).
 *
 * Scope isolation is structural: every statement is filtered by the caller's
 * `projectId`, so a key can never replay across projects or operation scopes,
 * and authorization stays the gate in front of this capability (phase 8 §6.1,
 * §6.2).
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDEMPOTENCY_RETENTION) private readonly retention: IdempotencyRetention,
  ) {}

  /**
   * Runs `run` under the idempotency contract described above and resolves with
   * the status/body to answer with, plus whether it was a replay.
   */
  async execute<T>(
    request: IdempotencyRequest,
    run: (tx: IdempotencyTransaction) => Promise<IdempotentExecution<T>>,
  ): Promise<IdempotentResult<T>> {
    // Validation happens before anything else: a rejected key never claims a
    // slot and never reaches the mutation (§4.2.6).
    const key = normalizeIdempotencyKey(request.key);

    if (key === undefined) {
      const execution = await run(this.prisma);
      this.afterCommit(execution);
      return { status: execution.status, body: execution.body, replayed: false };
    }

    const target: ClaimTarget = {
      projectId: request.projectId,
      operationScope: request.operationScope,
      key,
      now: new Date(),
      retentionMs: this.retention.retentionMs,
    };

    const outcome = await this.prisma.$transaction<TransactionOutcome<T>>(
      async (tx) => {
        const claim = await this.claim(tx, target);

        if (!claim.acquired) {
          return this.replay<T>(claim.record);
        }

        const execution = await run(tx);
        await tx.idempotencyRecord.update({
          where: { id: claim.id },
          data: {
            responseStatus: execution.status,
            responseBody: toStoredBody(execution.body),
            updatedAt: target.now,
          },
        });
        await this.pruneExpired(tx, target);

        return {
          status: execution.status,
          body: execution.body,
          replayed: false,
          afterCommit: execution.afterCommit,
        };
      },
      TRANSACTION_OPTIONS,
    );

    if (!outcome.replayed) {
      this.afterCommit(outcome);
    }
    return { status: outcome.status, body: outcome.body, replayed: outcome.replayed };
  }

  // -------------------------------------------------------------------------
  // Claim (phase 8 §4.4, §5.2)
  // -------------------------------------------------------------------------

  /**
   * Atomically claims (project, scope, key) for the retention window.
   *
   * `createMany({ skipDuplicates: true })` is an `INSERT … ON CONFLICT DO
   * NOTHING`: it never aborts the surrounding transaction (unlike a unique
   * violation), so the loser can keep working in the same transaction — it
   * either replays the committed record, frees an expired one, or retries.
   */
  private async claim(tx: IdempotencyTransaction, target: ClaimTarget): Promise<ClaimOutcome> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = await this.insertClaim(tx, target);
      if (claimed) {
        return { acquired: true, id: claimed };
      }

      const record = await this.findRecord(tx, target);
      if (!record) {
        // The conflicting row was removed between the failed insert and this
        // read (concurrent cleanup) — try to claim again.
        continue;
      }

      if (record.expiresAt.getTime() > target.now.getTime()) {
        return { acquired: false, record };
      }

      // Expired: free the key in this same transaction so reuse never has to
      // wait for asynchronous cleanup (§5.2). The `expires_at` predicate keeps
      // a concurrently refreshed record from being deleted.
      await tx.idempotencyRecord.deleteMany({
        where: { id: record.id, expiresAt: { lte: target.now } },
      });
    }

    throw new ApiError(ErrorCode.INTERNAL_ERROR, 'Internal server error', 500);
  }

  private async insertClaim(tx: IdempotencyTransaction, target: ClaimTarget): Promise<string | null> {
    const id = uuidv7();
    const expiresAt = new Date(target.now.getTime() + target.retentionMs);
    const result = await tx.idempotencyRecord.createMany({
      data: {
        id,
        projectId: target.projectId,
        operationScope: target.operationScope,
        idempotencyKey: target.key,
        createdAt: target.now,
        updatedAt: target.now,
        expiresAt,
      },
      skipDuplicates: true,
    });
    return result.count === 1 ? id : null;
  }

  private findRecord(
    tx: IdempotencyTransaction,
    target: ClaimTarget,
  ): Promise<ClaimRecord | null> {
    return tx.idempotencyRecord.findUnique({
      where: {
        projectId_operationScope_idempotencyKey: {
          projectId: target.projectId,
          operationScope: target.operationScope,
          idempotencyKey: target.key,
        },
      },
      select: { id: true, responseStatus: true, responseBody: true, expiresAt: true },
    });
  }

  /**
   * Bounded storage (§5.2): every newly claimed key also drops the expired
   * records of the same (project, operation scope), which the compound unique
   * index prefix serves. Correctness never depends on this running — the
   * request path already treats an expired record as reusable.
   */
  private async pruneExpired(tx: IdempotencyTransaction, target: ClaimTarget): Promise<void> {
    await tx.idempotencyRecord.deleteMany({
      where: {
        projectId: target.projectId,
        operationScope: target.operationScope,
        expiresAt: { lte: target.now },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Replay (phase 8 §4.2.4, §6.7)
  // -------------------------------------------------------------------------

  /**
   * Answers a retry with the stored response, exactly as it was produced — no
   * recomputation, so a replayed body never reflects later state of the
   * resource (§4.2.4). Request-scoped tracing is not part of the stored body:
   * the current request keeps its own request ID (§4.3.2).
   */
  private replay<T>(record: ClaimRecord): { status: number; body: T; replayed: true } {
    if (record.responseStatus === null || record.responseBody === null) {
      // Unreachable: the claim and its response are written by the same
      // transaction, so a committed record always carries its response. A
      // 409 keeps a hypothetical half-written record from being reported as a
      // successful replay, and leaks nothing about the key.
      throw new ApiError(
        ErrorCode.CONFLICT,
        'A request with this Idempotency-Key is still in progress. Retry shortly.',
        409,
      );
    }
    return { status: record.responseStatus, body: record.responseBody as T, replayed: true };
  }

  private afterCommit(execution: { afterCommit?: () => void }): void {
    try {
      execution.afterCommit?.();
    } catch {
      // Post-commit effects (event emission) are best-effort: the mutation is
      // already durable, so a failing sink must not surface as a failed
      // request. Event delivery/persistence is Phase 10.
    }
  }
}

type TransactionOutcome<T> =
  | { status: number; body: T; replayed: false; afterCommit?: () => void }
  | { status: number; body: T; replayed: true };
