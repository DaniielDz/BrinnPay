import { WebhookEventService } from './webhook-event.service';
import {
  RECONCILIATION_BATCH,
  REQUEUE_GRACE_MS,
  type WebhookQueueService,
} from './webhook-queue.service';
import { PAYMENT_EVENTS } from '../payments/payment-events';
import type { DomainEvent } from './webhook-events';
import { REFUND_EVENTS } from '../refunds/refund-events';
import type { PrismaService } from '../prisma/prisma.service';

const EVENT: DomainEvent = {
  id: '0198f0c2-0000-7000-8000-00000000000a',
  type: 'payment.created',
  created_at: new Date('2026-09-28T10:00:00.000Z'),
  data: { id: 'pay_1' },
  environment: 'test',
  project_id: '0198f0c2-0000-7000-8000-00000000000b',
  request_id: 'req_origin',
};

const RECONCILIATION_HORIZON_MS = 3_600_000;

interface FakeTx {
  webhookEvent: { createMany: jest.Mock };
  webhookEndpoint: { findMany: jest.Mock };
  webhookDelivery: { createMany: jest.Mock };
}

interface FakePrisma {
  webhookEvent: { findMany: jest.Mock; createMany: jest.Mock };
  webhookDelivery: { findMany: jest.Mock; createMany: jest.Mock };
  $transaction: jest.Mock;
}

function makeTx(endpoints: { id: string }[] = [{ id: 'ep_1' }, { id: 'ep_2' }]): FakeTx {
  return {
    webhookEvent: { createMany: jest.fn(async () => ({ count: 1 })) },
    webhookEndpoint: {
      findMany: jest.fn(async () => endpoints.map((endpoint) => ({ id: endpoint.id }))),
    },
    webhookDelivery: { createMany: jest.fn(async () => ({ count: endpoints.length })) },
  };
}

function makePrisma(tx: FakeTx): FakePrisma {
  return {
    webhookEvent: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    webhookDelivery: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    $transaction: jest.fn(async (fn: (client: FakeTx) => Promise<unknown>) => fn(tx)),
  };
}

function makeQueue(): WebhookQueueService & { enqueueDelivery: jest.Mock } {
  return {
    enqueueDelivery: jest.fn(async () => true),
    ensureRepeatables: jest.fn(async () => undefined),
  } as unknown as WebhookQueueService & { enqueueDelivery: jest.Mock };
}

function setup(tx = makeTx(), prisma = makePrisma(tx), horizonMs = RECONCILIATION_HORIZON_MS) {
  const queue = makeQueue();
  const service = new WebhookEventService(
    prisma as unknown as PrismaService,
    queue,
    { reconciliationHorizonMs: horizonMs } as never,
  );
  return { service, tx, prisma, queue };
}

