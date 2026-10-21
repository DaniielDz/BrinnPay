import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthProvider, useAuth, type AuthState } from '../../components/auth/auth-provider';
import { stubAuthApi, unstubAuthApi } from './auth-test-utils';

let capturedError: string | null = null;

function Probe() {
  const auth = useAuth();
  const { status, user, login, register, logout } = auth;
  return (
    <div>
      <span data-testid="status">{status}</span>
      {user ? <span data-testid="email">{user.email}</span> : null}
      <button
        type="button"
        onClick={() => {
          void login('dev@example.com', 'password-123').catch((error: Error) => {
            capturedError = error.message;
          });
        }}
      >
        login
      </button>
      <button
        type="button"
        onClick={() => {
          void register({ email: 'dev@example.com', password: 'password-123' }).catch((error: Error) => {
            capturedError = error.message;
          });
        }}
      >
        register
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        logout
      </button>
    </div>
  );
}

describe('AuthProvider (phase 3 §4.4)', () => {
  beforeEach(() => {
    capturedError = null;
  });

  afterEach(() => {
    unstubAuthApi();
  });

  it('restores an existing session on mount via /auth/refresh', async () => {
    const { fetchMock } = stubAuthApi({ refresh: 'ok' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('email')).toHaveTextContent('dev@example.com');
    // The refresh response carries no identity (phase 3 §4.4), so the restored
    // user can only have come from `GET /auth/me` — the pairing is the defect
    // guard for the phase 17 D6 session-restore fix.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/me')),
    ).toBe(true);
  });

  it('reports no session when the refresh cookie is absent or rejected', async () => {
    stubAuthApi({ refresh: 'fail' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.queryByTestId('email')).not.toBeInTheDocument();
  });

  it('keeps a throttled mount restore pending instead of signing the user out (§7.3)', async () => {
    const { fetchMock } = stubAuthApi({ refresh: 'throttled' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // Drain the restore's promise chain with a macrotask flush (no timed
    // wait): by then the `429` has been received, parsed and processed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/refresh')),
    ).toBe(true);
    // A `429` is throttling, never a session verdict (phase 14 §7.3): the
    // restore stays pending rather than flipping to `unauthenticated`, so
    // throttling can never read as a sign-out.
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.queryByTestId('email')).not.toBeInTheDocument();
  });

  it('transitions through login then logout', async () => {
    stubAuthApi({ refresh: 'fail', login: 'ok', logout: 'ok' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    fireEvent.click(screen.getByRole('button', { name: 'login' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('email')).toHaveTextContent('dev@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.queryByTestId('email')).not.toBeInTheDocument();
  });

  it('lets a failed login surface the API error and stays unauthenticated', async () => {
    stubAuthApi({ refresh: 'fail', login: 'fail' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    fireEvent.click(screen.getByRole('button', { name: 'login' }));
    await waitFor(() => expect(capturedError).toBe('Invalid email or password'));
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
  });

  it('exposes the current user for authed UI', async () => {
    stubAuthApi({ refresh: 'ok' });

    const holder: { value: AuthState | null } = { value: null };
    function CaptureAuth() {
      const auth = useAuth();
      holder.value = auth;
      return null;
    }

    render(
      <AuthProvider>
        <CaptureAuth />
      </AuthProvider>,
    );
    await waitFor(() => expect(holder.value?.status).toBe('authenticated'));
    expect(holder.value?.user).toEqual({
      id: 'user-1',
      email: 'dev@example.com',
      name: 'Ada Lovelace',
      created_at: '2026-09-19T00:00:00.000Z',
      updated_at: '2026-09-19T00:00:00.000Z',
    });
    expect(holder.value?.accessToken).toBe('test-access-token');
  });
});