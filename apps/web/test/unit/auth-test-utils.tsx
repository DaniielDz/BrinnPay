import { vi } from 'vitest';

import type { AuthSession } from '../../lib/brinnpay/client';

export const sessionFixture: AuthSession = {
  access_token: 'test-access-token',
  token_type: 'Bearer',
  expires_in: 900,
  user: {
    id: 'user-1',
    email: 'dev@example.com',
    name: 'Ada Lovelace',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  },
};

interface ApiBehaviour {
  /** `throttled` answers the refresh with a real `429` (phase 14 §7.3). */
  refresh?: 'ok' | 'fail' | 'throttled';
  login?: 'ok' | 'fail';
  register?: 'ok' | 'fail';
  logout?: 'ok' | 'fail';
}

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  // Phase 14: apiFetch reads RateLimit-*/Retry-After off the response, so every
  // stub must answer with a Headers object (empty by default, overridable).
  headers: Headers;
};

/**
 * Installs a scriptable global `fetch` for `/api/v1/auth/*` calls and returns
 * the mock so tests can inspect requests (URL, method, body, credentials).
 */
export function stubAuthApi(behaviour: ApiBehaviour = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
    const url = String(input);
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    const respond = (
      status: number,
      body?: unknown,
      headers: Record<string, string> = {},
    ): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? null,
      headers: new Headers(headers),
    });

    const fail = (
      code: string,
      message: string,
      status: number,
      headers: Record<string, string> = {},
    ) => respond(status, { error: { code, message } }, headers);

    if (url.endsWith('/auth/refresh')) {
      // Phase 3 §4.4: the refresh response is an `AccessTokenResponse` —
      // `access_token`, `token_type`, `expires_in` — and deliberately never
      // carries the user or the refresh token. Answering it with the full
      // session would let a provider that trusts the refresh body for identity
      // pass against this stub while failing against the real API (phase 17
      // D6: the strict assertion is the defect guard).
      if (behaviour.refresh === 'throttled') {
        return fail('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '42' });
      }
      return behaviour.refresh === 'fail'
        ? fail('UNAUTHENTICATED', 'Session invalid or expired', 401)
        : respond(200, {
            access_token: sessionFixture.access_token,
            token_type: sessionFixture.token_type,
            expires_in: sessionFixture.expires_in,
          });
    }
    if (url.endsWith('/auth/login')) {
      if (behaviour.login === 'fail') return fail('UNAUTHENTICATED', 'Invalid email or password', 401);
      return respond(200, { ...sessionFixture, user: { ...sessionFixture.user, email: String(payload?.email ?? sessionFixture.user.email) } });
    }
    if (url.endsWith('/auth/register')) {
      if (behaviour.register === 'fail') return fail('CONFLICT', 'email is already registered', 409);
      return respond(201, { ...sessionFixture, user: { ...sessionFixture.user, email: String(payload?.email ?? sessionFixture.user.email) } });
    }
    if (url.endsWith('/auth/logout')) {
      if (behaviour.logout === 'fail') return fail('UNAUTHENTICATED', 'Session invalid or expired', 401);
      return respond(204);
    }
    if (url.endsWith('/auth/me')) {
      if (behaviour.login === 'fail') return fail('UNAUTHENTICATED', 'Missing or invalid token', 401);
      return respond(200, sessionFixture.user);
    }
    return fail('NOT_FOUND', `No stub for ${url}`, 404);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubAuthApi(): void {
  vi.unstubAllGlobals();
}