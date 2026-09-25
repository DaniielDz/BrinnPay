import { PrismaService } from '../prisma/prisma.service';
import type { PaymentEvent, PaymentEventSink } from './payment-events';
import { DEFAULT_SIMULATION_DELAYS, type SimulationDelays } from './payment-simulation';
import type { PaymentRow } from './payment-types';
import type { PaymentsScope } from './payments-scope';
import { PaymentsService } from './payments.service';

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const CUSTOMER_ID = '0192f2a0-0000-7000-8000-00000000000c';
const PAYMENT_ID = '0192f2a0-0000-7000-8000-00000000000d';

/** Far enough in the past that both simulation edges are due with the default
 *  delays (relative to the machine clock — deterministic at any run time). */
function past(): Date {
  return new Date(Date.now() - 60_000);
}

function sessionScope(projectId: string = PROJECT_ID): PaymentsScope {
  return {
    mode: 'session',
    project: { project_id: projectId, organization_id: 'org-1' },
    project_id: projectId,
  };
}

function apiKeyScope(environment: 'test' | 'live' = 'test', projectId: string = PROJECT_ID): PaymentsScope {
  return {
    mode: 'api_key',
    key: { key_id: 'key-1', project_id: projectId, environment },
    project_id: projectId,
    environment,
  };
}

function paymentRow(
  overrides: Partial<{
    id: string;
    projectId: string;
    environment: string;
    customerId: string;
    amountMinor: bigint;
    currency: string;
    status: string;
    failureCode: string | null;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
): PaymentRow {
  return {
    id: overrides.id ?? PAYMENT_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    environment: overrides.environment ?? 'test',
    customerId: overrides.customerId ?? CUSTOMER_ID,
    amountMinor: overrides.amountMinor ?? 1000n,
    currency: overrides.currency ?? 'usd',
    status: overrides.status ?? 'pending',
    failureCode: overrides.failureCode ?? null,
    description: overrides.description ?? null,
    createdAt: overrides.createdAt ?? past(),
    updatedAt: overrides.updatedAt ?? past(),
  };
}

interface Sink {
  emit: jest.Mock;
}

function setup(prisma: unknown, delays: SimulationDelays = DEFAULT_SIMULATION_DELAYS): {
  service: PaymentsService;
  sink: Sink;
} {
  const sink: Sink = { emit: jest.fn() };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    { emit: sink.emit } as unknown as PaymentEventSink,
    delays,
  );
  return { service, sink };
}

