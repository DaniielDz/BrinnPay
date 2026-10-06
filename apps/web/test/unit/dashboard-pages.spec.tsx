import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from '../../app/(dashboard)/dashboard/page';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import SettingsPage from '../../app/(dashboard)/dashboard/settings/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { getApiBaseUrl } from '../../lib/brinnpay/client';
import { stubAuthApi, unstubAuthApi } from './auth-test-utils';
import { projectFixture, stubProjectsApi, unstubProjectsApi } from './projects-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

describe('dashboard pages (phase 2 §5.2, phase 4 §5.1, phase 14 §6.2/§6.3)', () => {
  afterEach(() => {
    unstubProjectsApi();
    unstubAuthApi();
    vi.clearAllMocks();
  });

  it('renders the dashboard overview with the caller organizations and projects (§6.2, D2)', async () => {
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    // Organizations, with the caller's role, and projects with owning
    // organization and TEST/LIVE context — first page only, no aggregates.
    const orgLink = await screen.findByRole('link', { name: 'Acme Sandbox' });
    expect(orgLink).toHaveAttribute('href', '/dashboard/organizations/org-1');
    expect(screen.getByText(/your role: owner/)).toBeInTheDocument();

    const projectLink = await screen.findByRole('link', { name: projectFixture.name });
    expect(projectLink).toHaveAttribute('href', `/dashboard/projects/${projectFixture.id}`);
    expect(screen.getByText('TEST')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    // Quick links (§6.2).
    expect(screen.getByRole('link', { name: 'Create project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );

    // Reads only: the overview never writes to the organizations/projects
    // routes it summarises (the session restore is the only other call).
    const summaryReads = fetchMock.mock.calls.filter(([url]) =>
      /\/organizations|\/projects|\/members/.test(String(url)),
    );
    expect(summaryReads.length).toBeGreaterThan(0);
    for (const [, init] of summaryReads) {
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('shows the no-projects-yet empty state with a guided first step', async () => {
    stubProjectsApi({ projects: [] });
    render(
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(await screen.findByText(/No projects yet\. Create your first project/i)).toBeInTheDocument();
    // The guided first step and the quick link both target project creation.
    expect(screen.getAllByRole('link', { name: 'Create project' }).length).toBeGreaterThan(0);
  });

  it('shows the error state when the overview read fails (§7.3)', async () => {
    stubProjectsApi({ listProjects: { ok: false, code: 'INTERNAL_ERROR' } });
    render(
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>,
    );

    await screen.findByRole('alert');
    expect(screen.queryByText('Payments API')).not.toBeInTheDocument();
  });

  it('performs no API read without a session token (§7.2)', async () => {
    const { fetchMock } = stubAuthApi({ refresh: 'fail' });
    const { container } = render(
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      const reads = fetchMock.mock.calls.filter(
        ([url]) => /\/organizations|\/projects|\/members/.test(String(url)),
      );
      expect(reads).toHaveLength(0);
    });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
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

  it('renders the read-only settings surface from the session (§6.3, D3)', async () => {
    stubProjectsApi();
    const { container } = render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    // Identity from the session / `GET /auth/me`.
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('user-owner')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-19/)).toBeInTheDocument();

    // Session control and public configuration — never secrets or tokens.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByText(getApiBaseUrl())).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/product');
    expect(container.textContent).not.toMatch(/access_token|refresh_token|brinnpay_refresh/i);

    // No editing capability was invented: no fields, no form, no save/delete.
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bsave\b|change password|delete account/i);
  });
});
