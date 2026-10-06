import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import { AuthProvider, useAuth } from '../../components/auth/auth-provider';
import { ApiClientError, listOrganizations } from '../../lib/brinnpay/client';
import { resetRateLimitStore } from '../../lib/brinnpay/rate-limit';
import { setUnauthorizedRecovery } from '../../lib/brinnpay/session';
import { sessionFixture } from './auth-test-utils';

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

function envelope(code: string, message: string, requestId?: string): unknown {
  return { error: { code, message, ...(requestId ? { request_id: requestId } : {}) } };
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    return err as ApiClientError;
  }
  throw new Error('expected the call to reject');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setUnauthorizedRecovery(null);
  resetRateLimitStore();
});

/**
 * Phase 14 §7.3 (D6): one presentation rule, composed once in the API client,
 * so every page that renders `err.message` in a `role="alert"` shows the same
 * wording. Phase 13 handover: a `429` is retryable, never an authorization or
 * data problem.
 */
describe('error presentation (phase 14 §7.3, D6)', () => {
  it('presents 429 as retryable and includes the Retry-After delay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(429, envelope('RATE_LIMITED', 'Too many requests'), { 'Retry-After': '42' }),
      ),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.message).toMatch(/too many requests/i);
    expect(err.message).toMatch(/try again in 42 seconds/i);
    // Never an authorization, session or data failure (phase 13 §7 handover).
    expect(err.message).not.toMatch(/permission|session|expired|sign in again|forbidden/i);
  });

  it('presents 429 without a Retry-After hint as a transient wait', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(429, envelope('RATE_LIMITED', 'Too many requests'))),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.message).toMatch(/too many requests/i);
    expect(err.message).toMatch(/try again/i);
    expect(err.message).not.toMatch(/permission|session|expired|forbidden/i);
  });

  it('presents a mid-session 401 as re-authenticate, recovered by refresh and retry', async () => {
    const fetchMock = vi
      .fn()
      // First attempt: expired access token.
      .mockResolvedValueOnce(respond(401, envelope('UNAUTHENTICATED', 'Missing or invalid token')))
      // Retry after the recovery handler refreshed the session.
      .mockResolvedValueOnce(
        respond(200, { data: [], next_cursor: null, has_more: false }),
      );
    vi.stubGlobal('fetch', fetchMock);
    setUnauthorizedRecovery(async () => 'fresh-access-token');

    const page = await listOrganizations('stale-access-token');
    expect(page.data).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1];
    expect((retryInit as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fresh-access-token',
    });
  });

  it('presents an unrecoverable 401 as a session message, not a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, envelope('UNAUTHENTICATED', 'Missing or invalid token'))),
    );
    // No recovery handler registered (public surface / failed refresh).

    const err = await expectApiError(listOrganizations('stale-access-token'));
    expect(err.message).toMatch(/session has expired/i);
    expect(err.message).toMatch(/sign in again/i);
    expect(err.message).not.toMatch(/permission|forbidden/i);
  });

  // Two requests failing with 401 at the same time must produce exactly one
  // refresh: the refresh cookie is single-use and rotated, so parallel
  // refreshes with the same cookie would trip the API's reuse detection and
  // revoke every session of the user (security review H-1, phase 14 §7.3).
  it('coalesces concurrent 401s into a single shared refresh', async () => {
    const recovery = vi.fn(async () => {
      // Long enough for the second 401 to arrive while this refresh runs.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'fresh-access-token';
    });
    setUnauthorizedRecovery(recovery);

    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return respond(401, envelope('UNAUTHENTICATED', 'Missing or invalid token'));
      return respond(200, { data: [], next_cursor: null, has_more: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      listOrganizations('stale-access-token'),
      listOrganizations('stale-access-token'),
    ]);

    expect(first.data).toEqual([]);
    expect(second.data).toEqual([]);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4); // two 401s + two retries
  });

  it('presents 403 as the permission refusal from the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(403, envelope('FORBIDDEN', 'Insufficient permissions'))),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/insufficient permissions/i);
  });

  it('keeps 404 as the API message with the status preserved (not-found semantics)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(404, envelope('NOT_FOUND', 'Organization not found'))),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/organization not found/i);
  });

  it('appends the request id for the issue-reporting flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(400, envelope('VALIDATION_ERROR', 'Name is required', 'req_abc123')),
      ),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.requestId).toBe('req_abc123');
    expect(err.message).toMatch(/\(request id: req_abc123\)/);
  });

  it('presents 5xx as a generic retryable failure with no internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(500, envelope('INTERNAL_ERROR', 'Something went wrong', 'req_9'))),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/please try again/i);
    expect(err.message).toMatch(/\(request id: req_9\)/);
    expect(err.message).not.toMatch(/stack|postgres|connection string|localhost:/i);
  });

  it('presents a network failure as a retryable, generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const err = await expectApiError(listOrganizations('test-access-token'));
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toMatch(/could not be completed/i);
    expect(err.message).not.toMatch(/failed to fetch|TypeError/i);
  });
});

/**
 * Page-level rendering of the same rule (§7.3): the message lands in a
 * `role="alert"`, which is how every view surfaces API failures.
 */
describe('throttled responses rendered by a view (phase 14 §7.3/§7.4)', () => {
  it('renders the retryable 429 in an alert with the delay and no authorization wording', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          return respond(200, {
            access_token: 'test-access-token',
            token_type: 'Bearer',
            expires_in: 900,
            user: {
              id: 'user-owner',
              email: 'owner@example.com',
              name: 'Ada Lovelace',
              created_at: '2026-09-19T00:00:00.000Z',
              updated_at: '2026-09-19T00:00:00.000Z',
            },
          });
        }
        expect(init?.method ?? 'GET').toBe('GET');
        return respond(429, envelope('RATE_LIMITED', 'Too many requests'), {
          'Retry-After': '42',
          'RateLimit-Limit': '60',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': '42',
        });
      }),
    );

    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many requests/i);
    expect(alert).toHaveTextContent(/try again in 42 seconds/i);
    expect(alert).not.toHaveTextContent(/permission|session|expired|forbidden|sign in again/i);
    // The view renders the retryable state — no data, no crash.
    expect(screen.queryByText('Payments API')).not.toBeInTheDocument();
  });
});

/**
 * Session resilience (security review L-6, phase 14 §7.3): only an actual
 * rejection of the refresh clears the session. A transport failure is not
 * evidence that the session is gone, so it must never sign the user out.
 */
describe('session recovery resilience (phase 14 §7.3)', () => {
  it('keeps the session when the recovery refresh fails on the network', async () => {
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          refreshCalls += 1;
          if (refreshCalls === 1) return respond(200, sessionFixture);
          throw new TypeError('Failed to fetch'); // network blip mid-session
        }
        return respond(401, envelope('UNAUTHENTICATED', 'Missing or invalid token'));
      }),
    );

    let status: string | undefined;
    function Probe() {
      status = useAuth().status;
      return null;
    }

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(status).toBe('authenticated'));

    // A mid-session 401 triggers recovery; the refresh fails on the network.
    const err = await expectApiError(listOrganizations('stale-access-token'));
    expect(err.status).toBe(401);

    await waitFor(() => expect(refreshCalls).toBe(2));
    // The session survives a blip: retryable, not a sign-out.
    expect(status).toBe('authenticated');
  });
});
