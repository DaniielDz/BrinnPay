import type { PaymentsScope } from '../payments/payments-scope';
import type { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import type { WebhookEventPort } from '../webhooks/webhook-events';
import { RefundsService } from './refunds.service';

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const PAYMENT_ID = '0192f2a0-0000-7000-8000-00000000000d';
const REFUND_ID = '0192f2a0-0000-7000-8000-00000000000e';
const USER_ID = '0192f2a0-0000-7000-8000-00000000000f';

function sessionScope(): PaymentsScope {
  return {
    mode: 'session',
    project: { project_id: PROJECT_ID, organization_id: 'org-1' },
    project_id: PROJECT_ID,
    user_id: USER_ID,
  };
}

describe('RefundsService audit capture (phase 12 §5.4, D13)', () => {
  let audit: { record: jest.Mock; captureAuth: jest.Mock };
  let events: { persist: jest.Mock; dispatch: jest.Mock };
  let payments: { retrieve: jest.Mock };
  let idempotency: { execute: jest.Mock };
  let tx: {
    $queryRaw: jest.Mock;
    payment: { findFirst: jest.Mock };
    refund: { aggregate: jest.Mock; create: jest.Mock };
  };
  let service: RefundsService;

  beforeEach(() => {
    audit = { record: jest.fn(async () => undefined), captureAuth: jest.fn() };
    events = { persist: jest.fn(async () => undefined), dispatch: jest.fn() };
    payments = { retrieve: jest.fn(async () => undefined) };
    tx = {
      $queryRaw: jest.fn(async () => []),
      payment: { findFirst: jest.fn() },
      refund: { aggregate: jest.fn(), create: jest.fn() },
    };
    // The capability owns the transaction: the callback runs with the handle
    // the audit entry must share (D7).
    idempotency = {
      execute: jest.fn(async (_options: unknown, fn: (handle: unknown) => unknown) => fn(tx)),
    };

    service = new RefundsService(
      {} as unknown as PrismaService,
      payments as unknown as PaymentsService,
      idempotency as unknown as IdempotencyService,
      events as unknown as WebhookEventPort,
      audit as never,
    );
  });

  it('records refund.created in the refund transaction, without the reason (D13)', async () => {
    tx.payment.findFirst.mockResolvedValue({
      id: PAYMENT_ID,
      projectId: PROJECT_ID,
      environment: 'test',
      status: 'succeeded',
      amountMinor: 1000n,
      currency: 'usd',
      customerId: null,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: null } });
    tx.refund.create.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amountMinor: 400n,
      currency: 'usd',
      status: 'succeeded',
      reason: 'goodwill gesture for the delay',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.create(
      sessionScope(),
      PAYMENT_ID,
      { amount: '4.00', reason: 'goodwill gesture for the delay' } as never,
      undefined,
      'req_abc',
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'refund.created',
      organization_id: 'org-1',
      actor: { type: 'user', id: USER_ID },
      project_id: PROJECT_ID,
      environment: 'test',
      refund_id: REFUND_ID,
      payment_id: PAYMENT_ID,
      amount: '4.00',
      currency: 'usd',
      request_id: 'req_abc',
    });
    // Same handle as the refund row — commit or roll back together (D7).
    expect(audit.record.mock.calls[0][0]).toBe(tx);
    // D13: the free-text reason never reaches the entry (bounded scalars only).
    expect(JSON.stringify(audit.record.mock.calls[0][1])).not.toContain('goodwill');
    expect(audit.captureAuth).not.toHaveBeenCalled();
  });

  it('records nothing when the payment is not refundable (AC4 — write path never reached)', async () => {
    tx.payment.findFirst.mockResolvedValue({
      id: PAYMENT_ID,
      projectId: PROJECT_ID,
      environment: 'test',
      status: 'pending',
      amountMinor: 1000n,
      currency: 'usd',
      customerId: null,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.create(sessionScope(), PAYMENT_ID, {} as never),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', status: 422 });

    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('attributes API-key mode to the key that acted (§5.6 rule 3)', async () => {
    const apiKeyScope: PaymentsScope = {
      mode: 'api_key',
      key: { key_id: 'key-1', project_id: PROJECT_ID, organization_id: 'org-1', environment: 'test' },
      project_id: PROJECT_ID,
      environment: 'test',
    };
    tx.payment.findFirst.mockResolvedValue({
      id: PAYMENT_ID,
      projectId: PROJECT_ID,
      environment: 'test',
      status: 'succeeded',
      amountMinor: 1000n,
      currency: 'usd',
      customerId: null,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: 200n } });
    tx.refund.create.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amountMinor: 300n,
      currency: 'usd',
      status: 'succeeded',
      reason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.create(apiKeyScope, PAYMENT_ID, { amount: '3.00' } as never, undefined, 'req_xyz');

    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'refund.created',
      organization_id: 'org-1',
      actor: { type: 'api_key', id: 'key-1' },
      request_id: 'req_xyz',
    });
  });

  it('never receives a best-effort outcome capture — refunds are fail-closed (D7)', async () => {
    tx.payment.findFirst.mockResolvedValue({
      id: PAYMENT_ID,
      projectId: PROJECT_ID,
      environment: 'test',
      status: 'succeeded',
      amountMinor: 1000n,
      currency: 'usd',
      customerId: null,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.refund.aggregate.mockResolvedValue({ _sum: { amountMinor: null } });
    tx.refund.create.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amountMinor: 1000n,
      currency: 'usd',
      status: 'succeeded',
      reason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    audit.record.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(service.create(sessionScope(), PAYMENT_ID, {} as never)).rejects.toThrow(
      'audit insert failed',
    );
    expect(audit.captureAuth).not.toHaveBeenCalled();
  });
});
