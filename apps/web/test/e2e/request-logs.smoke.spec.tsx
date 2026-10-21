import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectLogsRequestsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/requests/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture } from '../unit/projects-test-utils';
import { stubRequestLogsApi, unstubRequestLogsApi } from '../unit/request-logs-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => ({ get: () => null }),
}));

/**
 * Phase 11 flow at smoke level (established jsdom pattern): the project's
 * request-log table loads after the session resolves, and a scripted
 * environment filter narrows the list through the D1 query. Column/no-secret
 * guarantees live in `request-logs-pages.spec.tsx`; real browsers are
 * Phase 17 D1.
 */
describe('request logs smoke test (phase 11 §7)', () => {
  afterEach(() => {
    unstubRequestLogsApi();
    paramsMock.mockClear();
  });

  it('loads the log table after login and narrows it through the environment filter', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubRequestLogsApi();
    render(
      <AuthProvider>
        <ProjectLogsRequestsPage />
      </AuthProvider>,
    );

    // Load: heading, owning project, table through the session bearer.
    const table = await screen.findByRole('table', { name: 'Request logs' });
    expect(screen.getByRole('heading', { level: 1, name: /Request logs/ })).toBeInTheDocument();
    expect(screen.getByText('Payments API')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${projectFixture.id}/logs/requests`),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );

    // Scripted filter → environment-scoped request; environment-less records hide.
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'test' } });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('environment=test')),
      ).toBe(true);
    });
    await screen.findByText(/Environment: TEST/);
    expect(screen.queryByText('/api/v1/payments/pay-1')).not.toBeInTheDocument();
    expect(table).toBeInTheDocument();
  });
});
