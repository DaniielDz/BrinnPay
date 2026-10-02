import { Test } from '@nestjs/testing';

import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookMaintenanceService } from './webhook-maintenance.service';
import {
  provideDeliveryPolicy,
  WebhookQueueService,
  WEBHOOK_DELIVERY_POLICY,
  type WebhookDeliveryPolicy,
} from './webhook-queue.service';

const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Mirrors the batch constants so the paging assertions track the real ones. */
const CLEANUP_BATCH = 500;
const CLEANUP_MAX_PAGES = 20;

/** The policy as the configuration factory builds it, with a one-day window. */
const POLICY: WebhookDeliveryPolicy = provideDeliveryPolicy({
  get: (key: string) => (key === 'webhooks.eventRetentionDays' ? 1 : undefined),
} as never);

describe('WebhookMaintenanceService', () => {
  let service: WebhookMaintenanceService;
  let prisma: { webhookEvent: { findMany: jest.Mock; deleteMany: jest.Mock } };
  let events: { reconcile: jest.Mock; requeueDueDeliveries: jest.Mock };
  let queue: { ensureRepeatables: jest.Mock };
  let payments: { advanceDuePayments: jest.Mock };

  beforeEach(async () => {
    prisma = {
      webhookEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    events = {
      reconcile: jest.fn().mockResolvedValue(0),
      requeueDueDeliveries: jest.fn().mockResolvedValue(0),
    };
    queue = { ensureRepeatables: jest.fn().mockResolvedValue(undefined) };
    payments = { advanceDuePayments: jest.fn().mockResolvedValue(0) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookMaintenanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: WebhookEventService, useValue: events },
        { provide: WebhookQueueService, useValue: queue },
        { provide: PaymentsService, useValue: payments },
        { provide: WEBHOOK_DELIVERY_POLICY, useValue: POLICY },
      ],
    }).compile();

    service = moduleRef.get(WebhookMaintenanceService);
  });

  it('runs both halves of the reconciliation pass and reports their counts', async () => {
    events.reconcile.mockResolvedValue(3);
    events.requeueDueDeliveries.mockResolvedValue(2);

    await expect(service.reconcile()).resolves.toEqual({ created: 3, requeued: 2 });
    expect(events.reconcile).toHaveBeenCalledTimes(1);
    expect(events.requeueDueDeliveries).toHaveBeenCalledTimes(1);
  });

  it('drives the payment advancement once per pass, with the pass timestamp', async () => {
    payments.advanceDuePayments.mockResolvedValue(4);
    const before = Date.now();

    await expect(service.advancePayments()).resolves.toBe(4);
    expect(payments.advanceDuePayments).toHaveBeenCalledTimes(1);
    const [now] = payments.advanceDuePayments.mock.calls[0] as [Date];
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('swallows a failed advancement pass so one bad pass cannot stall the schedule', async () => {
    payments.advanceDuePayments.mockRejectedValue(new Error('database is down'));

    await expect(service.advancePayments()).resolves.toBe(0);
  });

  it('deletes only the events that are past the retention window', async () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    prisma.webhookEvent.findMany.mockResolvedValue([{ id: 'evt_1' }, { id: 'evt_2' }]);
    prisma.webhookEvent.deleteMany.mockResolvedValue({ count: 2 });

    await expect(service.cleanupExpired(now)).resolves.toBe(2);
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { lt: cutoff } } }),
    );
    // Deleted by id, in a bounded page, rather than as one unbounded DELETE.
    expect(prisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['evt_1', 'evt_2'] } },
    });
  });

  it('pages through a backlog instead of deleting it all in one statement', async () => {
    // A pass that was off for a week hands one DELETE the whole backlog; cascading
    // into webhook_deliveries inside a single statement holds row locks for the
    // entire set. Each page is a separate short statement, and a partial page
    // means nothing older is left.
    const fullPage = Array.from({ length: CLEANUP_BATCH }, (_, index) => ({ id: `evt_${index}` }));
    prisma.webhookEvent.findMany
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ id: 'evt_last' }]);
    prisma.webhookEvent.deleteMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) => ({
        count: where.id.in.length,
      }),
    );

    await expect(service.cleanupExpired()).resolves.toBe(CLEANUP_BATCH + 1);
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.webhookEvent.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('stops at the page ceiling so a huge backlog carries over to the next pass', async () => {
    prisma.webhookEvent.findMany.mockResolvedValue(
      Array.from({ length: CLEANUP_BATCH }, (_, index) => ({ id: `evt_${index}` })),
    );
    prisma.webhookEvent.deleteMany.mockResolvedValue({ count: CLEANUP_BATCH });

    await expect(service.cleanupExpired()).resolves.toBe(CLEANUP_BATCH * CLEANUP_MAX_PAGES);
    expect(prisma.webhookEvent.findMany).toHaveBeenCalledTimes(CLEANUP_MAX_PAGES);
  });

  it('reports zero removals when nothing has expired', async () => {
    await expect(service.cleanupExpired()).resolves.toBe(0);
    expect(prisma.webhookEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('swallows a failed cleanup pass and reports what it already removed', async () => {
    prisma.webhookEvent.findMany
      .mockResolvedValueOnce([{ id: 'evt_1' }])
      .mockRejectedValueOnce(new Error('deadlock detected'));
    prisma.webhookEvent.deleteMany.mockResolvedValue({ count: 1 });

    // The first page's deletion really happened, so the count must not claim zero.
    await expect(service.cleanupExpired()).resolves.toBe(1);
  });

  it('registers the repeatables at worker boot', async () => {
    await service.registerSchedule();

    expect(queue.ensureRepeatables).toHaveBeenCalledTimes(1);
  });
});
