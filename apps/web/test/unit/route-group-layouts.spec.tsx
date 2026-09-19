import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthLayout from '../../app/(auth)/layout';
import DashboardLayout from '../../app/(dashboard)/layout';
import PublicLayout from '../../app/(public)/layout';

describe('route-group layouts (phase 2 §5.2)', () => {
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

  it('keeps the authenticated area behind the dashboard shell navigation', () => {
    render(<DashboardLayout>page content</DashboardLayout>);

    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(nav).toHaveTextContent('Overview');
    expect(nav).toHaveTextContent('Organizations');
    expect(nav).toHaveTextContent('Projects');
    expect(nav).toHaveTextContent('Settings');
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('renders child content for every layout', () => {
    const { rerender } = render(<PublicLayout>public child</PublicLayout>);
    expect(screen.getByText('public child')).toBeInTheDocument();

    rerender(<AuthLayout>auth child</AuthLayout>);
    expect(screen.getByText('auth child')).toBeInTheDocument();

    rerender(<DashboardLayout>dashboard child</DashboardLayout>);
    expect(screen.getByText('dashboard child')).toBeInTheDocument();
  });
});