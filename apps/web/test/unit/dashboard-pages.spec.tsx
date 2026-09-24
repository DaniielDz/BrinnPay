import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DashboardPage from '../../app/(dashboard)/dashboard/page';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import SettingsPage from '../../app/(dashboard)/dashboard/settings/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { stubProjectsApi, unstubProjectsApi } from './projects-test-utils';

describe('dashboard pages (phase 2 §5.2, phase 4 §5.1)', () => {
  afterEach(() => {
    unstubProjectsApi();
  });

  it('renders the dashboard overview placeholder', () => {
    render(<DashboardPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders the projects page inside the authenticated provider (phase 5 §5.1)', async () => {
    // Since Phase 5 the projects route is data-driven and requires the session
    // context provided by AuthProvider; the smoke-level behavior lives in
    // projects-pages.spec.tsx.
    stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );
    // The heading appears only after the session restore provides a token.
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    await waitFor(() => expect(screen.getByText('TEST')).toBeInTheDocument());
  });

  it('renders the settings placeholder', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });
});