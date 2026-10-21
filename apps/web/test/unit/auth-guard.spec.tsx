import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGuard } from '../../components/auth/auth-guard';
import { AuthProvider } from '../../components/auth/auth-provider';
import { stubAuthApi, unstubAuthApi } from './auth-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

describe('AuthGuard (phase 3 §4.4)', () => {
  beforeEach(() => {
    replaceMock.mockReset();
  });

  afterEach(() => {
    unstubAuthApi();
  });

  it('renders children once a session is restored', async () => {
    stubAuthApi({ refresh: 'ok' });
    render(
      <AuthProvider>
        <AuthGuard>protected content</AuthGuard>
      </AuthProvider>,
    );

    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('protected content')).toBeInTheDocument());
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no session', async () => {
    stubAuthApi({ refresh: 'fail' });
    render(
      <AuthProvider>
        <AuthGuard>protected content</AuthGuard>
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });
});