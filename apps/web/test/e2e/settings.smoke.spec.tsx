import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SettingsPage from '../../app/(dashboard)/dashboard/settings/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { getApiBaseUrl } from '../../lib/brinnpay/client';
import { stubProjectsApi, unstubProjectsApi } from '../unit/projects-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

/**
 * Phase 14 §6.3 flow at smoke level (established jsdom pattern): the session
 * restores, the read-only account surface renders with public configuration
 * only, and a scripted sign-out clears the session and returns to `/login`.
 * The surface's no-secrets/no-editing guarantees are asserted in
 * `dashboard-pages.spec.tsx`; real browsers are Phase 17 D1.
 */
describe('settings smoke test (phase 14 §6.3)', () => {
  afterEach(() => {
    unstubProjectsApi();
    vi.clearAllMocks();
  });

  it('restores the session, shows the read-only surface and signs out to login', async () => {
    stubProjectsApi();
    render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>,
    );

    // Session restore → account identity and public configuration.
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(getApiBaseUrl())).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    // Scripted sign-out: the local session clears and the router returns to login.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    await waitFor(() => expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument());
    expect(screen.getByText('Loading account…')).toBeInTheDocument();
  });
});
