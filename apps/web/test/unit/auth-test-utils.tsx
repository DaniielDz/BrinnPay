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
  refresh?: 'ok' | 'fail';
  login?: 'ok' | 'fail';
  register?: 'ok' | 'fail';
  logout?: 'ok' | 'fail';
}

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/**
 * Installs a scriptable global `fetch` for `/api/v1/auth/*` calls and returns
 * the mock so tests can inspect requests (URL, method, body, credentials).
 */
export function stubAuthApi(behaviour: ApiBehaviour = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
    const url = String(input);
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    const respond = (status: number, body?: unknown): FakeResponse => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? null,
    });

    const fail = (code: string, message: string, status: number) => respond(status, { error: { code, message } });

    if (url.endsWith('/auth/refresh')) {
      return behaviour.refresh === 'fail'
        ? fail('UNAUTHENTICATED', 'Session invalid or expired', 401)
        : respond(200, sessionFixture);
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