import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import ProjectLogsRequestsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/requests/page';
import {
  requestLogFixtures,
  stubRequestLogsApi,
  unstubRequestLogsApi,
} from './request-logs-test-utils';
import { projectFixture } from './projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => ({ get: () => null }),
}));

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const FIRST_ID = requestLogFixtures[0].request_id;

afterEach(() => {
  unstubRequestLogsApi();
  paramsMock.mockClear();
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, 'clipboard', ORIGINAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function renderViewer(): ReturnType<typeof render> {
  paramsMock.mockReturnValue({ projectId: projectFixture.id });
  return render(
    <AuthProvider>
      <ProjectLogsRequestsPage />
    </AuthProvider>,
  );
}

function logCalls(fetchMock: ReturnType<typeof stubRequestLogsApi>['fetchMock']): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/logs/requests'));
}

describe('request logs page (phase 11 §7)', () => {
  it('lists the project records with every contracted column and no secret material', async () => {
    stubRequestLogsApi();
    renderViewer();

    await screen.findByRole('heading', { level: 1, name: /Request logs/ });
    // The owning-org line shows the project name (shell pattern).
    await screen.findByText('Payments API');
    const table = await screen.findByRole('table', { name: 'Request logs' });

    expect(within(table).getByRole('columnheader', { name: 'Timestamp' })).toBeInTheDocument();
    expect(within(table).getByText('POST')).toBeInTheDocument();
    expect(within(table).getByText('/api/v1/customers')).toBeInTheDocument();
    expect(within(table).getByText('201')).toBeInTheDocument();
    expect(within(table).getByText('14 ms')).toBeInTheDocument();
    expect(within(table).getByText('TEST')).toBeInTheDocument();
    // Actor comes from the nullable scope columns: session vs. API key.
    expect(within(table).getByText('User')).toBeInTheDocument();
    expect(within(table).getByText('API key')).toBeInTheDocument();
    // An unmeasured duration renders as a dash rather than a guess.
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(table).getByText(FIRST_ID)).toBeInTheDocument();

    // Metadata only — no credential material is ever rendered (phase 11 §8).
    expect(screen.queryByText(/sk_live_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk_test_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/whsec_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
  });

  it('reads with the session bearer only, never writes, and omits the D1 filter by default', async () => {
    const { fetchMock } = stubRequestLogsApi();
    renderViewer();
    await screen.findByRole('table', { name: 'Request logs' });

    const calls = logCalls(fetchMock);
    expect(calls.length).toBeGreaterThan(0);
    // Session authority: every list call carries the access token…
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );
    // …and is a GET. No operation creates, edits or deletes a log.
    expect(calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
    // D1 default: the absent parameter returns every record of the project.
    expect(String(calls[0][0])).not.toContain('environment=');
    expect(String(calls[0][0])).not.toContain('request_id=');
  });

  it('narrows the list through the environment control and hides environment-less records (D1)', async () => {
    const { fetchMock } = stubRequestLogsApi();
    renderViewer();
    await screen.findByRole('table', { name: 'Request logs' });

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'test' } });

    await waitFor(() => {
      expect(logCalls(fetchMock).some(([url]) => String(url).includes('environment=test'))).toBe(true);
    });
    await screen.findByText(/Environment: TEST/);
    // The API-key record has no environment, so it is excluded once set.
    expect(screen.queryByText('/api/v1/payments/pay-1')).not.toBeInTheDocument();
    expect(screen.queryByText('DELETE')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('/api/v1/payments/pay-1')).toBeInTheDocument();
    });
  });

  it('resolves an exact request-id lookup to that single record (D8)', async () => {
    const { fetchMock } = stubRequestLogsApi();
    renderViewer();
    await screen.findByRole('table', { name: 'Request logs' });

    const target = requestLogFixtures[2].request_id;
    fireEvent.change(screen.getByLabelText('Request ID'), { target: { value: target } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    await waitFor(() => {
      expect(logCalls(fetchMock).some(([url]) => String(url).includes(`request_id=${target}`))).toBe(true);
    });
    const table = await screen.findByRole('table', { name: 'Request logs' });
    await waitFor(() => {
      expect(within(table).getByText(target)).toBeInTheDocument();
    });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByText('/api/v1/customers')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('/api/v1/customers');
  });

  it('answers an unknown but well-formed request id with an explicit empty state, never a 404', async () => {
    stubRequestLogsApi();
    renderViewer();
    await screen.findByRole('table', { name: 'Request logs' });

    const unknown = 'req_99999999999999999999999999999999';
    fireEvent.change(screen.getByLabelText('Request ID'), { target: { value: unknown } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    await screen.findByText(`No request found for ${unknown}.`);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Project not found' })).not.toBeInTheDocument();
  });

  it('follows the cursor contract: one more page on demand, then stops', async () => {
    const { fetchMock } = stubRequestLogsApi({ pageSize: 2 });
    renderViewer();
    const table = await screen.findByRole('table', { name: 'Request logs' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(logCalls(fetchMock).some(([url]) => String(url).includes('cursor=2'))).toBe(true);
    });
    await within(table).findByText(requestLogFixtures[2].request_id);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('drops a page still in flight when the route changes to another project (F3)', async () => {
    const stale: { release: (() => void) | null } = { release: null };
    const { fetchMock } = stubRequestLogsApi({ pageSize: 2 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('cursor=')) {
          await new Promise<void>((resolve) => {
            stale.release = resolve;
          });
        }
        return fetchMock(input, init);
      }),
    );

    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { rerender } = render(
      <AuthProvider>
        <ProjectLogsRequestsPage />
      </AuthProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Request logs' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(stale.release).not.toBeNull());

    paramsMock.mockReturnValue({ projectId: 'proj-2' });
    rerender(
      <AuthProvider>
        <ProjectLogsRequestsPage />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Request logs' })).getAllByRole('row'),
      ).toHaveLength(3),
    );

    stale.release?.();
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Request logs' })).getAllByRole('row'),
      ).toHaveLength(3),
    );
    expect(
      within(screen.getByRole('table', { name: 'Request logs' })).queryByText('DELETE'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('drops a page still in flight when the filter changes (F3)', async () => {
    const stale: { release: (() => void) | null } = { release: null };
    const { fetchMock } = stubRequestLogsApi({ pageSize: 2 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('cursor=')) {
          await new Promise<void>((resolve) => {
            stale.release = resolve;
          });
        }
        return fetchMock(input, init);
      }),
    );
    renderViewer();

    const table = await screen.findByRole('table', { name: 'Request logs' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(stale.release).not.toBeNull());

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'test' } });
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Request logs' })).getAllByRole('row'),
      ).toHaveLength(2),
    );

    stale.release?.();
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Request logs' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    expect(
      within(screen.getByRole('table', { name: 'Request logs' })).queryByText('DELETE'),
    ).toBeNull();
    expect(table).toBeInTheDocument();
  });

  it('copies a request id for issue reporting', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubRequestLogsApi();
    renderViewer();
    const table = await screen.findByRole('table', { name: 'Request logs' });

    fireEvent.click(within(table).getAllByRole('button', { name: 'Copy' })[0]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FIRST_ID));
    await within(table).findByRole('button', { name: 'Copied' });
  });

  it('surfaces the not-found state without asking for logs when the URL addresses another project', async () => {
    const { fetchMock } = stubRequestLogsApi({ failLogs: 'NOT_FOUND' });
    renderViewer();

    await screen.findByRole('heading', { level: 1, name: 'Project not found' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(logCalls(fetchMock)).toHaveLength(0);
  });

  it('reports a list failure as an error state instead of data', async () => {
    stubRequestLogsApi({ failList: 'INTERNAL_ERROR' });
    renderViewer();

    await screen.findByRole('alert');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No request logs yet.')).not.toBeInTheDocument();
  });

  it('shows the loading state until the first page arrives, and only then the list', async () => {
    stubRequestLogsApi();
    renderViewer();

    expect(screen.getByRole('heading', { level: 1, name: /Request logs/ })).toBeInTheDocument();
    expect(screen.getByText('Loading request logs…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await screen.findByRole('table', { name: 'Request logs' });
    expect(screen.queryByText('Loading request logs…')).not.toBeInTheDocument();
  });

  it('drops the previous project rows immediately on a client-side route change', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    stubRequestLogsApi();
    const { rerender } = render(
      <AuthProvider>
        <ProjectLogsRequestsPage />
      </AuthProvider>,
    );
    await screen.findByRole('table', { name: 'Request logs' });

    // Same component instance, different project: stale rows must never show.
    paramsMock.mockReturnValue({ projectId: 'proj-2' });
    rerender(
      <AuthProvider>
        <ProjectLogsRequestsPage />
      </AuthProvider>,
    );

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Loading request logs…')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Request logs' });
  });

  it('shows the empty state when the project has no records yet', async () => {
    stubRequestLogsApi({ logs: [] });
    renderViewer();

    await screen.findByText('No request logs yet.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
