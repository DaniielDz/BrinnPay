import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import type { AuthSession } from '../../lib/brinnpay/client';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import ProjectPage from '../../app/(dashboard)/dashboard/projects/[projectId]/page';
import ProjectApiKeysPage from '../../app/(dashboard)/dashboard/projects/[projectId]/api-keys/page';
import {
  createdKeyFixture,
  projectFixture,
  sessionFixture,
  stubProjectsApi,
  unstubProjectsApi,
} from './projects-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));

function setEnvironmentQuery(value: string | null): void {
  searchParamsMock.mockReturnValue(new URLSearchParams(value ? { environment: value } : undefined));
}

function memberSession(userId: string, email: string, name: string): AuthSession {
  return {
    ...sessionFixture,
    user: { ...sessionFixture.user, id: userId, email, name },
  };
}

afterEach(() => {
  unstubProjectsApi();
  vi.clearAllMocks();
});

describe('project list page (phase 5 §5.1)', () => {
  it('shows projects with the owning organization and TEST/LIVE badges, linking to the shell', async () => {
    stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    const link = await screen.findByRole('link', { name: /Payments API/ });
    expect(link).toHaveAttribute('href', `/dashboard/projects/${projectFixture.id}`);
    // Owning organization appears on the row and as the create-form selector.
    expect(screen.getAllByText('Acme Sandbox').length).toBeGreaterThan(0);
    expect(screen.getByText('TEST')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('creates a project through the form with the selected organization', async () => {
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    await screen.findByRole('link', { name: /Payments API/ });

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Checkout API' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ organization_id: 'org-1', name: 'Checkout API' }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        }),
      );
    });
  });

  it('hides the create form when the caller has no createable organization', async () => {
    // A viewer has no org where projects.create applies → no form.
    stubProjectsApi({ session: memberSession('user-viewer', 'viewer@example.com', 'Katherine Johnson') });
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    await screen.findByRole('link', { name: /Payments API/ });
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('renders the load error state when the list fails', async () => {
    stubProjectsApi({ listProjects: { ok: false, code: 'INTERNAL_ERROR' } });
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    await screen.findByRole('alert');
  });
});

describe('project shell page (phase 5 §5.1/§5.3)', () => {
  it('owner sees rename/delete and an environment selector applied to child links', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Payments API' });
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeInTheDocument();

    // Selector defaults to TEST; child links carry `?environment=test`.
    const apiKeysLink = screen.getByRole('link', { name: /API keys/ });
    expect(apiKeysLink).toHaveAttribute(
      'href',
      `/dashboard/projects/${projectFixture.id}/api-keys?environment=test`,
    );
  });

  it('preserves a LIVE environment deep link by re-linking the workspace (§5.3)', async () => {
    // The selector is the presentation of the `environment` query parameter:
    // a deep link with `?environment=live` keeps LIVE on every child link.
    setEnvironmentQuery('live');
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Payments API' });

    const apiKeysLink = await screen.findByRole('link', { name: /API keys/ });
    expect(apiKeysLink).toHaveAttribute(
      'href',
      `/dashboard/projects/${projectFixture.id}/api-keys?environment=live`,
    );
    const customersLink = screen.getByRole('link', { name: 'Customers' });
    expect(customersLink).toHaveAttribute(
      'href',
      `/dashboard/projects/${projectFixture.id}/customers?environment=live`,
    );
  });

  it('renames the project through the form', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Payments API' });

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Checkout API' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Checkout API' }) }),
      );
    });
    await screen.findByRole('heading', { level: 1, name: 'Checkout API' });
  });

  it('deletes the project after confirmation and navigates to the list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('button', { name: 'Delete project' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(replaceMock).toHaveBeenCalledWith('/dashboard/projects');
    confirmSpy.mockRestore();
  });

  it('member/viewer sees no rename/delete controls', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi({ session: memberSession('user-member', 'member@example.com', 'Linus Pauling') });
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Payments API' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });

  it('non-member reaching the shell is treated as not-found (D2 mirrors the API 404)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi({ failProjects: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <ProjectPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();
  });
});

describe('API-key management page (phase 5 §5.2)', () => {
  it('lists project-wide keys with environment badges and revoked state — never plaintext metadata', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });
    // Wait for the project-wide list to finish loading (the heading also
    // renders during the loading state).
    await screen.findByText('key-1');
    await screen.findByText('key-2');
    // Revoked state and environment badges.
    expect(screen.getAllByText('TEST').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    await screen.findByText(/revoked/);
    // No credential material in the listing.
    expect(screen.queryByText(/sk_(test|live)_/i)).not.toBeInTheDocument();
  });

  it('create reveals the plaintext exactly once with a copy button and warning', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });

    // Creation is offered to owner/admin; wait for the form (the heading also
    // renders during the loading state).
    await screen.findByRole('button', { name: 'Create key' });
    fireEvent.change(screen.getByLabelText(/environment/i), { target: { value: 'live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/api-keys`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ environment: 'live' }),
        }),
      );
    });

    const revealed = createdKeyFixture('live');
    await screen.findByText(revealed.key);
    expect(screen.getByText(/this is the only time this key is shown/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('revoke confirms, calls the DELETE route, and marks the key revoked in place', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });

    // key-1 is the only active fixture key (key-2 already revoked); wait for
    // the list so the action buttons exist.
    await screen.findByText('key-1');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/api-keys/key-1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(
        screen
          .getAllByText(/revoked/)
          .some((node) => node.textContent?.includes('key-1') ?? false),
      ).toBe(true);
    });
    confirmSpy.mockRestore();
  });

  it('rotate creates a replacement and revokes the selected key (D1 workflow)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setEnvironmentQuery('test');
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });

    // key-2 is already revoked → the Rotate action is offered on it; wait for
    // the list so the action buttons exist.
    await screen.findByText('key-2');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    // The replacement inherits the rotated key's environment (key-2 = LIVE).
    const revealed = createdKeyFixture('live');
    await screen.findByText(revealed.key);

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === 'POST' &&
          String(url).endsWith(`/projects/${projectFixture.id}/api-keys`),
      );
      // Exactly one create (the replacement); the GET list and the session
      // refresh must not be counted.
      expect(createCalls).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/v1/projects/${projectFixture.id}/api-keys/key-2`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    confirmSpy.mockRestore();
  });

  it('member role sees no create or revoke controls (capability-based UI, §5.2)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi({ session: memberSession('user-member', 'member@example.com', 'Linus Pauling') });
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });
    // Member role: wait for the read-only list (no create/revoke/rotate).
    await screen.findByText('key-1');
    expect(screen.queryByRole('button', { name: 'Create key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
  });

  it('non-member reaching the page is treated as not-found (project access semantics)', async () => {
    setEnvironmentQuery(null);
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubProjectsApi({ failProjects: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
  });
});