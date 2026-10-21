import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import type { AuthSession } from '../../lib/brinnpay/client';
import OrganizationsPage from '../../app/(dashboard)/dashboard/organizations/page';
import OrganizationDetailPage from '../../app/(dashboard)/dashboard/organizations/[organizationId]/page';
import AcceptInvitationPage from '../../app/(dashboard)/dashboard/invitations/[invitationId]/page';
import {
  orgFixture,
  sessionFixture,
  stubOrganizationsApi,
  unstubOrganizationsApi,
} from './organizations-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
const { paramsMock } = vi.hoisted(() => ({
  paramsMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useParams: () => paramsMock(),
}));

function viewerSession(): AuthSession {
  return {
    ...sessionFixture,
    user: { ...sessionFixture.user, id: 'user-viewer', email: 'viewer@example.com' },
  };
}

describe('organization list page (phase 4 §5.1)', () => {
  afterEach(() => {
    unstubOrganizationsApi();
    vi.clearAllMocks();
  });

  it('shows the caller organizations with the caller role and a create form', async () => {
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Organizations' });

    const link = await screen.findByRole('link', { name: /Acme Sandbox/ });
    expect(link).toHaveAttribute('href', `/dashboard/organizations/${orgFixture.id}`);
    expect(screen.getByText(/your role: owner/i)).toBeInTheDocument();

    // Member roster fetches happened per organization (role derivation).
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/members?limit=100'), expect.any(Object));
  });

  it('creates an organization through the form and reloads the list', async () => {
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationsPage />
      </AuthProvider>,
    );

    await screen.findByRole('link', { name: /Acme Sandbox/ });

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'New Org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/organizations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'New Org' }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        }),
      );
    });
    expect(screen.getByLabelText(/name/i)).toHaveValue('');
  });

  it('renders the load error when listing fails', async () => {
    stubOrganizationsApi({ listOrgs: { ok: false, code: 'INTERNAL_ERROR' } });
    render(
      <AuthProvider>
        <OrganizationsPage />
      </AuthProvider>,
    );

    await screen.findByRole('alert');
  });
});

describe('organization detail page (phase 4 §5.1/§5.2)', () => {
  afterEach(() => {
    unstubOrganizationsApi();
    vi.clearAllMocks();
  });

  it('owner sees rename, delete, member role controls, and invitation management', async () => {
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    // Organization info + team members.
    await screen.findByRole('heading', { level: 1, name: 'Acme Sandbox' });
    expect(screen.getByText(/ada lovelace|owner@example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/grace hopper|admin@example.com/i)).toBeInTheDocument();

    // Owner controls.
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    // Every member gets a role select (owner manages anyone, incl. owner role).
    const selects = screen.getAllByRole('combobox', { name: /Role for/ });
    expect(selects).toHaveLength(4);
    fireEvent.change(screen.getByRole('combobox', { name: 'Role for member@example.com' }), {
      target: { value: 'admin' },
    });
    await waitFor(() => {
      expect(screen.getByText(/admin@example.com\) — admin/)).toBeInTheDocument();
    });
  });

  it('viewer sees a read-only roster with only a leave action for themselves', async () => {
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    stubOrganizationsApi({ session: viewerSession() });
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Acme Sandbox' });

    // No administrative controls for a viewer.
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete organization' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Role for/ })).not.toBeInTheDocument();

    // Self-only management: leave organization for the viewer themselves.
    expect(screen.getByRole('button', { name: 'Leave organization' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('non-member reaching the page is treated as not-found (D1 mirrors the API 404)', async () => {
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    stubOrganizationsApi({ failOrganizations: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Organization not found' });
    expect(screen.getByRole('link', { name: 'Back to organizations' })).toBeInTheDocument();
  });

  it('renames the organization through the form', async () => {
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Acme Sandbox' });

    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'Acme Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/organizations/${orgFixture.id}`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Acme Renamed' }),
        }),
      );
    });
    await screen.findByRole('heading', { level: 1, name: 'Acme Renamed' });
  });

  it('deletes the organization after confirmation and navigates to the list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    paramsMock.mockReturnValue({ organizationId: orgFixture.id });
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <OrganizationDetailPage />
      </AuthProvider>,
    );

    await screen.findByRole('button', { name: 'Delete organization' });
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

describe('invitation accept page (phase 4 §5.2, D6)', () => {
  afterEach(() => {
    unstubOrganizationsApi();
    vi.clearAllMocks();
  });

  it('accepts the invitation and shows the success state with the organization link', async () => {
    paramsMock.mockReturnValue({ invitationId: 'inv-1' });
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <AcceptInvitationPage />
      </AuthProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Accept invitation' });
    fireEvent.click(button);

    await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' });
    expect(screen.getByRole('link', { name: 'Open the organization' })).toHaveAttribute(
      'href',
      `/dashboard/organizations/${orgFixture.id}`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/invitations/inv-1/accept',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) }),
    );
  });

  it('maps the 404 error to the not-found presentation', async () => {
    paramsMock.mockReturnValue({ invitationId: 'inv-1' });
    stubOrganizationsApi({ acceptInvitation: { ok: false, code: 'NOT_FOUND' } });
    render(
      <AuthProvider>
        <AcceptInvitationPage />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(/does not exist or was not addressed to your account/i),
    ).toBeInTheDocument();
  });
});