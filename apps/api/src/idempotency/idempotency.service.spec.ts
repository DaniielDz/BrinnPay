import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  IdempotencyService,
  type IdempotentExecution,
} from './idempotency.service';

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const OTHER_PROJECT_ID = '0192f2a0-0000-7000-8000-0000000000ff';

interface StoredRow {
  id: string;
  projectId: string;
  operationScope: string;
  idempotencyKey: string;
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/**
 * In-memory stand-in for the `idempotency_records` table that reproduces the
 * database behavior the claim relies on: the compound unique tuple rejects a
 * duplicate claim (`ON CONFLICT DO NOTHING`), a transaction rolls back
 * completely when the mutation throws, and every statement sees committed
 * state. Real concurrency (parallel transactions racing for one key) is proved
 * against PostgreSQL in `test/idempotency.e2e-spec.ts`; here the loser path is
 * exercised by a committed record left by an earlier execution.
 */
function createFakePrisma() {
  const rows: StoredRow[] = [];

  const matches = (where: Record<string, unknown>, row: StoredRow): boolean =>
    Object.entries(where).every(([field, condition]) => {
      const value = (row as unknown as Record<string, unknown>)[field];
      if (condition !== null && typeof condition === 'object') {
        const operators = condition as { lte?: Date; lte_: Date };
        return operators.lte !== undefined && value instanceof Date && value <= operators.lte;
      }
      return value === condition;
    });

  const tx = {
    idempotencyRecord: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        const duplicate = rows.some(
          (row) =>
            row.projectId === data.projectId &&
            row.operationScope === data.operationScope &&
            row.idempotencyKey === data.idempotencyKey,
        );
        if (skipDuplicates && duplicate) {
          return { count: 0 };
        }
        rows.push({ ...data, responseStatus: null, responseBody: null });
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.projectId_operationScope_idempotencyKey;
        const row = rows.find(
          (entry) =>
            entry.projectId === key.projectId &&
            entry.operationScope === key.operationScope &&
            entry.idempotencyKey === key.idempotencyKey,
        );
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (!row) {
          throw new Error(`no row ${where.id}`);
        }
        Object.assign(row, data);
        return { ...row };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        const kept = rows.filter((row) => !matches(where, row));
        rows.splice(0, rows.length, ...kept);
        return { count: before - kept.length };
      }),
    },
  };

  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        return await fn(tx);
      } catch (error) {
        // Interactive transactions roll back completely on failure.
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    }),
  };

  return { prisma, tx, rows };
}

function setup(retentionMs: number = DEFAULT_IDEMPOTENCY_RETENTION_MS) {
  const fake = createFakePrisma();
  const service = new IdempotencyService(
    fake.prisma as unknown as PrismaService,
    { retentionMs },
  );
  return { service, ...fake };
}

const SUCCESS = { status: 201, body: { id: 'pay-1', status: 'pending' } };

const mutation = (execution: IdempotentExecution<unknown> = SUCCESS) =>
  jest.fn(async () => execution);

