import { vi } from 'vitest';

import type { AuthSession, Invitation, Organization, OrganizationMember } from '../../lib/brinnpay/client';

export const sessionFixture: AuthSession = {
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
};

export const orgFixture: Organization = {
  id: 'org-1',
  name: 'Acme Sandbox',
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
};

export const memberFixtures: OrganizationMember[] = [
  {
    id: 'm-owner',
    organization_id: orgFixture.id,
    user_id: 'user-owner',
    role: 'owner',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    user: { id: 'user-owner', email: 'owner@example.com', name: 'Ada Lovelace' },
  },
  {
    id: 'm-admin',
    organization_id: orgFixture.id,
    user_id: 'user-admin',
    role: 'admin',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    user: { id: 'user-admin', email: 'admin@example.com', name: 'Grace Hopper' },
  },
  {
    id: 'm-member',
    organization_id: orgFixture.id,
    user_id: 'user-member',
    role: 'member',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    user: { id: 'user-member', email: 'member@example.com', name: 'Linus Pauling' },
  },
  {
    id: 'm-viewer',
    organization_id: orgFixture.id,
    user_id: 'user-viewer',
    role: 'viewer',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    user: { id: 'user-viewer', email: 'viewer@example.com', name: 'Katherine Johnson' },
  },
];

export const invitationFixtures: Invitation[] = [
  {
    id: 'inv-1',
    organization_id: orgFixture.id,
    email: 'pending@example.com',
    role: 'member',
    status: 'pending',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    accepted_at: null,
    canceled_at: null,
  },
  {
    id: 'inv-2',
    organization_id: orgFixture.id,
    email: 'accepted@example.com',
    role: 'admin',
    status: 'accepted',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    accepted_at: '2026-09-19T01:00:00.000Z',
    canceled_at: null,
  },
];

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const respond = (status: number, body?: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body ?? null,
});

const fail = (code: string, message: string, status: number): FakeResponse =>
  respond(status, { error: { code, message } });

export interface OrganisationsApiBehaviour {
  /** When falsy, mutations/reads behave as the happy path; when a code, the
   *  matching route returns the canonical error envelope instead. */
  failOrganizations?: string; // e.g. 'NOT_FOUND' for every org-scoped call
  createOrg?: { ok: boolean; code?: string };
  acceptInvitation?: { ok: boolean; code?: string };
  listOrgs?: { ok: boolean; code?: string };
  members?: { ok: boolean; code?: string };
  /** Session the `/auth/refresh` stub returns (defaults to the owner fixture). */
  session?: AuthSession;
}

/**
 * Installs a scriptable `fetch` for the phase 4 web UI: `/auth/*` (session
 * restore) plus the organizations, members, and invitations routes of the API
 * contract. Returns the mock so tests can assert on requests.
 */
export function stubOrganizationsApi(behaviour: OrganisationsApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
    const fullUrl = String(input);
    const method = (init?.method ?? 'GET') as Method;
    // Normalize to the API-relative path (`/api/v1/...` → `/...`).
    const url = fullUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');

    if (url.endsWith('/auth/refresh')) {
      return respond(200, activeSession);
    }
    if (url.endsWith('/auth/me')) {
      return respond(200, activeSession.user);
    }

    const memberPath = url.match(/^\/organizations\/([^/]+)\/members\/([^/?]+)/);
    if (memberPath) {
      if (behaviour.failOrganizations) return fail(behaviour.failOrganizations, 'Organization not found', 404);
      if (method === 'PATCH') {
        const [, , userId] = memberPath;
        const member = memberFixtures.find((m) => m.user_id === userId) ?? memberFixtures[0];
        return respond(200, { ...member, role: JSON.parse(String(init?.body ?? '{}')).role });
      }
      if (method === 'DELETE') return respond(204);
    }

    const membersPath = url.match(/^\/organizations\/([^/]+)\/members(?:\?|$)/);
    if (membersPath) {
      if (behaviour.failOrganizations || behaviour.members?.ok === false) {
        return fail(behaviour.members?.code ?? 'NOT_FOUND', 'Organization not found', 404);
      }
      return respond(200, { data: memberFixtures, next_cursor: null, has_more: false });
    }

    const invitationPath = url.match(/^\/organizations\/([^/]+)\/invitations\/([^/?]+)/);
    if (invitationPath) {
      if (behaviour.failOrganizations) return fail(behaviour.failOrganizations, 'Organization not found', 404);
      if (method === 'DELETE') return respond(204);
    }

    const invitationsPath = url.match(/^\/organizations\/([^/]+)\/invitations(?:\?|$)/);
    if (invitationsPath) {
      if (behaviour.failOrganizations) return fail(behaviour.failOrganizations, 'Organization not found', 404);
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return respond(201, {
          id: 'inv-new',
          organization_id: invitationsPath[1],
          email: body.email,
          role: body.role,
          status: 'pending',
          created_at: '2026-09-19T00:00:00.000Z',
          updated_at: '2026-09-19T00:00:00.000Z',
          accepted_at: null,
          canceled_at: null,
        });
      }
      return respond(200, { data: invitationFixtures, next_cursor: null, has_more: false });
    }

    const acceptPath = url.match(/^\/invitations\/([^/]+)\/accept$/);
    if (acceptPath) {
      if (behaviour.acceptInvitation?.ok === false) {
        return fail(behaviour.acceptInvitation.code ?? 'NOT_FOUND', 'Invitation not found', 404);
      }
      return respond(201, memberFixtures[2]);
    }

    const orgPath = url.match(/^\/organizations\/([^/?]+)(?:\?|$)/);
    if (orgPath) {
      if (behaviour.failOrganizations) return fail(behaviour.failOrganizations, 'Organization not found', 404);
      if (method === 'GET') return respond(200, orgFixture);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return respond(200, { ...orgFixture, name: body.name, updated_at: '2026-09-19T02:00:00.000Z' });
      }
      if (method === 'DELETE') return respond(204);
    }

    const listOrgsPath = url.match(/^\/organizations(?:\?|$)/);
    if (listOrgsPath) {
      if (behaviour.listOrgs?.ok === false) {
        return fail(behaviour.listOrgs.code ?? 'INTERNAL_ERROR', 'Request failed', 500);
      }
      if (method === 'POST') return respond(201, orgFixture);
      return respond(200, { data: [orgFixture], next_cursor: null, has_more: false });
    }

    return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubOrganizationsApi(): void {
  vi.unstubAllGlobals();
}