import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectRefundsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/refunds/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture } from '../unit/projects-test-utils';
import { stubRefunds, unstubRefunds } from '../unit/refunds-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
  useRouter: () => ({ replace: vi.fn() }),
}));

/**
 * Phase 9 flow at smoke level (established jsdom pattern): the environment's
 * payments load inside the session, a payment is selected, and a scripted
 * partial refund updates the detail and the remaining balance. Full browser
 * e2e and multi-tenant flows are covered at the API/browser e2e level
 * (browser tooling is a Phase 17 concern).
 */
describe('refunds smoke test (phase 9 §5.1)', () => {
  afterEach(() => {
    unstubRefunds();
    paramsMock.mockClear();
    searchParamsMock.mockClear();
  });

  it('loads the selected payment and creates a refund in the scripted flow', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    searchParamsMock.mockReturnValue(
      new URLSearchParams({ environment: 'test', payment_id: 'pay-2' }),
    );
    const { fetchMock } = stubRefunds();
    render(
      <AuthProvider>
        <ProjectRefundsPage />
      </AuthProvider>,
    );

    // Load: env badge, owning project, selected payment, refundable balance.
    const form = await screen.findByRole('form', { name: 'Create refund' });
    expect(screen.getByRole('heading', { level: 1, name: /Refunds/ })).toBeInTheDocument();
    expect(screen.getByText('Payments API')).toBeInTheDocument();
    expect(screen.getByText('Remaining refundable: $40.00')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${projectFixture.id}/payments?environment=test`),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );

    // Scripted partial refund → POST → detail and refreshed balance.
    fireEvent.change(within(form).getByLabelText('Refund type'), {
      target: { value: 'partial' },
    });
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), {
      target: { value: '5.50' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create refund' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/payments/pay-2/refunds',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ amount: '5.50' }),
        }),
      );
    });
    await screen.findByText('Remaining refundable: $34.50');
    expect(screen.getByRole('region', { name: 'Refund detail' })).toBeInTheDocument();
    expect(screen.getByText('$5.50 — succeeded')).toBeInTheDocument();
  });
});
