import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture } from '../unit/projects-test-utils';
import { stubAuditLogsApi, unstubAuditLogsApi } from '../unit/audit-logs-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => ({ get: () => null }),
}));

/**
 * Phase 12 flow at smoke level (established jsdom pattern): the organization's
 * audit entries load after the session resolves, and a scripted "Load more"
 * follows the cursor contract to the next page. Column/no-secret and
 * out-of-order guarantees live in `audit-logs-pages.spec.tsx`; real browsers
 * are Phase 17 D1.
 */
describe('audit logs smoke test (phase 12 §8)', () => {
  afterEach(() => {
    unstubAuditLogsApi();
    paramsMock.mockClear();
  });

  it('lists the organization entries and pages through them on demand', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubAuditLogsApi();
    render(
      <AuthProvider>
        <ProjectLogsAuditPage />
      </AuthProvider>,
    );

    // Load: organization-wide label and the first cursor page of entries.
    const table = await screen.findByRole('table', { name: 'Audit logs' });
    expect(screen.getByRole('heading', { level: 1, name: /Audit logs/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Organization-wide: every project and both environments/),
    ).toBeInTheDocument();
    expect(within(table).getByText('user.logged_in')).toBeInTheDocument();
    expect(within(table).getByText('member.role_changed')).toBeInTheDocument();
    expect(within(table).queryByText('payment.created')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/logs/audit'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );

    // Scripted pagination → the cursor page appends and the control retires.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=2')),
      ).toBe(true);
    });
    await within(table).findByText('payment.created');
    expect(within(table).getByText('api_key.revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
