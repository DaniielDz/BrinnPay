import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthLayout from '../../app/(auth)/layout';
import DashboardLayout from '../../app/(dashboard)/layout';
import PublicLayout from '../../app/(public)/layout';
import { AuthProvider } from '../../components/auth/auth-provider';
import { stubAuthApi, unstubAuthApi } from './auth-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

describe('route-group layouts (phase 2 §5.2, phase 3 §4.4)', () => {
  beforeEach(() => {
    replaceMock.mockReset();
  });

  afterEach(() => {
    unstubAuthApi();
  });

  it('keeps the public area separate from auth and dashboard navigation', () => {
    render(<PublicLayout>page content</PublicLayout>);

    const nav = screen.getByRole('navigation', { name: 'Public' });
    expect(nav).toHaveTextContent('Home');
    expect(nav).toHaveTextContent('Product');
    expect(nav).toHaveTextContent('Docs');
    expect(screen.queryByRole('navigation', { name: 'Authentication' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('keeps the authentication area separate from the dashboard', () => {
    render(<AuthLayout>page content</AuthLayout>);

    expect(screen.getByRole('navigation', { name: 'Authentication' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('keeps the authenticated area behind the dashboard shell navigation', async () => {
    stubAuthApi({ refresh: 'ok' });
    render(
      <AuthProvider>
        <DashboardLayout>page content</DashboardLayout>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Dashboard' })).toBeInTheDocument());
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(nav).toHaveTextContent('Overview');
    expect(nav).toHaveTextContent('Organizations');
    expect(nav).toHaveTextContent('Projects');
    expect(nav).toHaveTextContent('Settings');
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not render the dashboard shell without a session', async () => {
    stubAuthApi({ refresh: 'fail' });
    render(
      <AuthProvider>
        <DashboardLayout>page content</DashboardLayout>
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('renders child content for the public and auth layouts', () => {
    const { rerender } = render(<PublicLayout>public child</PublicLayout>);
    expect(screen.getByText('public child')).toBeInTheDocument();

    rerender(<AuthLayout>auth child</AuthLayout>);
    expect(screen.getByText('auth child')).toBeInTheDocument();
  });
});