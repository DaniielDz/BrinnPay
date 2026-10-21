import { MAX_IDEMPOTENCY_KEY_LENGTH, normalizeIdempotencyKey } from './idempotency-key';
import {
  IDEMPOTENCY_OPERATION_SCOPES,
  isIdempotencyOperationScope,
  PAYMENTS_CREATE_SCOPE,
  REFUNDS_CREATE_SCOPE,
} from './idempotency-operation';

describe('normalizeIdempotencyKey (phase 8 §4.2.2, §6.5)', () => {
  it('returns undefined when the client sent no header (idempotency is optional)', () => {
    expect(normalizeIdempotencyKey(undefined)).toBeUndefined();
  });

  it('accepts an ordinary key unchanged', () => {
    expect(normalizeIdempotencyKey('order_123')).toBe('order_123');
  });

  it('normalizes the value by trimming before it is stored and compared', () => {
    expect(normalizeIdempotencyKey('  order_123  ')).toBe('order_123');
  });

  it('rejects a key that is empty after trimming → 400 VALIDATION_ERROR', () => {
    expect(() => normalizeIdempotencyKey('   ')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
  });

  it('rejects an empty key → 400 VALIDATION_ERROR', () => {
    expect(() => normalizeIdempotencyKey('')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
  });

  it('rejects a key longer than 255 characters → 400 VALIDATION_ERROR', () => {
    expect(() => normalizeIdempotencyKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
  });

  it('accepts a key of exactly 255 characters', () => {
    const key = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(normalizeIdempotencyKey(key)).toBe(key);
  });

  it('reports the failing field without echoing the key value', () => {
    const leaky = `leaky-${'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)}`;
    let details: unknown;
    try {
      normalizeIdempotencyKey(leaky);
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }

    expect(JSON.stringify(details)).toContain('idempotency-key');
    expect(JSON.stringify(details)).not.toContain('leaky-');
  });
});

describe('operation-scope catalog (phase 8 §4.2.1, §4.3.3, ADR-0004)', () => {
  it('activates payments.create and reserves refunds.create for Phase 9', () => {
    expect(PAYMENTS_CREATE_SCOPE).toBe('payments.create');
    expect(REFUNDS_CREATE_SCOPE).toBe('refunds.create');
    expect([...IDEMPOTENCY_OPERATION_SCOPES].sort()).toEqual([
      'payments.create',
      'refunds.create',
    ]);
  });

  it('recognizes catalog values and rejects unknown scopes', () => {
    expect(isIdempotencyOperationScope('payments.create')).toBe(true);
    expect(isIdempotencyOperationScope('refunds.create')).toBe(true);
    expect(isIdempotencyOperationScope('payments.delete')).toBe(false);
    expect(isIdempotencyOperationScope('')).toBe(false);
  });
});
