import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardLayout from '../../app/(dashboard)/layout';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { resetRateLimitStore } from '../../lib/brinnpay/rate-limit';
import { stubProjectsApi, unstubProjectsApi } from '../unit/projects-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/dashboard/projects',
}));

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers: Headers;
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers),
  };
}

const session = {
  access_token: 'test-access-token',
  token_type: 'Bearer' as const,
  expires_in: 900,
  user: {
    id: 'user-owner',
    email: 'owner@example.com',
    name: 'Ada Lovelace',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  },
};

const projectListEnvelope = { data: [], next_cursor: null, has_more: false };

/**
 * The established stub plus an override for the project-list response, so a
 * test can decide what the throttled route answers (headers included).
 */
function stubProjectList(list: () => FakeResponse) {
  const stub = stubProjectsApi();
  const fallback = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/^\/api\/v1/, '');
      if (path.endsWith('/auth/refresh')) return respond(200, session);
      // Session restore pairs the refresh with `GET /auth/me` (phase 3 §4.4).
      if (path.endsWith('/auth/me')) return respond(200, session.user);
      if (/\/projects(?:\?|$)/.test(path)) return list();
      return fallback(input, init);
    }),
  );
  return stub;
}

afterEach(() => {
  cleanup();
  unstubProjectsApi();
  resetRateLimitStore();
});

/**
 * Phase 14 §11.1 — 429 presentation smoke (phase 13 §7 handover, D6/D8): a
 * throttled response is rendered as retryable with its `Retry-After` hint, and
 * the reported budget surfaces in the shell. No authorization wording, no
 * rate-limit internals.
 */
describe('rate-limit smoke test (phase 14 §7.3/§7.4)', () => {
  it('renders a throttled response as retryable with the delay', async () => {
    stubProjectList(() =>
      respond(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        { 'Retry-After': '42', 'RateLimit-Limit': '60', 'RateLimit-Remaining': '0' },
      ),
    );

    render(
      <AuthProvider>
        <DashboardLayout>
          <ProjectsPage />
        </DashboardLayout>
      </AuthProvider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many requests/i);
    expect(alert).toHaveTextContent(/try again in 42 seconds/i);
    expect(alert).not.toHaveTextContent(/permission|session|expired|forbidden|sign in again/i);
    // The view stays usable and leaks no rate-limit internals.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/RateLimit-Limit|scope|class name/i);
  });

  it('stays silent without rate-limit headers', async () => {
    stubProjectsApi();

    render(
      <AuthProvider>
        <DashboardLayout>
          <ProjectsPage />
        </DashboardLayout>
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it('surfaces the reported budget in the shell once a response reports it', async () => {
    stubProjectList(() =>
      respond(
        200,
        projectListEnvelope,
        { 'RateLimit-Limit': '60', 'RateLimit-Remaining': '42', 'RateLimit-Reset': '42' },
      ),
    );

    render(
      <AuthProvider>
        <DashboardLayout>
          <ProjectsPage />
        </DashboardLayout>
      </AuthProvider>,
    );

    // The indicator's text is split across spans (number / limit / reset), so
    // the rendered value is asserted from the document text, not from markup.
    await waitFor(() => expect(document.body.textContent).toMatch(/42\s*\/\s*60 left/));
    expect(document.body.textContent).toMatch(/resets in 42 seconds/);
    // Only budget numbers: never a class, scope or bucket key.
    expect(document.body.textContent).not.toMatch(/bucket|redis|scope/i);
  });
});
