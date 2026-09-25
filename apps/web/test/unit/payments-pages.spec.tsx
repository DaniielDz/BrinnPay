import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import type { AuthSession } from '../../lib/brinnpay/client';
import ProjectPaymentsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/payments/page';
import { stubPaymentsApi, unstubPaymentsApi } from './payments-test-utils';
import { projectFixture } from './projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));

function setEnvironmentQuery(value: string | null): void {
  searchParamsMock.mockReturnValue(new URLSearchParams(value ? { environment: value } : undefined));
}

function memberSession(userId: string, email: string, name: string): AuthSession {
  return {
    access_token: 'test-access-token',
    token_type: 'Bearer',
    expires_in: 900,
    user: {
      id: userId,
      email,
      name,
      created_at: '2026-09-19T00:00:00.000Z',
      updated_at: '2026-09-19T00:00:00.000Z',
    },
  };
}

afterEach(() => {
  unstubPaymentsApi();
  paramsMock.mockClear();
  searchParamsMock.mockClear();
  vi.useRealTimers();
});

describe('payments page (phase 7 §5.2, D1/D2/D3/D5)', () => {
  it('lists the selected environment payments with the status badge and owning org', async () => {
    setEnvironmentQuery('test');
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: /Payments/ });
    await screen.findByText('$10.00');
    expect(screen.getByText('$40.00')).toBeInTheDocument();
    // Status badges for both the moving and the settled payment (D2).
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    // Owning org + environment badge from the shell selector (D1).
    await screen.findByText('Payments API');
    expect(screen.getByText('TEST')).toBeInTheDocument();
    // Explicit environment on the list call (TEST/LIVE data is never mixed).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/projects/${projectFixture.id}/payments`),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        }),
      );
    });
    const listUrl = fetchMock.mock.calls.find(([url]) => String(url).includes('/payments'))![0] as string;
    expect(listUrl).toContain('environment=test');
  });

  it('owner creates a payment scoped to the shell environment with the customer select (D1/D3)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    const createButton = await screen.findByRole('button', { name: 'Create payment' });
    const createForm = screen.getByRole('form', { name: 'Create payment' });
    // The customer select is populated from the project+environment customers
    // (D3) and defaults to the first option (waits for the fetch to land).
    const customerSelect = await within(createForm).findByRole('combobox', { name: 'Customer' });
    await within(customerSelect).findByRole('option', { name: /alice@example.com/ });
    expect(customerSelect).toHaveValue('cust-1');
    fireEvent.change(within(createForm).getByLabelText('Amount (USD)'), { target: { value: '12.50' } });
    fireEvent.change(within(createForm).getByLabelText('Description'), {
      target: { value: '  Monthly plan  ' },
    });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/payments`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            environment: 'test',
            customer_id: 'cust-1',
            amount: '12.50',
            currency: 'usd',
            description: 'Monthly plan',
          }),
        }),
      );
    });
    // The create form clears after success; the list refetches.
    expect(within(createForm).getByLabelText('Amount (USD)')).toHaveValue('');
  });

  it('member role sees the list and detail but no create controls (capability-based UI, D5)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubPaymentsApi({ session: memberSession('user-member', 'member@example.com', 'Linus Pauling') });
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: /Payments/ });
    await screen.findByText('$10.00');
    expect(screen.queryByRole('button', { name: 'Create payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create payment' })).not.toBeInTheDocument();

    // Read-only detail stays available (the API enforces anyway).
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    await screen.findByRole('heading', { level: 2, name: 'Payment detail' });
    expect(screen.getByText('$10.00 USD')).toBeInTheDocument();
  });

  it('detail view fetches the record and the refresh button re-retrieves it (D2)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByText('$10.00');
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    const detail = await screen.findByRole('region', { name: 'Payment detail' });
    // Detail exposes the contracted fields (status + failure_code null in this
    // phase) alongside the list badge.
    expect(screen.getAllByText('pending')).toHaveLength(2);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(detail).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/payments/pay-1`,
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) }),
      );
    });
  });

  it('polls while a payment is non-terminal and reflects the simulation settling it (D2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const api = stubPaymentsApi();
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    // The moving payment is rendered (and therefore polled).
    await screen.findByText('$10.00');
    expect(screen.getByText('pending')).toBeInTheDocument();
    const paymentsCallsBefore = api.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/payments'),
    ).length;

    // The default-success simulation settles the payment; the next poll tick
    // picks it up and the badge flips without a manual reload (≥1 new list
    // call — the auto-advancing clock may also fire extra ticks on a loaded
    // machine).
    api.store.settle('pay-1');
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => {
      expect(screen.queryByText('pending')).not.toBeInTheDocument();
    });
    // Both list badges are now terminal (the settled one and the fixture).
    expect(screen.getAllByText('succeeded')).toHaveLength(2);
    expect(
      api.fetchMock.mock.calls.filter(([url]) => String(url).includes('/payments')).length,
    ).toBeGreaterThan(paymentsCallsBefore);
  });

  it('non-member reaching the page is treated as not-found (project access semantics)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubPaymentsApi({ failPayments: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <ProjectPaymentsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
  });
});