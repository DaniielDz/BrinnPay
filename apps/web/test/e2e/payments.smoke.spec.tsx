import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import ProjectPaymentsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/payments/page';
import { paymentFixtures, stubPaymentsApi, unstubPaymentsApi } from '../unit/payments-test-utils';
import { projectFixture } from '../unit/projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));

/**
 * Phase 7 e2e (spec §9): extends the established smoke pattern with the
 * scripted one-user payments flow — the environment-scoped list loads after
 * login, creating a payment submits the contracted payload to the payments
 * route, and the poll keeps the page live until the default-success simulation
 * settles the new payment. Full browser e2e and multi-tenant flows are covered
 * at the API e2e level (browser tooling remains a Phase 17 concern).
 */
describe('payments smoke test (phase 7 §5.2)', () => {
  afterEach(() => {
    unstubPaymentsApi();
    paramsMock.mockClear();
    searchParamsMock.mockClear();
    vi.useRealTimers();
  });

  it('loads the environment-scoped payment list after login with env badge and owning org', async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams({ environment: 'test' }));
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByText(`$${paymentFixtures[0].amount}`);
    expect(screen.getByText(`$${paymentFixtures[1].amount}`)).toBeInTheDocument();
    await screen.findByText('Payments API');
    expect(screen.getByText('TEST')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${projectFixture.id}/payments?environment=test`),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) }),
    );
  });

  it('scripted one-user flow: create a payment and watch the simulation settle it (D1/D2/D3/D5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    searchParamsMock.mockReturnValue(new URLSearchParams());
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const api = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByRole('button', { name: 'Create payment' });
    const createForm = screen.getByRole('form', { name: 'Create payment' });

    // Create with the default customer of the environment + amount (D1/D3/D5).
    // The select is populated from the project+environment customers (waits
    // for the fetch to land).
    const customerSelect = await within(createForm).findByRole('combobox', { name: 'Customer' });
    await within(customerSelect).findByRole('option', { name: /alice@example.com/ });
    expect(customerSelect).toHaveValue('cust-1');
    fireEvent.change(within(createForm).getByLabelText('Amount (USD)'), { target: { value: '99.99' } });
    fireEvent.click(within(createForm).getByRole('button', { name: 'Create payment' }));

    await waitFor(() => {
      expect(api.fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/payments`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            environment: 'test',
            customer_id: 'cust-1',
            amount: '99.99',
            currency: 'usd',
          }),
        }),
      );
    });

    // The new payment appears in the list as pending; the default-success
    // simulation settles it and the poll flips the badge to succeeded. Both
    // moving payments are settled (the poll keeps firing while any payment is
    // non-terminal, D2).
    await screen.findByText('$99.99');
    // Two pending rows: pay-1 (fixture) and the created payment.
    expect(screen.getAllByText('pending')).toHaveLength(2);
    api.store.settle('pay-new');
    api.store.settle('pay-1');
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => {
      expect(screen.queryByText('pending')).not.toBeInTheDocument();
    });
    // pay-2 (fixture), pay-1, and the created payment — all terminal.
    expect(screen.getAllByText('succeeded')).toHaveLength(3);
  });
});