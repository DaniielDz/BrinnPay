import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectRefundsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/refunds/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import type { Refund } from '../../lib/brinnpay/client';
import { paymentFixtures, stubPaymentsApi, unstubPaymentsApi } from './payments-test-utils';
import { projectFixture, sessionFixture } from './projects-test-utils';

const { params, search } = vi.hoisted(() => ({ params: vi.fn(), search: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => params(), useSearchParams: () => search(),
  useRouter: () => ({ replace: vi.fn() }),
}));

function stubRefunds(options: { member?: boolean; environment?: string } = {}) {
  const api = stubPaymentsApi({
    session: options.member ? { ...sessionFixture, user: { ...sessionFixture.user, id: 'user-member' } } : undefined,
    payments: options.environment === 'live'
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
        id: `refund-${refunds.length + 1}`, payment_id: paymentId, project_id: projectFixture.id,
        environment: 'test', amount: body.amount ?? '40.00', currency: 'usd', status: 'succeeded',
        reason: body.reason ?? null, created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:00:00Z',
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

afterEach(() => { unstubPaymentsApi(); params.mockReset(); search.mockReset(); });

describe('refund dashboard (Phase 9)', () => {
  it('shows selected payment refunds and submits partial and full bodies without cross-environment mixing', async () => {
    params.mockReturnValue({ projectId: projectFixture.id });
    search.mockReturnValue(new URLSearchParams({ environment: 'test', payment_id: 'pay-2' }));
    const { fetchMock } = stubRefunds();
    render(<AuthProvider><ProjectRefundsPage /></AuthProvider>);
    const form = await screen.findByRole('form', { name: 'Create refund' });
    expect(screen.getByText('Remaining refundable: $40.00')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Refund type'), { target: { value: 'partial' } });
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), { target: { value: '5.50' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: '  retry  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create refund' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/payments/pay-2/refunds',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ amount: '5.50', reason: 'retry' }) }),
    ));
    await screen.findByText('Remaining refundable: $34.50');
    fireEvent.change(within(form).getByLabelText('Refund type'), { target: { value: 'full' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create refund' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/payments/pay-2/refunds',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('environment=test'))).toBe(true);
  });

  it('keeps read-only roles from submitting and refuses a direct payment from another environment', async () => {
    params.mockReturnValue({ projectId: projectFixture.id });
    search.mockReturnValue(new URLSearchParams({ environment: 'live', payment_id: 'pay-2' }));
    stubRefunds({ member: true });
    render(<AuthProvider><ProjectRefundsPage /></AuthProvider>);
    await screen.findByRole('heading', { name: /Refunds/, level: 1 });
    await screen.findByRole('alert');
    expect(screen.getByText('Payment not found in this environment')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create refund' })).not.toBeInTheDocument();
  });
});
