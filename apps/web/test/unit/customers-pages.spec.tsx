import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import type { AuthSession } from '../../lib/brinnpay/client';
import ProjectCustomersPage from '../../app/(dashboard)/dashboard/projects/[projectId]/customers/page';
import { stubCustomersApi, unstubCustomersApi } from './customers-test-utils';
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
  unstubCustomersApi();
  paramsMock.mockClear();
  searchParamsMock.mockClear();
  vi.useRealTimers();
});

describe('customers page (phase 6 §5.1)', () => {
  it('lists the selected environment customers with the badge and the owning org', async () => {
    setEnvironmentQuery('test');
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: /Customers/ });
    await screen.findByText('alice@example.com');
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    // The owning-org line shows the project name (shell pattern).
    await screen.findByText('Payments API');
    // Environment badge matches the selector (phase 6 §5.1).
    expect(screen.getByText('TEST')).toBeInTheDocument();
    // Explicit environment on the list call (D2: TEST/LIVE data is never mixed).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/projects/${projectFixture.id}/customers`),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        }),
      );
    });
    const listUrl = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/customers'),
    )![0] as string;
    expect(listUrl).toContain('environment=test');
  });

  it('owner creates a customer with email, name, and metadata rows (PATCH-compatible body)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    // Wait for the create form (the heading renders during the loading state).
    const createButton = await screen.findByRole('button', { name: 'Create customer' });
    const createForm = screen.getByRole('form', { name: 'Create customer' });
    fireEvent.change(within(createForm).getByLabelText(/^Email$/), { target: { value: 'new@example.com' } });
    fireEvent.change(within(createForm).getByLabelText(/^Name$/), { target: { value: 'New Person' } });
    fireEvent.click(within(createForm).getByRole('button', { name: 'Add metadata row' }));
    fireEvent.change(within(createForm).getAllByLabelText('Key')[0], { target: { value: 'plan' } });
    fireEvent.change(within(createForm).getAllByLabelText('Value')[0], { target: { value: 'team' } });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/customers`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            environment: 'test',
            email: 'new@example.com',
            name: 'New Person',
            metadata: { plan: 'team' },
          }),
        }),
      );
    });
    // The create form clears after success; the list refetches.
    expect(within(createForm).getByLabelText(/^Email$/)).toHaveValue('');
  });

  it('member role sees the list and detail but no create/delete controls (capability-based UI)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubCustomersApi({ session: memberSession('user-member', 'member@example.com', 'Linus Pauling') });
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: /Customers/ });
    await screen.findByText('alice@example.com');
    expect(screen.queryByRole('button', { name: 'Create customer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    // Read-only detail stays available (the API enforces anyway).
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    await screen.findByRole('heading', { level: 2, name: 'Customer detail' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('search issues the list call with the search parameter (debounced) and replaces the list', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByText('alice@example.com');
    await screen.findByText('bob@example.com');
    const searchBox = screen.getByLabelText('Search');
    fireEvent.change(searchBox, { target: { value: 'alice' } });

    await waitFor(
      () => {
        const searchCalls = fetchMock.mock.calls.filter(
          ([url]) => String(url).includes('/customers') && String(url).includes('search=alice'),
        );
        expect(searchCalls.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    // The result set replaces the list: the non-matching customer disappears.
    await waitFor(() => {
      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    });
  });

  it('detail view fetches the record and edit saves via PATCH to the customer route', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    await screen.findByRole('heading', { level: 2, name: 'Customer detail' });

    // Detail shows the stored metadata.
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(screen.getByText(': pro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editForm = await screen.findByRole('form', { name: 'Edit customer' });
    fireEvent.change(within(editForm).getByLabelText(/^Name$/), { target: { value: 'Alice Updated' } });
    fireEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/customers/cust-1`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            email: 'alice@example.com',
            name: 'Alice Updated',
            metadata: { plan: 'pro' },
          }),
        }),
      );
    });
    // The detail section reflects the updated record.
    await screen.findByText('Alice Updated');
  });

  it('delete confirms, calls the DELETE route, and removes the row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByText('alice@example.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/customers/cust-1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    });
    confirmSpy.mockRestore();
  });

  it('non-member reaching the page is treated as not-found (project access semantics)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubCustomersApi({ failCustomers: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
  });
});