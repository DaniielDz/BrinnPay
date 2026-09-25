import { vi } from 'vitest';

import type {
  AuthSession,
  CreateCustomerInput,
  Customer,
  UpdateCustomerInput,
} from '../../lib/brinnpay/client';
import {
  memberFixtures,
  projectFixture,
  sessionFixture,
} from './projects-test-utils';

export const customerFixtures: Customer[] = [
  {
    id: 'cust-1',
    project_id: projectFixture.id,
    environment: 'test',
    email: 'alice@example.com',
    name: 'Alice Example',
    metadata: { plan: 'pro' },
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  },
  {
    id: 'cust-2',
    project_id: projectFixture.id,
    environment: 'test',
    email: 'bob@example.com',
    name: null,
    metadata: {},
    created_at: '2026-09-24T01:00:00.000Z',
    updated_at: '2026-09-24T01:00:00.000Z',
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

export interface CustomersApiBehaviour {
  /** When set, every customer route returns this code (e.g. NOT_FOUND). */
  failCustomers?: string;
  session?: AuthSession;
  customers?: Customer[];
}

/**
 * Installs a scriptable `fetch` for the phase 6 customers UI: `/auth/*`
 * (session restore), the owning org's members (caller role), the project
 * (access), and the customers CRUD + search routes of the API contract.
 * Mirrors `stubProjectsApi` so the two suites stay independent.
 */
export function stubCustomersApi(behaviour: CustomersApiBehaviour = {}) {
  const activeSession = behaviour.session ?? sessionFixture;
  const activeCustomers = behaviour.customers ?? customerFixtures;
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

      const membersPath = url.match(/^\/organizations\/([^/]+)\/members(?:\?|$)/);
      if (membersPath) return respond(200, { data: memberFixtures, next_cursor: null, has_more: false });

      const customerPath = url.match(/^\/projects\/([^/]+)\/customers\/([^/?]+)(?:\?|$)/);
      if (customerPath) {
        const customerId = customerPath[2];
        if (behaviour.failCustomers) return fail(behaviour.failCustomers, 'Project not found', 404);
        if (method === 'GET') {
          const customer = activeCustomers.find((entry) => entry.id === customerId);
          if (!customer) return fail('NOT_FOUND', 'Customer not found', 404);
          return respond(200, customer);
        }
        if (method === 'PATCH') {
          const customer = activeCustomers.find((entry) => entry.id === customerId);
          if (!customer) return fail('NOT_FOUND', 'Customer not found', 404);
          const body = JSON.parse(String(init?.body ?? '{}')) as UpdateCustomerInput;
          return respond(200, {
            ...customer,
            email: body.email ?? customer.email,
            name: body.name ?? customer.name,
            metadata: body.metadata ?? customer.metadata,
          });
        }
        if (method === 'DELETE') return respond(204);
        // Unreachable in the UI; keep the dispatcher exhaustive for tests.
        throw new Error(`No stub for ${method} ${url}`);
      }

      const customersListPath = url.match(/^\/projects\/([^/]+)\/customers(?:\?|$)/);
      if (customersListPath) {
        const projectId = customersListPath[1];
        if (behaviour.failCustomers) return fail(behaviour.failCustomers, 'Project not found', 404);
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as CreateCustomerInput;
          const created: Customer = {
            id: 'cust-new',
            project_id: projectId,
            environment: body.environment,
            email: body.email,
            name: body.name ?? null,
            metadata: body.metadata ?? {},
            created_at: '2026-09-25T00:00:00.000Z',
            updated_at: '2026-09-25T00:00:00.000Z',
          };
          return respond(201, created);
        }
        const query = new URLSearchParams(fullUrl.split('?')[1] ?? '');
        const search = (query.get('search') ?? '').toLowerCase();
        const filtered =
          search === ''
            ? activeCustomers
            : activeCustomers.filter(
                (entry) =>
                  entry.email.toLowerCase().includes(search) ||
                  (entry.name?.toLowerCase().includes(search) ?? false),
              );
        return respond(200, { data: filtered, next_cursor: null, has_more: false });
      }

      const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
      if (projectPath) {
        if (behaviour.failCustomers) return fail(behaviour.failCustomers, 'Project not found', 404);
        return respond(200, projectFixture);
      }

      return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubCustomersApi(): void {
  vi.unstubAllGlobals();
}