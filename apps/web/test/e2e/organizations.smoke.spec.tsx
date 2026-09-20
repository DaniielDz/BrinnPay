import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import OrganizationsPage from '../../app/(dashboard)/dashboard/organizations/page';
import OrganizationDetailPage from '../../app/(dashboard)/dashboard/organizations/[organizationId]/page';
import {
  orgFixture,
  stubOrganizationsApi,
  unstubOrganizationsApi,
} from '../unit/organizations-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useParams: () => paramsMock(),
}));

/**
 * Phase 4 e2e (spec §9.1): extends the established smoke pattern with the
 * scripted one-user organization flow — list loads after login, create, rename,
 * and delete. Full browser e2e and the two-user invitation acceptance flow are
 * covered at the API e2e level (browser tooling remains a Phase 17 concern).
 */
describe('organizations smoke test (phase 4 §5.1)', () => {
  afterEach(() => {
    unstubOrganizationsApi();
    replaceMock.mockClear();
    paramsMock.mockClear();
  });

  it('loads the organization list after login and creates a new organization', async () => {
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationsPage />
      </AuthProvider>,
    );

    expect(await screen.findByRole('link', { name: /Acme Sandbox/ })).toBeInTheDocument();
    expect(screen.getByText(/your role: owner/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Brand New Org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/organizations',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Brand New Org' }) }),
      );
    });
  });

  it('scripted one-user flow: rename the organization and delete it (D9)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Acme Sandbox' });

    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'Acme Live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await screen.findByRole('heading', { level: 1, name: 'Acme Live' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete organization' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/organizations/${orgFixture.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(replaceMock).toHaveBeenCalledWith('/dashboard/organizations');
    confirmSpy.mockRestore();
  });
});