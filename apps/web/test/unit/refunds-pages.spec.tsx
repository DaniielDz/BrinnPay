import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectRefundsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/refunds/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture } from './projects-test-utils';
import { stubRefunds, unstubRefunds } from './refunds-test-utils';

const { params, search } = vi.hoisted(() => ({ params: vi.fn(), search: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => params(), useSearchParams: () => search(),
  useRouter: () => ({ replace: vi.fn() }),
}));

afterEach(() => { unstubRefunds(); params.mockReset(); search.mockReset(); });

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
