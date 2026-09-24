import { vi } from 'vitest';

import type {
  ApiKey,
  ApiKeyCreated,
  AuthSession,
  Organization,
  OrganizationMember,
  Project,
} from '../../lib/brinnpay/client';

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

export const projectFixture: Project = {
  id: 'proj-1',
  organization_id: orgFixture.id,
  name: 'Payments API',
  created_at: '2026-09-20T00:00:00.000Z',
  updated_at: '2026-09-20T00:00:00.000Z',
  environments: ['test', 'live'],
};

export const apiKeyFixtures: ApiKey[] = [
  {
    id: 'key-1',
    project_id: projectFixture.id,
    environment: 'test',
    created_at: '2026-09-21T00:00:00.000Z',
    revoked_at: null,
  },
  {
    id: 'key-2',
    project_id: projectFixture.id,
    environment: 'live',
    created_at: '2026-09-21T01:00:00.000Z',
    revoked_at: '2026-09-22T01:00:00.000Z',
  },
];

/** A create response shape matching the contract's `ApiKeyCreated`. */
export function createdKeyFixture(environment: 'test' | 'live'): ApiKeyCreated {
  return {
    id: 'key-new',
    project_id: projectFixture.id,
    environment,
    created_at: '2026-09-23T00:00:00.000Z',
    revoked_at: null,
    key: `sk_${environment}_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn`,
  };
}

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

export interface ProjectsApiBehaviour {
  /** When set, every project-scoped route returns this code (e.g. NOT_FOUND). */
  failProjects?: string;
  listProjects?: { ok: boolean; code?: string };
  createProject?: { ok: boolean; code?: string };
  createApiKey?: { ok: boolean; code?: string };
  session?: AuthSession;
  projects?: Project[];
  apiKeys?: ApiKey[];
}

/**
 * Installs a scriptable `fetch` for the phase 5 web UI: `/auth/*` (session
 * restore) plus the organizations, project, and API-key routes of the API
 * contract. Returns the mock so tests can assert on requests.
 */
export function stubProjectsApi(behaviour: ProjectsApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const activeProjects = behaviour.projects ?? [projectFixture];
  const activeKeys = behaviour.apiKeys ?? apiKeyFixtures;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
    const fullUrl = String(input);
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const url = fullUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');

    if (url.endsWith('/auth/refresh')) {
      return respond(200, activeSession);
    }
    if (url.endsWith('/auth/me')) {
      return respond(200, activeSession.user);
    }

    const membersPath = url.match(/^\/organizations\/([^/]+)\/members(?:\?|$)/);
    if (membersPath) return respond(200, { data: memberFixtures, next_cursor: null, has_more: false });

    const listOrgsPath = url.match(/^\/organizations(?:\?|$)/);
    if (listOrgsPath) {
      if (method === 'POST') return respond(201, orgFixture);
      return respond(200, { data: [orgFixture], next_cursor: null, has_more: false });
    }

    const keyDeletePath = url.match(/^\/projects\/([^/]+)\/api-keys\/([^/?]+)/);
    if (keyDeletePath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      return respond(204);
    }

    const apiKeysPath = url.match(/^\/projects\/([^/]+)\/api-keys(?:\?|$)/);
    if (apiKeysPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      if (method === 'POST') {
        if (behaviour.createApiKey?.ok === false) {
          return fail(behaviour.createApiKey.code ?? 'FORBIDDEN', 'Insufficient permissions', 403);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment: 'test' | 'live' };
        return respond(201, createdKeyFixture(body.environment));
      }
      return respond(200, { data: activeKeys, next_cursor: null, has_more: false });
    }

    const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
    if (projectPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      if (method === 'GET') return respond(200, activeProjects[0]);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
        return respond(200, { ...activeProjects[0], name: body.name });
      }
      if (method === 'DELETE') return respond(204);
    }

    const listProjectsPath = url.match(/^\/projects(?:\?|$)/);
    if (listProjectsPath) {
      if (behaviour.listProjects?.ok === false) {
        return fail(behaviour.listProjects.code ?? 'INTERNAL_ERROR', 'Request failed', 500);
      }
      if (method === 'POST') {
        if (behaviour.createProject?.ok === false) {
          return fail(behaviour.createProject.code ?? 'FORBIDDEN', 'Insufficient permissions', 403);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
        return respond(201, { ...projectFixture, name: body.name });
      }
      return respond(200, { data: activeProjects, next_cursor: null, has_more: false });
    }

    return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubProjectsApi(): void {
  vi.unstubAllGlobals();
}