import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RefundCreateDto } from './refund-create.dto';
import { toRefundResponse, type RefundRow } from '../refund-types';

async function validateBody(body: unknown): Promise<boolean> {
  const dto = plainToInstance(RefundCreateDto, body);
  const errors = await validate(dto, { forbidUnknownValues: true });
  return errors.length === 0;
}

const ROW: RefundRow = {
  id: '0192f2a0-0000-7000-8000-0000000000f1',
  paymentId: '0192f2a0-0000-7000-8000-0000000000c1',
  amountMinor: 550n,
  currency: 'usd',
  status: 'succeeded',
  reason: 'customer request',
  createdAt: new Date('2026-09-26T00:00:00.000Z'),
  updatedAt: new Date('2026-09-26T00:00:00.000Z'),
};

describe('refund projection (phase 9 §4.4)', () => {
  it('derives project and environment from the parent payment and formats minor units', () => {
    const body = toRefundResponse(ROW, { projectId: 'proj-1', environment: 'test' });

    expect(body).toEqual({
      id: ROW.id,
      payment_id: ROW.paymentId,
      project_id: 'proj-1',
      environment: 'test',
      amount: '5.50',
      currency: 'usd',
      status: 'succeeded',
      reason: 'customer request',
      created_at: ROW.createdAt,
      updated_at: ROW.updatedAt,
    });
  });

  it('keeps a null reason and never persists or returns minor units', () => {
    const body = toRefundResponse({ ...ROW, amountMinor: 1n, reason: null }, { projectId: 'p', environment: 'live' });
    expect(body.reason).toBeNull();
    expect(body.amount).toBe('0.01');
  });
});

describe('refund create body (phase 9 D1/D4)', () => {
  it('accepts an empty body (full remaining refund, D1)', async () => {
    await expect(validateBody({})).resolves.toBe(true);
  });

  it('accepts a decimal string amount and the usd currency', async () => {
    await expect(validateBody({ amount: '10.00' })).resolves.toBe(true);
    await expect(validateBody({ amount: '0.01' })).resolves.toBe(true);
    await expect(validateBody({ amount: '10.00', currency: 'usd' })).resolves.toBe(true);
  });

  it('rejects non-string, non-decimal and non-positive amounts', async () => {
    await expect(validateBody({ amount: 1000 })).resolves.toBe(false);
    await expect(validateBody({ amount: '-1.00' })).resolves.toBe(false);
    await expect(validateBody({ amount: '1.005' })).resolves.toBe(false);
    await expect(validateBody({ amount: '1.2.3' })).resolves.toBe(false);
    await expect(validateBody({ amount: null })).resolves.toBe(false);
  });

  it('leaves normalization and positivity to the money helper, like PaymentCreate (phase 7 D7)', async () => {
    // `"10"` and `"0.00"` satisfy the shared format regex; `parseAmountMinor`
    // normalizes the first and rejects the second as a 400 field error.
    await expect(validateBody({ amount: '10' })).resolves.toBe(true);
    await expect(validateBody({ amount: '0.00' })).resolves.toBe(true);
  });

  it('rejects a currency other than usd', async () => {
    await expect(validateBody({ currency: 'eur' })).resolves.toBe(false);
  });

  it('trims the reason before the 255-character limit is applied (D4)', async () => {
    const padded = `  ${'r'.repeat(255)}  `;
    const dto = plainToInstance(RefundCreateDto, { reason: padded });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('r'.repeat(255));

    await expect(validateBody({ reason: 'r'.repeat(256) })).resolves.toBe(false);
    await expect(validateBody({ reason: 42 })).resolves.toBe(false);
    await expect(validateBody({ reason: null })).resolves.toBe(false);
  });

  it('trims a whitespace-only reason to empty for the service rule to reject (400)', async () => {
    // Mirrors PaymentCreate's `description`: the boundary trims and the service
    // rejects the blank value, so the client cannot persist an empty reason.
    const dto = plainToInstance(RefundCreateDto, { reason: '   ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('');
  });
});
