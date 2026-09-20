import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LoginPage from '../../app/(auth)/login/page';
import RegisterPage from '../../app/(auth)/register/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { stubAuthApi, unstubAuthApi } from '../unit/auth-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

/**
 * Phase 3 e2e (spec §9.2): extends the Phase 2 smoke pattern with the
 * authentication area. Browser tooling is a Phase 17 concern; a scripted flow
 * against the real API is covered by the API e2e suite, so this only verifies
 * the auth pages render their forms without touching a backend or exposing
 * session material on the public surface.
 */
describe('auth pages smoke test (phase 3 §5.1)', () => {
  afterEach(() => {
    unstubAuthApi();
  });

  it('renders the login form without session material', () => {
    stubAuthApi({ refresh: 'fail' });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    // Public auth surface never renders tokens or session data.
    expect(screen.queryByText(/brinnpay_refresh/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/access_token/i)).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders the registration form without session material', () => {
    stubAuthApi({ refresh: 'fail' });
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Register' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByText(/brinnpay_refresh/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/access_token/i)).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});