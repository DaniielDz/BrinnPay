import { ApiError } from '../../common/errors/api-error';

import {
  resolveDeliveryStatusFilter,
  resolveEventTypeFilter,
} from './webhook-list-query.dto';

/** The 400 `details.fields` messages of a rejected filter value (D15). */
function fieldErrors(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    const details = api.details as { fields?: { errors: string[] }[] } | undefined;
    return (details?.fields ?? []).flatMap((entry) => entry.errors);
  }
  throw new Error('expected a validation error');
}

describe('webhook list filters (phase 10 §4.4, D15)', () => {
  it('an absent type filter returns the unfiltered set', () => {
    expect(resolveEventTypeFilter(undefined)).toBeUndefined();
  });

  it('accepts every catalog type', () => {
    for (const type of ['payment.created', 'payment.succeeded', 'payment.failed', 'refund.created']) {
      expect(resolveEventTypeFilter(type)).toBe(type);
    }
  });

  it('rejects a type outside the closed catalog with a 400 naming the accepted values', () => {
    expect(fieldErrors(() => resolveEventTypeFilter('customer.created'))).toEqual([
      'type must be one of: payment.created, payment.succeeded, payment.failed, refund.created',
    ]);
    // The DTO trims the raw value, so an untrimmed value never reaches the service
    // in the first place; a hand-built one is still rejected rather than stored.
    expect(fieldErrors(() => resolveEventTypeFilter(' payment.created '))).toHaveLength(1);
    expect(fieldErrors(() => resolveEventTypeFilter('payment.processing'))).toHaveLength(1);
  });

  it('an absent status filter returns the unfiltered set', () => {
    expect(resolveDeliveryStatusFilter(undefined)).toBeUndefined();
  });

  it('accepts each contract status and rejects anything else', () => {
    expect(resolveDeliveryStatusFilter('pending')).toBe('pending');
    expect(resolveDeliveryStatusFilter('delivered')).toBe('delivered');
    expect(resolveDeliveryStatusFilter('failed')).toBe('failed');

    expect(fieldErrors(() => resolveDeliveryStatusFilter('retrying'))).toEqual([
      'status must be one of: pending, delivered, failed',
    ]);
    expect(fieldErrors(() => resolveDeliveryStatusFilter('DELIVERED'))).toHaveLength(1);
  });
});