describe('PaymentsService (phase 7 §4.2/§4.6/§4.7, D1/D2/D3/D6/D7/D10)', () => {
  let prisma: {
    payment: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
    customer: { findFirst: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      payment: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
      customer: { findFirst: jest.fn() },
    };
  });

  describe('list (§4.2/§4.5, D1)', () => {
    it('session mode without an explicit environment → 400 VALIDATION_ERROR', async () => {
      const { service } = setup(prisma);

      await expect(service.list(sessionScope(), {})).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { fields: [{ field: 'environment', errors: expect.any(Array) }] },
      });
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('session mode: lists the project+environment (cursor-scoped, paginated)', async () => {
      const rows = [
        paymentRow({ status: 'succeeded', environment: 'live' }),
        paymentRow({ id: PAYMENT_ID.replace('0d', '0e'), environment: 'live' }),
      ];
      prisma.payment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      const { service } = setup(prisma);

      const page = await service.list(sessionScope(), { environment: 'live', limit: 1 });

      // catch-up query first (no due rows), page query second.
      expect(prisma.payment.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { projectId: PROJECT_ID, environment: 'live', status: { in: ['pending', 'processing'] } },
        }),
      );
      expect(prisma.payment.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { projectId: PROJECT_ID, environment: 'live' },
          take: 2, // limit + 1
        }),
      );
      expect(page).toMatchObject({ has_more: true, next_cursor: rows[0].id });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        project_id: PROJECT_ID,
        environment: 'live',
        amount: '10.00',
        status: 'succeeded',
      });
    });

    it('api-key mode: derives the environment from the key and passes a cursor through', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      const { service } = setup(prisma);

      await service.list(apiKeyScope('live'), { cursor: 'previous-id' });

      expect(prisma.payment.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { projectId: PROJECT_ID, environment: 'live', id: { gt: 'previous-id' } },
          take: 21, // DEFAULT_LIST_LIMIT + 1
        }),
      );
    });

    it('api-key mode: rejects a conflicting explicit environment → 422 BUSINESS_RULE_VIOLATION', async () => {
      const { service } = setup(prisma);

      await expect(service.list(apiKeyScope('test'), { environment: 'live' })).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
      });
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('advances every due non-terminal payment before assembling the page (D2)', async () => {
      const processing = paymentRow({ status: 'processing' });
      prisma.payment.findMany
        .mockResolvedValueOnce([processing])
        .mockResolvedValueOnce([paymentRow({ status: 'succeeded' })]);
      // Both edges due: pending→processing, processing→succeeded.
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'succeeded' }));
      const { service } = setup(prisma);

      const page = await service.list(sessionScope(), { environment: 'test' });

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID, status: 'processing' },
        data: { status: 'succeeded', updatedAt: expect.any(Date) },
      });
      expect(page.data[0]).toMatchObject({ status: 'succeeded' });
    });
  });

  describe('create (§4.2, D1/D2/D3/D6/D7/D9/D10)', () => {
    it('creates a pending payment for the addressed project and emits payment.created', async () => {
      const now = past();
      jest.useFakeTimers().setSystemTime(now);
      prisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
      prisma.payment.create.mockImplementation(async ({ data }) => ({
        id: data.id,
        projectId: data.projectId,
        environment: data.environment,
        customerId: data.customerId,
        amountMinor: data.amountMinor,
        currency: data.currency,
        status: data.status,
        failureCode: data.failureCode,
        description: data.description,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      }));
      const { service, sink } = setup(prisma);

      const payment = await service.create(
        sessionScope(),
        { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
      );

      jest.useRealTimers();
      expect(prisma.customer.findFirst).toHaveBeenCalledWith({
        where: { id: CUSTOMER_ID, projectId: PROJECT_ID }, // session: project-only (D3)
        select: { id: true },
      });
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: PROJECT_ID,
          environment: 'test',
          customerId: CUSTOMER_ID,
          amountMinor: 1000n,
          currency: 'usd',
          status: 'pending',
        }),
      });
      expect(payment).toMatchObject({ status: 'pending', amount: '10.00', currency: 'usd' });
      expect(sink.emit).toHaveBeenCalledTimes(1);
      const event = sink.emit.mock.calls[0][0] as PaymentEvent;
      expect(event).toMatchObject({
        type: 'payment.created',
        environment: 'test',
        project_id: PROJECT_ID,
      });
      expect(event.data).toMatchObject({ id: expect.any(String), status: 'pending' });
    });

    it('api-key mode: requires the body environment to equal the key environment (422)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          apiKeyScope('live'),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });

    it('api-key mode: scopes the customer lookup to the key environment (D3)', async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
      prisma.payment.create.mockResolvedValue(paymentRow());
      const { service } = setup(prisma);

      await service.create(
        apiKeyScope('live'),
        { environment: 'live', customer_id: CUSTOMER_ID, amount: '1.00', currency: 'usd' },
      );

      expect(prisma.customer.findFirst).toHaveBeenCalledWith({
        where: { id: CUSTOMER_ID, projectId: PROJECT_ID, environment: 'live' },
        select: { id: true },
      });
    });

    it('returns 404 (non-disclosure) for an unknown customer (D3)', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('rejects an Idempotency-Key that is empty after trimming → 400 field error (D6)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
          '   ',
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { fields: [{ field: 'idempotency-key', errors: expect.any(Array) }] },
      });
    });

    it('rejects an Idempotency-Key longer than 255 characters → 400 field error (D6)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
          'k'.repeat(256),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    });

    it('accepts a valid Idempotency-Key without using its value (D6)', async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
      prisma.payment.create.mockResolvedValue(paymentRow());
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
          'order_123',
        ),
      ).resolves.toMatchObject({ status: 'pending' });
    });

    it('rejects a zero amount → 400 field error on amount (D7)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '0', currency: 'usd' },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { fields: [{ field: 'amount', errors: ['Amount must be greater than zero'] }] },
      });
    });

    it('rejects a non-usd currency defensively → 400 field error (ADR-0003)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'eur' as 'usd' },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { fields: [{ field: 'currency', errors: expect.any(Array) }] },
      });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('trims the description and stores null when absent (D9)', async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
      prisma.payment.create.mockImplementation(async ({ data }) => paymentRow({ description: data.description }));
      const { service } = setup(prisma);

      await service.create(
        sessionScope(),
        { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd', description: '  Summer plan  ' },
      );
      await service.create(
        sessionScope(),
        { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd' },
      );

      expect(prisma.payment.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ data: expect.objectContaining({ description: 'Summer plan' }) }),
      );
      expect(prisma.payment.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: expect.objectContaining({ description: null }) }),
      );
    });

    it('rejects a whitespace-only description → 400 field error (D9)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd', description: '   ' },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { fields: [{ field: 'description', errors: expect.any(Array) }] },
      });
    });

    it('rejects a description longer than 500 characters → 400 field error (D9)', async () => {
      const { service } = setup(prisma);

      await expect(
        service.create(
          sessionScope(),
          { environment: 'test', customer_id: CUSTOMER_ID, amount: '10.00', currency: 'usd', description: 'x'.repeat(501) },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    });
  });

  describe('retrieve (§4.2, D2/D12)', () => {
    it('returns 404 for a malformed payment id without querying', async () => {
      const { service } = setup(prisma);

      await expect(service.retrieve(sessionScope(), 'not-a-uuid')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('returns 404 for a payment of another project (non-disclosure)', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      const { service } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAYMENT_ID, projectId: PROJECT_ID } }),
      );
    });

    it('api-key mode: returns 404 for a payment of another environment (non-disclosure, D1/D12)', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);
      const { service } = setup(prisma);

      await expect(service.retrieve(apiKeyScope('test'), PAYMENT_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAYMENT_ID, projectId: PROJECT_ID, environment: 'test' } }),
      );
    });

    it('session mode: no environment filter — the payment id is the address (D12)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentRow({ environment: 'live', status: 'succeeded' }));
      const { service } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).resolves.toMatchObject({
        environment: 'live',
        status: 'succeeded',
      });
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAYMENT_ID, projectId: PROJECT_ID } }),
      );
    });

    it('advances a due non-terminal payment and returns the authoritative state (D2)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentRow({ status: 'pending' }));
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'succeeded' }));
      const { service, sink } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).resolves.toMatchObject({
        status: 'succeeded',
      });
      // pending→processing (no event), then processing→succeeded (event).
      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(2);
      expect(sink.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment.succeeded' }),
      );
      expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.created' }));
    });

    it('CAS loss under contention: stops advancing and re-reads the authoritative row (D2)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentRow({ status: 'pending' }));
      // Nobody wins the first edge: a concurrent writer already applied it.
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'processing' }));
      const { service, sink } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).resolves.toMatchObject({
        status: 'processing',
      });
      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(1);
      expect(sink.emit).not.toHaveBeenCalled();
      expect(prisma.payment.findUnique).toHaveBeenCalledWith({ where: { id: PAYMENT_ID } });
    });

    it('terminal states are absorbing — no writes, no events, no re-read (D2)', async () => {
      const succeeded = paymentRow({ status: 'succeeded' });
      prisma.payment.findFirst.mockResolvedValue(succeeded);
      const { service, sink } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
      expect(sink.emit).not.toHaveBeenCalled();
    });

    it('only emits the terminal event when this call won the CAS — nothing on a lost edge', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'succeeded' }));
      const { service, sink } = setup(prisma);

      await expect(service.retrieve(sessionScope(), PAYMENT_ID)).resolves.toMatchObject({
        status: 'succeeded',
      });
      // Lost the processing→succeeded edge: the event is the winner's, never ours.
      expect(sink.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment.succeeded' }),
      );
    });

    it('the default simulation never reaches failed — that edge needs an explicit outcome (D2)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'succeeded' }));
      const { service, sink } = setup(prisma);

      await service.retrieve(sessionScope(), PAYMENT_ID);

      expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.succeeded' }));
      expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
      // The `failed` outcome itself is exercised by the engine unit tests
      // (payment-simulation.spec.ts) and wired via the `outcome` parameter of
      // `scheduledTransition` for future sandbox features.
    });
  });
});