describe('webhook event persistence (phase 10 §4.1/§4.3/§5.3, D2)', () => {
  describe('transactional persistence (D2)', () => {
    it('writes the event through the caller\'s transaction handle, never its own', async () => {
      const { service, tx, prisma } = setup();

      await service.persist(tx as never, EVENT);

      expect(tx.webhookEvent.createMany).toHaveBeenCalledTimes(1);
      // The event id is supplied by the emitter, so re-persisting is idempotent.
      expect(tx.webhookEvent.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
      expect(tx.webhookEvent.createMany.mock.calls[0][0].data[0]).toEqual(
        expect.objectContaining({ id: EVENT.id, type: EVENT.type, projectId: EVENT.project_id }),
      );
      // Nothing escaped to the ambient client: a rolled-back mutation therefore
      // cannot leave a phantom event behind.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.webhookEvent.createMany).not.toHaveBeenCalled();
    });

    it('stores the phase 1 §9.5 envelope as the payload, with no request id inside it', async () => {
      const { service, tx } = setup();

      await service.persist(tx as never, EVENT);

      const stored = tx.webhookEvent.createMany.mock.calls[0][0].data[0];
      expect(stored.payload).toEqual({
        id: EVENT.id,
        type: EVENT.type,
        created_at: EVENT.created_at.toISOString(),
        data: EVENT.data,
        environment: EVENT.environment,
        project_id: EVENT.project_id,
      });
      expect(JSON.stringify(stored.payload)).not.toContain('req_origin');
    });

    it('is a no-op when the event id already exists (at-least-once safe, §4.3.5)', async () => {
      const tx = makeTx();
      tx.webhookEvent.createMany.mockResolvedValue({ count: 0 });
      const { service } = setup(tx);

      await service.persist(tx as never, EVENT);

      // The deliveries already exist too, so re-persisting must not duplicate them.
      expect(tx.webhookDelivery.createMany).not.toHaveBeenCalled();
    });
  });

  describe('fan-out (§4.3.6)', () => {
    it('matches only same-project, same-environment, enabled, subscribed endpoints', async () => {
      const { service, tx } = setup();

      await service.persist(tx as never, EVENT);

      expect(tx.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: {
          projectId: EVENT.project_id,
          environment: EVENT.environment,
          enabled: true,
          eventTypes: { has: EVENT.type },
        },
        select: { id: true },
      });
    });

    it('creates at most one delivery per matching endpoint, carrying the originating request id', async () => {
      const { service, tx } = setup();

      await service.persist(tx as never, EVENT);

      const call = tx.webhookDelivery.createMany.mock.calls[0][0];
      expect(call.data).toHaveLength(2);
      expect(call.data[0]).toEqual(
        expect.objectContaining({
          endpointId: 'ep_1',
          eventId: EVENT.id,
          status: 'pending',
          attempts: 0,
          responseStatus: null,
          lastError: null,
          nextAttemptAt: expect.any(Date),
          requestId: 'req_origin',
          isReplay: false,
        }),
      );
      // The partial unique index on (event_id, endpoint_id) WHERE is_replay = false
      // is what makes "at most one" hold under concurrency; a lost race is absorbed.
      expect(call.skipDuplicates).toBe(true);
    });

    it('creates no row and no job when nothing matches', async () => {
      const tx = makeTx([]);
      const { service } = setup(tx);

      await service.persist(tx as never, EVENT);

      expect(tx.webhookDelivery.createMany).not.toHaveBeenCalled();
    });

    it('covers every catalog type the domain modules own', async () => {
      for (const type of [...PAYMENT_EVENTS, ...REFUND_EVENTS]) {
        const tx = makeTx();
        const { service } = setup(tx);
        await service.persist(tx as never, { ...EVENT, type });
        expect(tx.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('dispatch is best-effort and never fails the domain request (§4.3.7)', () => {
    it('queues the pending deliveries of a committed event', async () => {
      const { service, prisma, queue } = setup();
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: 'dlv_1', attempts: 0 }]);

      await service.dispatch(EVENT.id);

      expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith({
        where: { eventId: EVENT.id, status: 'pending' },
        select: { id: true, attempts: true },
        take: 500,
      });
      expect(queue.enqueueDelivery).toHaveBeenCalledWith('dlv_1', 1, 0);
    });

    it('swallows a Redis/queue failure so the already-committed request still succeeds', async () => {
      const { service, prisma, queue } = setup();
      prisma.webhookDelivery.findMany.mockRejectedValue(new Error('redis unreachable'));
      queue.enqueueDelivery.mockRejectedValue(new Error('redis unreachable'));

      await expect(service.dispatch(EVENT.id)).resolves.toBeUndefined();
    });
  });

  describe('reconciliation (D2 safety net)', () => {
    it('creates the deliveries an event implies but does not have, without rewriting the envelope', async () => {
      const { service, prisma, tx, queue } = setup();
      prisma.webhookEvent.findMany.mockResolvedValue([
        {
          id: EVENT.id,
          projectId: EVENT.project_id,
          environment: EVENT.environment,
          type: EVENT.type,
          createdAt: EVENT.created_at,
        },
      ]);
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: 'dlv_1', attempts: 0 },
        { id: 'dlv_2', attempts: 0 },
      ]);
      queue.enqueueDelivery.mockResolvedValue(true);

      const created = await service.reconcile();

      expect(created).toBe(2);
      // The stored payload is immutable: reconciliation recomputes only the
      // fan-out, never the envelope.
      expect(prisma.webhookEvent.createMany).not.toHaveBeenCalled();
      expect(tx.webhookDelivery.createMany.mock.calls[0][0].data[0]).toEqual(
        expect.objectContaining({ eventId: EVENT.id, isReplay: false, requestId: null }),
      );
      expect(queue.enqueueDelivery).toHaveBeenCalledTimes(2);
    });

    it('contributes zero for a lost unique-index race rather than failing the pass', async () => {
      const { service, prisma, tx } = setup();
      prisma.webhookEvent.findMany.mockResolvedValue([
        {
          id: EVENT.id,
          projectId: EVENT.project_id,
          environment: EVENT.environment,
          type: EVENT.type,
          createdAt: EVENT.created_at,
        },
      ]);
      tx.webhookDelivery.createMany.mockResolvedValue({ count: 0 });

      await expect(service.reconcile()).resolves.toBe(0);
    });

    it('isolates a poisoned event so one row cannot stall the pass', async () => {
      const { service, prisma } = setup();
      prisma.webhookEvent.findMany.mockResolvedValue([
        { id: 'evt_poison', projectId: EVENT.project_id, environment: 'test', type: EVENT.type, createdAt: EVENT.created_at },
        { id: EVENT.id, projectId: EVENT.project_id, environment: 'test', type: EVENT.type, createdAt: EVENT.created_at },
      ]);
      prisma.$transaction
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockImplementationOnce(async (fn: (client: FakeTx) => Promise<unknown>) => fn(makeTx()));

      await expect(service.reconcile()).resolves.toBeGreaterThan(0);
    });
  });

  describe('the reconciliation pass is bounded and newest-first (D2)', () => {
    // The scan is the only thing standing between a fan-out bug and an unbounded
    // repair, so its shape is asserted directly rather than inferred.
    it('scans newest first inside a [now - horizon, now - minAge] window', async () => {
      const { service, prisma } = setup();
      prisma.webhookEvent.findMany.mockResolvedValue([]);
      const before = Date.now();

      await service.reconcile();

      const query = prisma.webhookEvent.findMany.mock.calls[0][0];
      expect(query.orderBy).toEqual({ createdAt: 'desc' });
      expect(query.take).toBe(RECONCILIATION_BATCH);
      const { gte, lte } = query.where.createdAt as { gte: Date; lte: Date };
      // Oldest bound: the horizon. `>=` is inclusive so the boundary is covered.
      expect(gte.getTime()).toBeLessThanOrEqual(before - RECONCILIATION_HORIZON_MS + 1_000);
      expect(gte.getTime()).toBeGreaterThan(before - RECONCILIATION_HORIZON_MS - 1_000);
      // Newest bound: events younger than the minimum age are excluded, so a
      // just-committed event is never raced by its own reconciliation pass.
      expect(lte.getTime()).toBeGreaterThan(before - 30_000 - 1_000);
      expect(lte.getTime()).toBeLessThanOrEqual(before - 30_000 + 1_000);
    });

    it('uses the configured horizon, not a hard-coded window', async () => {
      const { service, prisma } = setup(makeTx(), makePrisma(makeTx()), 86_400_000);
      prisma.webhookEvent.findMany.mockResolvedValue([]);

      await service.reconcile();

      const { gte } = prisma.webhookEvent.findMany.mock.calls[0][0].where.createdAt as {
        gte: Date;
      };
      expect(Date.now() - gte.getTime()).toBeGreaterThan(86_400_000 - 1_000);
    });

    it('does not starve the newest events once a project exceeds the batch size', async () => {
      // An ascending scan re-reads a frozen prefix of the oldest rows forever, so
      // a genuinely missed delivery for a recent event is never reached.
      const { service, prisma } = setup();
      const oldest = Array.from({ length: RECONCILIATION_BATCH }, (_, index) => ({
        id: `evt_old_${index}`,
        projectId: EVENT.project_id,
        environment: 'test' as const,
        type: EVENT.type,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      }));
      const recent = { ...oldest[0], id: 'evt_recent', createdAt: new Date() };
      // The database honours `orderBy: desc`, so the tail of an oldest-first result
      // set is what a descending query would surface.
      prisma.webhookEvent.findMany.mockResolvedValue([recent, ...oldest]);
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: 'dlv_1', attempts: 0 }]);
      const repaired: string[] = [];
      prisma.$transaction.mockImplementation(async (fn: (client: FakeTx) => Promise<unknown>) => {
        const tx = makeTx();
        tx.webhookEndpoint.findMany.mockResolvedValue([{ id: 'ep_1' }] as { id: string }[]);
        tx.webhookDelivery.createMany.mockImplementation(async (call: { data: { eventId: string }[] }) => {
          repaired.push(...call.data.map((row) => row.eventId));
          return { count: 1 };
        });
        return fn(tx);
      });

      await service.reconcile();

      expect(repaired).toContain('evt_recent');
    });
  });

  describe('requeueing a lost job', () => {
    it('re-queues only deliveries that are already due, with no delay', async () => {
      const { service, prisma, queue } = setup();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: 'dlv_due', attempts: 0 },
        { id: 'dlv_due_retry', attempts: 2 },
      ]);
      queue.enqueueDelivery.mockResolvedValue(true);

      const queued = await service.requeueDueDeliveries();

      expect(queued).toBe(2);
      // `next_attempt_at` is the authoritative schedule, so a delivery that is due
      // is queued immediately and the attempt number is carried by the job id.
      expect(queue.enqueueDelivery).toHaveBeenNthCalledWith(1, 'dlv_due', 1, 0);
      expect(queue.enqueueDelivery).toHaveBeenNthCalledWith(2, 'dlv_due_retry', 3, 0);
    });

    it('waits out the grace window so a merely-waiting job is not duplicated', async () => {
      // The regression this guards: a job that *was* enqueued sits in `wait` while
      // the consumer is busy, and its row is indistinguishable from a stranded
      // one. `deliverJobId` is random, so BullMQ cannot dedupe a re-add — without
      // the grace window every pass would add a second job for the same delivery
      // and both would perform the outbound request.
      const { service, prisma } = setup();
      prisma.webhookDelivery.findMany.mockResolvedValue([]);
      const before = Date.now();

      await service.requeueDueDeliveries();

      const where = prisma.webhookDelivery.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('pending');
      expect(where.OR).toEqual([
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: expect.any(Date) } },
      ]);
      // The bound is the grace window, not `now`: a delivery that became due one
      // second ago is still legitimately in flight and must not be re-queued.
      const lte = (where.OR as { nextAttemptAt: { lte: Date } | null }[])[1].nextAttemptAt!.lte;
      expect(lte.getTime()).toBeLessThanOrEqual(before - REQUEUE_GRACE_MS + 1_000);
      expect(lte.getTime()).toBeGreaterThan(before - REQUEUE_GRACE_MS - 1_000);
    });
  });
});
