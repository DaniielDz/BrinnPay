import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import ProjectCustomersPage from '../../app/(dashboard)/dashboard/projects/[projectId]/customers/page';
import {
  customerFixtures,
  stubCustomersApi,
  unstubCustomersApi,
} from '../unit/customers-test-utils';
import { projectFixture } from '../unit/projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));

/**
 * Phase 6 e2e (spec §9): extends the established smoke pattern with the
 * scripted one-user customers flow — the list loads after login with the
 * shell-selected environment, create adds a customer, search narrows the
 * list, and edit/delete update and remove a record. Full browser e2e and
 * multi-tenant flows are covered at the API e2e level (browser tooling
 * remains a Phase 17 concern).
 */
describe('customers smoke test (phase 6 §5.1)', () => {
  afterEach(() => {
    unstubCustomersApi();
    paramsMock.mockClear();
    searchParamsMock.mockClear();
  });

  it('loads the environment-scoped customer list after login with env badge and owning org', async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams({ environment: 'test' }));
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByText(customerFixtures[0].email);
    expect(screen.getByText(customerFixtures[1].email)).toBeInTheDocument();
    await screen.findByText('Payments API');
    expect(screen.getByText('TEST')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${projectFixture.id}/customers?environment=test`),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) }),
    );
  });

  it('scripted one-user flow: create, search, edit, delete (D1/D6/D7)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    searchParamsMock.mockReturnValue(new URLSearchParams());
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubCustomersApi();
    render(
      <AuthProvider>
        <ProjectCustomersPage />
      </AuthProvider>,
    );

    await screen.findByRole('button', { name: 'Create customer' });
    const createForm = screen.getByRole('form', { name: 'Create customer' });

    // Create with email + metadata row.
    fireEvent.change(within(createForm).getByLabelText(/^Email$/), { target: { value: 'smoke@example.com' } });
    fireEvent.click(within(createForm).getByRole('button', { name: 'Add metadata row' }));
    fireEvent.change(within(createForm).getAllByLabelText('Key')[0], { target: { value: 'plan' } });
    fireEvent.change(within(createForm).getAllByLabelText('Value')[0], { target: { value: 'team' } });
    fireEvent.click(within(createForm).getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/customers`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ environment: 'test', email: 'smoke@example.com', metadata: { plan: 'team' } }),
        }),
      );
    });

    // Search narrows the list to the fixture matching the term.
    const searchBox = screen.getByLabelText('Search');
    fireEvent.change(searchBox, { target: { value: 'alice' } });
    await waitFor(
      () => {
        expect(
          fetchMock.mock.calls.some(
            ([url]) => String(url).includes('/customers') && String(url).includes('search=alice'),
          ),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
    await waitFor(() => {
      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    });

    // Detail → edit → PATCH.
    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    await screen.findByRole('heading', { level: 2, name: 'Customer detail' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editForm = await screen.findByRole('form', { name: 'Edit customer' });
    fireEvent.change(within(editForm).getByLabelText(/^Name$/), { target: { value: 'Alice Updated' } });
    fireEvent.click(within(editForm).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/customers/cust-1`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ email: 'alice@example.com', name: 'Alice Updated', metadata: { plan: 'pro' } }),
        }),
      );
    });

    // Delete with confirmation → 204 → the row disappears.
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
});