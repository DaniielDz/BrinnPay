import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardLayout from '../../app/(dashboard)/layout';
import DashboardPage from '../../app/(dashboard)/dashboard/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture, stubProjectsApi, unstubProjectsApi } from '../unit/projects-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/dashboard',
}));

/**
 * Phase 14 §11.1 authenticated flow (established jsdom pattern — real browsers
 * are Phase 17): stubbed session → dashboard shell → overview fetch →
 * navigation to a feature view → sign-out clears the session and returns to
 * `/login`.
 */
describe('dashboard smoke test (phase 14 §6.1/§6.2/§11.1)', () => {
  afterEach(() => {
    unstubProjectsApi();
    vi.clearAllMocks();
  });

  it('opens the shell, loads the overview, links to feature views and signs out', async () => {
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <DashboardLayout>
          <DashboardPage />
        </DashboardLayout>
      </AuthProvider>,
    );

    // Shell: navigation, identity, sign-out — only after the session resolves.
    const nav = await screen.findByRole('navigation', { name: 'Dashboard' });
    expect(nav).toHaveTextContent('Overview');
    expect(nav).toHaveTextContent('Organizations');
    expect(nav).toHaveTextContent('Projects');
    expect(nav).toHaveTextContent('Settings');
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    // Overview reads through the session bearer only.
    expect(
      await screen.findByRole('link', { name: projectFixture.name }),
    ).toHaveAttribute('href', `/dashboard/projects/${projectFixture.id}`);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/organizations'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );

    // Feature views are reachable from the shell navigation.
    expect(nav.querySelector('a[href="/dashboard/projects"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/dashboard/settings"]')).not.toBeNull();

    // Sign out clears the session and returns to the login page.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument(),
    );
  });
});
