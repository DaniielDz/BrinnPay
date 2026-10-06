import { vi } from 'vitest';

import type { AuthSession, RequestLog } from '../../lib/brinnpay/client';
import { projectFixture, sessionFixture } from './projects-test-utils';

/**
 * Phase 11 §7 fixtures: metadata-only records across both environments plus an
 * environment-less one (D1), one session call, one API-key call, and one
 * public call — exactly the actor shapes the viewer has to distinguish.
 */
export const requestLogFixtures: RequestLog[] = [
  {
    id: 'log-1',
    request_id: 'req_11111111111111111111111111111111',
    project_id: projectFixture.id,
    organization_id: 'org-1',
    user_id: sessionFixture.user.id,
    api_key_id: null,
    environment: 'test',
    method: 'POST',
    path: '/api/v1/customers',
    status_code: 201,
    duration_ms: 14,
    created_at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'log-2',
    request_id: 'req_22222222222222222222222222222222',
    project_id: projectFixture.id,
    organization_id: 'org-1',
    user_id: null,
    api_key_id: 'key-1',
    environment: null,
    method: 'GET',
    path: '/api/v1/payments/pay-1',
    status_code: 200,
    duration_ms: 9,
    created_at: '2026-10-01T11:00:00.000Z',
  },
  {
    id: 'log-3',
    request_id: 'req_33333333333333333333333333333333',
    project_id: projectFixture.id,
    organization_id: 'org-1',
    user_id: sessionFixture.user.id,
    api_key_id: null,
    environment: 'live',
    method: 'DELETE',
    path: '/api/v1/customers/cust-1',
    status_code: 404,
    created_at: '2026-10-01T12:00:00.000Z',
  },
];

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  // Phase 14: apiFetch reads RateLimit-*/Retry-After off the response, so every
  // stub must answer with a Headers object (empty by default, overridable).
  headers: Headers;
};

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
): FakeResponse => respond(status, { error: { code, message } }, headers);

export interface RequestLogsApiBehaviour {
  /** When set, the project and the log list both answer with this code. */
  failLogs?: string;
  /** When set, only the log list answers with this code (list error state). */
  failList?: string;
  session?: AuthSession;
  logs?: RequestLog[];
  /** Records per page; the fixtures then need a "Load more" to be exhausted. */
  pageSize?: number;
}

/**
 * Installs a scriptable `fetch` for the phase 11 viewer: `/auth/*` (session
 * restore), the addressed project (access), and the `logs/requests` contract
 * with the D1 environment filter, the D8 request-id lookup and cursor paging
 * applied server-side — so the page is exercised against real filter
 * semantics rather than a canned list.
 */
export function stubRequestLogsApi(behaviour: RequestLogsApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const activeLogs = behaviour.logs ?? requestLogFixtures;
  const pageSize = behaviour.pageSize ?? 2;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
      const fullUrl = String(input);
      const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');

      if (url.endsWith('/auth/refresh')) {
        return respond(200, activeSession);
      }
      if (url.endsWith('/auth/me')) {
        return respond(200, activeSession.user);
      }

      const logsPath = url.match(/^\/projects\/([^/]+)\/logs\/requests(?:\?|$)/);
      if (logsPath) {
        if (behaviour.failLogs) return fail(behaviour.failLogs, 'Project not found', 404);
        if (behaviour.failList) return fail(behaviour.failList, 'Internal error', 500);
        const query = new URLSearchParams(fullUrl.split('?')[1] ?? '');
        const environment = query.get('environment');
        const requestId = query.get('request_id');
        const cursor = query.get('cursor');
        let filtered = activeLogs;
        if (environment !== null) filtered = filtered.filter((entry) => entry.environment === environment);
        if (requestId !== null) filtered = filtered.filter((entry) => entry.request_id === requestId);
        const start = cursor === null ? 0 : Number(cursor);
        const page = filtered.slice(start, start + pageSize);
        const end = start + page.length;
        return respond(200, {
          data: page,
          next_cursor: end < filtered.length ? String(end) : null,
          has_more: end < filtered.length,
        });
      }

      const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
      if (projectPath) {
        if (behaviour.failLogs) return fail(behaviour.failLogs, 'Project not found', 404);
        return respond(200, projectFixture);
      }

      return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubRequestLogsApi(): void {
  vi.unstubAllGlobals();
}
