import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';
import {
  auditLogFixtures,
  stubAuditLogsApi,
  unstubAuditLogsApi,
} from './audit-logs-test-utils';
import { orgFixture, projectFixture } from './projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => ({ get: () => null }),
}));

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const FIRST_REQUEST_ID = auditLogFixtures[0].data?.request_id as string;

afterEach(() => {
  unstubAuditLogsApi();
  paramsMock.mockClear();
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, 'clipboard', ORIGINAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function renderViewer(): ReturnType<typeof render> {
  paramsMock.mockReturnValue({ projectId: projectFixture.id });
  return render(
    <AuthProvider>
      <ProjectLogsAuditPage />
    </AuthProvider>,
  );
}

function auditCalls(fetchMock: ReturnType<typeof stubAuditLogsApi>['fetchMock']): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/logs/audit'));
}

describe('audit logs page (phase 12 §8)', () => {
  it('lists the organization entries with every column and no secret material', async () => {
    stubAuditLogsApi({ pageSize: 10 });
    renderViewer();

    await screen.findByRole('heading', { level: 1, name: /Audit logs/ });
    const table = await screen.findByRole('table', { name: 'Audit logs' });
    // The view is labeled organization-wide (D12): all projects, both envs.
    expect(screen.getByText(/Organization-wide: every project and both environments/)).toBeInTheDocument();

    expect(within(table).getByRole('columnheader', { name: 'Timestamp' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Actor' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Resource' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Environment' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Data' })).toBeInTheDocument();

    expect(within(table).getByText('user.logged_in')).toBeInTheDocument();
    expect(within(table).getByText('member.role_changed')).toBeInTheDocument();
    // Actor: type + id. Resource: type + id.
    expect(within(table).getAllByText('api_key').length).toBeGreaterThan(0);
    expect(within(table).getByText('pay-1')).toBeInTheDocument();
    // D6 attribution columns: TEST for the payment, LIVE for the key action,
    // a dash for organization-scoped entries.
    expect(within(table).getAllByText('TEST').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
    // `data` as key/value pairs.
    expect(within(table).getByText(/previous_role: viewer/)).toBeInTheDocument();

    // Metadata only — no credential material is ever rendered.
    expect(screen.queryByText(/sk_live_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk_test_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/whsec_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });

  it('resolves project → organization and reads with the session bearer only, never writes', async () => {
    const { fetchMock } = stubAuditLogsApi();
    renderViewer();
    await screen.findByRole('table', { name: 'Audit logs' });

    const calls = auditCalls(fetchMock);
    expect(calls.length).toBeGreaterThan(0);
    // Scope resolution (D12): the addressed project's organization, not the
    // project id, and never another organization.
    expect(String(calls[0][0])).toContain(`/organizations/${orgFixture.id}/logs/audit`);
    expect(String(calls[0][0])).not.toContain(`/projects/${projectFixture.id}/logs/audit`);
    // Session authority: the access token is the only credential sent.
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );
    // Read-only: every call is a GET. No operation creates, edits or deletes.
    expect(
      calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'),
    ).toBe(true);
    // D11: no filters exist beyond pagination.
    expect(String(calls[0][0])).not.toContain('action=');
    expect(String(calls[0][0])).not.toContain('environment=');
  });

  it('follows the cursor contract: one more page on demand, then stops', async () => {
    const { fetchMock } = stubAuditLogsApi({ pageSize: 2 });
    renderViewer();
    const table = await screen.findByRole('table', { name: 'Audit logs' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(auditCalls(fetchMock).some(([url]) => String(url).includes('cursor=2'))).toBe(true);
    });
    await within(table).findByText('api_key.revoked');
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('copies the request id for cross-reference into the request-log viewer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubAuditLogsApi();
    renderViewer();
    const table = await screen.findByRole('table', { name: 'Audit logs' });

    fireEvent.click(within(table).getAllByRole('button', { name: 'Copy' })[0]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FIRST_REQUEST_ID));
    await within(table).findByRole('button', { name: 'Copied' });
  });

  it('surfaces the not-found state without asking for entries when the URL addresses another project', async () => {
    const { fetchMock } = stubAuditLogsApi({ failProject: 'NOT_FOUND' });
    renderViewer();

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(auditCalls(fetchMock)).toHaveLength(0);
  });

  it('reports a list failure as an error state instead of data', async () => {
    stubAuditLogsApi({ failList: 'INTERNAL_ERROR' });
    renderViewer();

    await screen.findByRole('alert');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No audit entries yet.')).not.toBeInTheDocument();
  });

  it('shows the loading state until the first page arrives, and only then the list', async () => {
    stubAuditLogsApi();
    renderViewer();

    expect(screen.getByRole('heading', { level: 1, name: /Audit logs/ })).toBeInTheDocument();
    expect(screen.getByText('Loading audit logs…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await screen.findByRole('table', { name: 'Audit logs' });
    expect(screen.queryByText('Loading audit logs…')).not.toBeInTheDocument();
  });

  it('drops the previous project entries immediately on a client-side route change', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubAuditLogsApi();
    const { rerender } = render(
      <AuthProvider>
        <ProjectLogsAuditPage />
      </AuthProvider>,
    );
    await screen.findByRole('table', { name: 'Audit logs' });

    // Same component instance, different project: stale entries never show.
    paramsMock.mockReturnValue({ projectId: 'proj-2' });
    rerender(
      <AuthProvider>
        <ProjectLogsAuditPage />
      </AuthProvider>,
    );

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Loading audit logs…')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Audit logs' });
  });

  it('shows the empty state when the organization has no entries yet', async () => {
    stubAuditLogsApi({ entries: [] });
    renderViewer();

    await screen.findByText('No audit entries yet.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('renders an entry whose allowlist produced nothing as a dash, never as invented context', async () => {
    stubAuditLogsApi({ pageSize: 10 });
    renderViewer();
    const table = await screen.findByRole('table', { name: 'Audit logs' });
    const rows = within(table).getAllByRole('row');
    // The `api_key.revoked` fixture carries no `data` key at all.
    const keyRow = rows.find((row) => within(row).queryByText('api_key.revoked'));
    expect(keyRow).toBeDefined();
    expect(within(keyRow as HTMLElement).getByText('—')).toBeInTheDocument();
    expect(within(keyRow as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });
});
