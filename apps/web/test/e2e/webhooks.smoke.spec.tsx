import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WebhooksPage from '../../app/(dashboard)/dashboard/projects/[projectId]/webhooks/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { projectFixture } from '../unit/projects-test-utils';
import { stubWebhooksApi, unstubWebhooksApi } from '../unit/webhooks-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

/**
 * Phase 10 flow at smoke level (established jsdom pattern): the environment's
 * endpoints and event catalog load after the session resolves, and a scripted
 * registration returns the signing secret exactly once. The deep behavior
 * (replay, toggles, delivery table) lives in `webhooks-pages.spec.tsx`; real
 * browsers are Phase 17 D1.
 */
describe('webhooks smoke test (phase 10 §5.1)', () => {
  afterEach(() => {
    unstubWebhooksApi();
    paramsMock.mockClear();
    searchParamsMock.mockClear();
  });

  it('loads the endpoint list and registers an endpoint in the scripted flow', async () => {
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    searchParamsMock.mockReturnValue(new URLSearchParams({ environment: 'test' }));
    const { fetchMock } = stubWebhooksApi();
    render(
      <AuthProvider>
        <WebhooksPage />
      </AuthProvider>,
    );

    // Load: env-scoped endpoints through the session bearer.
    await screen.findByRole('heading', { level: 2, name: 'Endpoints' });
    expect(screen.getByRole('heading', { level: 1, name: /Webhooks/ })).toBeInTheDocument();
    expect(await screen.findByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/hooks/paused')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${projectFixture.id}/webhook-endpoints?environment=test`),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );

    // Scripted registration → POST → the secret shown once, never stored.
    fireEvent.change(screen.getByLabelText(/Destination URL/i), {
      target: { value: 'https://example.com/hooks/smoke' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Register endpoint/i }));
    const region = await screen.findByRole('region', { name: /New webhook signing secret/i });
    expect(within(region).getByText(/Shown once — copy it now/i)).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'POST' && String(input).includes('/webhook-endpoints'),
      ),
    ).toBe(true);
  });
});
