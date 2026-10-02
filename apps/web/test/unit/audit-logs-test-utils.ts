import { vi } from 'vitest';

import type { AuditLogEntry, AuthSession } from '../../lib/brinnpay/client';
import { orgFixture, projectFixture, sessionFixture } from './projects-test-utils';

/**
 * Phase 12 §8 fixtures: the shapes the viewer must render — an authentication
 * entry (no project/environment), an access-control change with role fields,
 * a project-scoped payment with amounts, a coordination entry, and one whose
 * allowlist produced nothing (`data` omitted entirely).
 */
export const auditLogFixtures: AuditLogEntry[] = [
  {
    id: 'aud-1',
    organization_id: orgFixture.id,
    actor_type: 'user',
    actor_id: sessionFixture.user.id,
    action: 'user.logged_in',
    resource_type: 'user',
    resource_id: sessionFixture.user.id,
    project_id: null,
    environment: null,
    data: { request_id: 'req_11111111111111111111111111111111' },
    created_at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'aud-2',
    organization_id: orgFixture.id,
    actor_type: 'user',
    actor_id: sessionFixture.user.id,
    action: 'member.role_changed',
    resource_type: 'member',
    resource_id: 'user-member',
    project_id: null,
    environment: null,
    data: {
      previous_role: 'viewer',
      new_role: 'admin',
      request_id: 'req_22222222222222222222222222222222',
    },
    created_at: '2026-10-01T11:00:00.000Z',
  },
  {
    id: 'aud-3',
    organization_id: orgFixture.id,
    actor_type: 'api_key',
    actor_id: 'key-1',
    action: 'payment.created',
    resource_type: 'payment',
    resource_id: 'pay-1',
    project_id: projectFixture.id,
    environment: 'test',
    data: {
      amount: '12.34',
      currency: 'usd',
      request_id: 'req_33333333333333333333333333333333',
    },
    created_at: '2026-10-01T12:00:00.000Z',
  },
  {
    id: 'aud-4',
    organization_id: orgFixture.id,
    actor_type: 'user',
    actor_id: sessionFixture.user.id,
    action: 'api_key.revoked',
    resource_type: 'api_key',
    resource_id: 'key-2',
    project_id: projectFixture.id,
    environment: 'live',
    // Background and empty-allowlist entries carry no `data` at all (§4.2 rule 7).
    created_at: '2026-10-01T13:00:00.000Z',
  },
];

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const respond = (status: number, body?: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body ?? null,
});

const fail = (code: string, message: string, status: number): FakeResponse =>
  respond(status, { error: { code, message } });

export interface AuditLogsApiBehaviour {
  /** When set, the project and the entry list both answer with this code. */
  failProject?: string;
  /** When set, only the entry list answers with this code (list error state). */
  failList?: string;
  session?: AuthSession;
  entries?: AuditLogEntry[];
  /** Entries per page; the fixtures then need a "Load more" to be exhausted. */
  pageSize?: number;
}

/**
 * Installs a scriptable `fetch` for the phase 12 viewer: `/auth/*` (session
 * restore), the addressed project (scope resolution) and the organization's
 * `logs/audit` contract with cursor paging applied server-side — so the page
 * is exercised against real pagination semantics rather than a canned list.
 */
export function stubAuditLogsApi(behaviour: AuditLogsApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const activeEntries = behaviour.entries ?? auditLogFixtures;
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

      const auditPath = url.match(/^\/organizations\/([^/]+)\/logs\/audit(?:\?|$)/);
      if (auditPath) {
        if (behaviour.failProject) return fail(behaviour.failProject, 'Not found', 404);
        if (behaviour.failList) return fail(behaviour.failList, 'Internal error', 500);
        // Scope: only the addressed organization's entries are ever returned —
        // exactly what the API guarantees, so a wrong organization id would
        // surface here as an empty page rather than cross-tenant rows.
        const scoped =
          auditPath[1] === orgFixture.id
            ? activeEntries.filter((entry) => entry.organization_id === auditPath[1])
            : [];
        const query = new URLSearchParams(fullUrl.split('?')[1] ?? '');
        const cursor = query.get('cursor');
        const start = cursor === null ? 0 : Number(cursor);
        const page = scoped.slice(start, start + pageSize);
        const end = start + page.length;
        return respond(200, {
          data: page,
          next_cursor: end < scoped.length ? String(end) : null,
          has_more: end < scoped.length,
        });
      }

      const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
      if (projectPath) {
        if (behaviour.failProject) return fail(behaviour.failProject, 'Not found', 404);
        return respond(200, projectFixture);
      }

      return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubAuditLogsApi(): void {
  vi.unstubAllGlobals();
}
