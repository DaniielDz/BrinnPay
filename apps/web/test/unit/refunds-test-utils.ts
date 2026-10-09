import { vi } from 'vitest';

import type { Refund } from '../../lib/brinnpay/client';
import { paymentFixtures, stubPaymentsApi, unstubPaymentsApi } from './payments-test-utils';
import { projectFixture, sessionFixture } from './projects-test-utils';

/**
 * Composes the payments stub with the `/payments/{id}/refunds` routes the
 * refunds page needs: `POST` creates a succeeded refund, list and detail read
 * from the created set. Non-refund traffic falls through to `stubPaymentsApi`
 * (session restore, payment detail, environment filtering).
 */
export function stubRefunds(options: { member?: boolean; environment?: string } = {}) {
  const api = stubPaymentsApi({
    session: options.member
      ? { ...sessionFixture, user: { ...sessionFixture.user, id: 'user-member' } }
      : undefined,
    payments:
      options.environment === 'live'
        ? [{ ...paymentFixtures[1], id: 'live-pay', environment: 'live' }]
        : [paymentFixtures[1]],
  });
  const fetchPayments = api.fetchMock;
  const refunds: Refund[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const paymentId = path.match(/\/payments\/([^/?]+)\/refunds/)?.[1];
    if (!paymentId) return fetchPayments(url, init);
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status < 400,
      status,
      json: async () => body,
      headers: new Headers(headers),
    });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { amount?: string; reason?: string };
      const created: Refund = {
        id: `refund-${refunds.length + 1}`,
        payment_id: paymentId,
        project_id: projectFixture.id,
        environment: 'test',
        amount: body.amount ?? '40.00',
        currency: 'usd',
        status: 'succeeded',
        reason: body.reason ?? null,
        created_at: '2026-09-26T00:00:00Z',
        updated_at: '2026-09-26T00:00:00Z',
      };
      refunds.push(created);
      return respond(201, created);
    }
    const detail = path.match(/\/refunds\/([^/?]+)/)?.[1];
    if (detail) return respond(200, refunds.find((item) => item.id === detail));
    return respond(200, { data: [...refunds], next_cursor: null, has_more: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, refunds };
}

export function unstubRefunds(): void {
  unstubPaymentsApi();
}