describe('IdempotencyService (phase 8 §4.2/§4.4, D2/D3/D4/D5)', () => {
  describe('header validation runs before anything else (§4.2.6, §6.5)', () => {
    it('rejects an unusable key with 400 and never opens a transaction', async () => {
      const { service, prisma } = setup();
      const run = mutation();

      await expect(
        service.execute(
          { projectId: PROJECT_ID, operationScope: 'payments.create', key: '   ' },
          run,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('without a key the mutation is a normal execution (§4.2.2)', () => {
    it('runs the mutation once, stores nothing, and reports no replay', async () => {
      const { service, tx } = setup();
      const afterCommit = jest.fn();
      const run = mutation({ ...SUCCESS, afterCommit });

      const result = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: undefined },
        run,
      );

      expect(result).toEqual({ status: 201, body: SUCCESS.body, replayed: false });
      expect(run).toHaveBeenCalledTimes(1);
      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(tx.idempotencyRecord.createMany).not.toHaveBeenCalled();
      expect(tx.idempotencyRecord.update).not.toHaveBeenCalled();
    });

    it('runs the mutation outside an interactive transaction', async () => {
      const { service, prisma, tx } = setup();
      const run = mutation();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: undefined },
        run,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      // The handler receives a usable client (the root one here).
      expect(run).toHaveBeenCalledWith(prisma);
      expect(run).not.toHaveBeenCalledWith(tx);
    });
  });

  describe('first use claims the key and stores the response (§4.3.1, D3)', () => {
    it('claims (project, operation_scope, key) and stores the response projection', async () => {
      const { service, tx, rows } = setup();
      const afterCommit = jest.fn();
      const run = mutation({ ...SUCCESS, afterCommit });

      const result = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: ' order_1 ' },
        run,
      );

      expect(result).toEqual({ status: 201, body: SUCCESS.body, replayed: false });
      const claim = tx.idempotencyRecord.createMany.mock.calls[0][0];
      expect(claim.data).toMatchObject({
        projectId: PROJECT_ID,
        operationScope: 'payments.create',
        idempotencyKey: 'order_1', // normalized (trimmed)
      });
      // The claim is inserted without a response; the response is completed by
      // an update inside the same transaction.
      expect(claim.data).not.toHaveProperty('responseStatus');
      expect(claim.data).not.toHaveProperty('responseBody');
      expect(claim.skipDuplicates).toBe(true);
      // Retention window: expires_at = created_at + 24h (ADR-0004).
      expect(claim.data.expiresAt.getTime() - claim.data.createdAt.getTime()).toBe(
        DEFAULT_IDEMPOTENCY_RETENTION_MS,
      );
      // The response is completed by an update inside the same transaction.
      expect(tx.idempotencyRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: rows[0].id },
          data: expect.objectContaining({ responseStatus: 201, responseBody: SUCCESS.body }),
        }),
      );
      expect(rows[0]).toMatchObject({ responseStatus: 201, responseBody: SUCCESS.body });
      expect(afterCommit).toHaveBeenCalledTimes(1);
    });

    it('serializes the response projection, never a raw row (no BigInt/Date leakage)', async () => {
      const { service, tx } = setup();
      const body = { id: 'pay-1', amount: '10.00', created_at: new Date('2026-09-25T10:00:00Z') };

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ status: 201, body }),
      );

      const stored = tx.idempotencyRecord.update.mock.calls[0][0].data.responseBody;
      expect(stored).toEqual({ ...body, created_at: '2026-09-25T10:00:00.000Z' });
    });

    it('stores no request-scoped tracing data, so a replay cannot carry it (§4.3.2)', async () => {
      const { service, tx } = setup();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ status: 201, body: { id: 'pay-1' } }),
      );

      const stored = tx.idempotencyRecord.update.mock.calls[0][0].data;
      expect(Object.keys(stored)).toEqual(
        expect.not.arrayContaining(['requestId', 'request_id', 'headers']),
      );
      expect(stored.responseBody).toEqual({ id: 'pay-1' });
    });
  });

  describe('retry inside the retention window replays (§4.2.4, D3)', () => {
    it('returns the stored status/body without re-running the mutation', async () => {
      const { service, tx, rows } = setup();
      const first = mutation({ ...SUCCESS, afterCommit: jest.fn() });
      const second = mutation();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        first,
      );
      const replay = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        second,
      );

      expect(replay).toEqual({ status: 201, body: SUCCESS.body, replayed: true });
      expect(second).not.toHaveBeenCalled();
      // No second side effect: exactly one stored record, completed once.
      expect(rows).toHaveLength(1);
      expect(tx.idempotencyRecord.update).toHaveBeenCalledTimes(1);
    });

    it('does not run the after-commit side effects of a replay', async () => {
      const { service } = setup();
      const afterCommit = jest.fn();
      const replayAfterCommit = jest.fn();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ ...SUCCESS, afterCommit }),
      );
      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ ...SUCCESS, afterCommit: replayAfterCommit }),
      );

      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(replayAfterCommit).not.toHaveBeenCalled();
    });

    it('replays the stored snapshot even when the resource moved on (§4.2.4)', async () => {
      const { service, rows } = setup();
      const created = new Date('2026-09-25T10:00:00.000Z');

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ status: 201, body: { id: 'pay-1', status: 'pending', created_at: created } }),
      );
      // The payment later advanced (the simulation owns that state machine).
      rows[0].responseBody = { id: 'pay-1', status: 'succeeded', created_at: created };

      const replay = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation(),
      );

      expect(replay).toEqual({
        status: 201,
        body: { id: 'pay-1', status: 'succeeded', created_at: created },
        replayed: true,
      });
    });
  });

  describe('scope of uniqueness (project, operation_scope, key) — ADR-0004', () => {
    it('does not collide across projects for the same key', async () => {
      const { service, rows } = setup();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation(),
      );
      const other = await service.execute(
        { projectId: OTHER_PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation({ status: 201, body: { id: 'pay-2' } }),
      );

      expect(other).toEqual({ status: 201, body: { id: 'pay-2' }, replayed: false });
      expect(rows).toHaveLength(2);
    });

    it('does not collide across operation scopes of the same project', async () => {
      const { service, rows } = setup();

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation(),
      );
      const refundScope = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'refunds.create', key: 'order_1' },
        mutation({ status: 201, body: { id: 'ref-1' } }),
      );

      expect(refundScope).toEqual({ status: 201, body: { id: 'ref-1' }, replayed: false });
      expect(rows.map((row) => row.operationScope).sort()).toEqual([
        'payments.create',
        'refunds.create',
      ]);
    });
  });

  describe('post-expiry reuse is a new operation (D5, §5.2)', () => {
    it('frees the expired record, executes the mutation again, and keeps one row', async () => {
      const { service, tx, rows } = setup();
      const first = mutation();
      const afterExpiry = mutation({ status: 201, body: { id: 'pay-2' } });

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        first,
      );
      // The stored window has passed (asynchronous cleanup has not run yet).
      rows[0].expiresAt = new Date(Date.now() - 1_000);
      const reused = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        afterExpiry,
      );

      expect(reused).toEqual({ status: 201, body: { id: 'pay-2' }, replayed: false });
      expect(afterExpiry).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ responseBody: { id: 'pay-2' } });
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      // The expired row was removed inside the claim transaction.
      expect(tx.idempotencyRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: PROJECT_ID,
            operationScope: 'payments.create',
            expiresAt: expect.objectContaining({ lte: expect.any(Date) }),
          }),
        }),
      );
    });

    it('keeps storage bounded by pruning expired records of the same scope', async () => {
      const { service, rows } = setup();
      const stale = new Date(Date.now() - 60_000);
      rows.push({
        id: 'stale-1',
        projectId: PROJECT_ID,
        operationScope: 'payments.create',
        idempotencyKey: 'old_1',
        responseStatus: 201,
        responseBody: { id: 'pay-old' },
        createdAt: stale,
        updatedAt: stale,
        expiresAt: new Date(stale.getTime() + 1_000),
      });

      await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation(),
      );

      expect(rows.map((row) => row.idempotencyKey)).toEqual(['order_1']);
    });
  });

  describe('atomic failure handling (§4.4.4, §6.8)', () => {
    it('leaves no committed record and lets a later retry execute as a fresh operation', async () => {
      const { service, rows } = setup();
      const failing = jest.fn(async () => {
        throw new Error('mutation failed');
      });

      await expect(
        service.execute(
          { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
          failing,
        ),
      ).rejects.toThrow('mutation failed');
      expect(rows).toHaveLength(0);

      const retry = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
        mutation(),
      );

      expect(retry).toEqual({ status: 201, body: SUCCESS.body, replayed: false });
      expect(rows).toHaveLength(1);
    });

    it('never stores a failure response as replayable', async () => {
      const { service, tx } = setup();

      await expect(
        service.execute(
          { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
          async () => {
            throw new Error('boom');
          },
        ),
      ).rejects.toThrow('boom');

      expect(tx.idempotencyRecord.update).not.toHaveBeenCalled();
    });

    it('does not let a failing post-commit effect fail the committed request', async () => {
      const { service } = setup();

      const result = await service.execute(
        { projectId: PROJECT_ID, operationScope: 'payments.create', key: undefined },
        mutation({
          ...SUCCESS,
          afterCommit: () => {
            throw new Error('sink down');
          },
        }),
      );

      expect(result.replayed).toBe(false);
    });
  });

  describe('defensive handling of an incomplete record (§6.7)', () => {
    it('answers 409 CONFLICT instead of reporting a half-written record as replayed', async () => {
      const { service, rows } = setup();
      const stale = new Date();
      rows.push({
        id: 'incomplete-1',
        projectId: PROJECT_ID,
        operationScope: 'payments.create',
        idempotencyKey: 'order_1',
        responseStatus: null,
        responseBody: null,
        createdAt: stale,
        updatedAt: stale,
        expiresAt: new Date(stale.getTime() + 3_600_000),
      });
      const run = mutation();

      await expect(
        service.execute(
          { projectId: PROJECT_ID, operationScope: 'payments.create', key: 'order_1' },
          run,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(run).not.toHaveBeenCalled();
    });
  });
});
