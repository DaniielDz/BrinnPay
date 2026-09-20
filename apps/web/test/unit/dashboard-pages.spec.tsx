import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import DashboardPage from '../../app/(dashboard)/dashboard/page';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import SettingsPage from '../../app/(dashboard)/dashboard/settings/page';

describe('dashboard pages (phase 2 §5.2, phase 4 §5.1)', () => {
  it('renders the dashboard overview placeholder', () => {
    render(<DashboardPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders the projects placeholder', () => {
    render(<ProjectsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
  });

  it('renders the settings placeholder', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });
});