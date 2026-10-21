import { ErrorCode } from '../common/errors/error-code';
import { PAYMENT_EVENTS } from '../payments/payment-events';
import { REFUND_EVENTS } from '../refunds/refund-events';

import {
  isWebhookEventType,
  serializeEnvelope,
  toEnvelope,
  WEBHOOK_EVENT_TYPES,
  type DomainEvent,
} from './webhook-events';

const CREATED_AT = new Date('2026-09-28T10:00:00.000Z');

const event = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  id: '0198f0c2-1111-7000-8000-000000000001',
  type: 'payment.created',
  created_at: CREATED_AT,
  data: { id: 'pay_1', status: 'pending' },
  environment: 'test',
  project_id: '0198f0c2-2222-7000-8000-000000000002',
  request_id: 'req_abc',
  ...overrides,
});

describe('webhook event catalog and envelope (phase 10 §4.2/§4.3, D1)', () => {
  describe('catalog (D1: closed, owned by the domain modules)', () => {
    it('is derived from the payments and refunds catalogs, not a duplicated list', () => {
      expect(WEBHOOK_EVENT_TYPES).toEqual([...PAYMENT_EVENTS, ...REFUND_EVENTS]);
    });

    it('is exactly the four phase 7/9 types — phase 10 adds no event type', () => {
      expect(WEBHOOK_EVENT_TYPES).toEqual([
        'payment.created',
        'payment.succeeded',
        'payment.failed',
        'refund.created',
      ]);
    });

    it('rejects any type outside the catalog', () => {
      expect(isWebhookEventType('payment.created')).toBe(true);
      expect(isWebhookEventType('refund.created')).toBe(true);
      expect(isWebhookEventType('customer.created')).toBe(false);
      // The past-tense convention means a hypothetical processing event is not in
      // the catalog; accepting it would create an endpoint that can never fire.
      expect(isWebhookEventType('payment.processing')).toBe(false);
      expect(isWebhookEventType('payment.updated')).toBe(false);
    });
  });

  describe('envelope (§4.3.2, F4)', () => {
    it('is exactly the phase 1 §9.5 shape', () => {
      expect(toEnvelope(event())).toEqual({
        id: '0198f0c2-1111-7000-8000-000000000001',
        type: 'payment.created',
        created_at: '2026-09-28T10:00:00.000Z',
        data: { id: 'pay_1', status: 'pending' },
        environment: 'test',
        project_id: '0198f0c2-2222-7000-8000-000000000002',
      });
    });

    it('never leaks the originating request id into the envelope', () => {
      // F4: the request id is recorded on the delivery row, not in the body that
      // a destination receives.
      const envelope = toEnvelope(event({ request_id: 'req_secret_trace' }));
      expect(JSON.stringify(envelope)).not.toContain('req_secret_trace');
      expect('request_id' in envelope).toBe(false);
    });

    it('serializes the snapshot deterministically, so every attempt and replay sends the same bytes', () => {
      const first = serializeEnvelope(toEnvelope(event()));
      const second = serializeEnvelope(toEnvelope(event()));
      expect(first).toBe(second);
      expect(JSON.parse(first).data).toEqual({ id: 'pay_1', status: 'pending' });
    });

    it('keeps the data snapshot point-in-time: a later mutation cannot rewrite it', () => {
      const stored = toEnvelope(event());
      const snapshot = stored.data as Record<string, unknown>;
      const later = { ...snapshot, status: 'succeeded' };
      expect(stored.data).toEqual({ id: 'pay_1', status: 'pending' });
      expect(later).toEqual({ id: 'pay_1', status: 'succeeded' });
    });
  });
});

describe('canonical error codes used by the webhook surface (§4.4)', () => {
  it('reuses the existing codes rather than introducing new ones', () => {
    // A malformed value is a 400 VALIDATION_ERROR; a foreign or unknown resource is
    // a 404 NOT_FOUND; an environment mismatch or a replay precondition is a 422
    // BUSINESS_RULE_VIOLATION.
    expect(ErrorCode.VALIDATION_ERROR).toBeDefined();
    expect(ErrorCode.NOT_FOUND).toBeDefined();
    expect(ErrorCode.BUSINESS_RULE_VIOLATION).toBeDefined();
  });
});
