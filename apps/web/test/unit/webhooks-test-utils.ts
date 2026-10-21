import { vi } from 'vitest';

import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEvent,
} from '../../lib/brinnpay/client';
import { memberFixtures, orgFixture, projectFixture, sessionFixture } from './projects-test-utils';

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  // Phase 14: apiFetch reads RateLimit-*/Retry-After off the response, so every
  // stub must answer with a Headers object (empty by default, overridable).
  headers: Headers;
};

export const endpointFixtures: WebhookEndpoint[] = [
  {
    id: 'we-1',
    project_id: projectFixture.id,
    environment: 'test',
    url: 'https://example.com/hooks/brinnpay',
    event_types: ['payment.created', 'payment.succeeded'],
    enabled: true,
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  },
  {
    id: 'we-2',
    project_id: projectFixture.id,
    environment: 'test',
    url: 'https://example.com/hooks/paused',
    event_types: ['refund.created'],
    enabled: false,
    created_at: '2026-09-24T01:00:00.000Z',
    updated_at: '2026-09-24T01:00:00.000Z',
  },
];

export function createdEndpointFixture(): WebhookEndpointCreated {
  return {
    ...endpointFixtures[0],
    id: 'we-new',
    url: 'https://example.com/hooks/new',
    event_types: ['payment.created'],
    signing_secret: 'whsec_Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FyZ2x5',
  };
}

export const eventFixtures: WebhookEvent[] = [
  {
    id: 'ev-1',
    project_id: projectFixture.id,
    environment: 'test',
    type: 'payment.succeeded',
    data: { id: 'pay-1', status: 'succeeded' },
    created_at: '2026-09-24T02:00:00.000Z',
  },
  {
    id: 'ev-2',
    project_id: projectFixture.id,
    environment: 'test',
    type: 'refund.created',
    data: { id: 'ref-1' },
    created_at: '2026-09-24T03:00:00.000Z',
  },
];

export const deliveryFixtures: WebhookDelivery[] = [
  {
    id: 'dl-1',
    endpoint_id: 'we-1',
    event_id: 'ev-1',
    status: 'delivered',
    attempts: 1,
    response_status: 200,
    last_error: null,
    next_attempt_at: null,
    is_replay: false,
    created_at: '2026-09-24T02:00:01.000Z',
    updated_at: '2026-09-24T02:00:01.000Z',
  },
  {
    id: 'dl-2',
    endpoint_id: 'we-1',
    event_id: 'ev-2',
    status: 'pending',
    attempts: 2,
    response_status: 500,
    last_error: 'HTTP 500',
    next_attempt_at: '2026-09-24T04:00:00.000Z',
    is_replay: false,
    created_at: '2026-09-24T03:00:01.000Z',
    updated_at: '2026-09-24T03:30:00.000Z',
  },
];

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

/** A cursor page as the client sees it, so pagination can be driven from a stub. */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface WebhooksApiBehaviour {
  failProjects?: string;
  /** Role of the calling member, to exercise the RBAC branches. */
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  endpoints?: WebhookEndpoint[];
  events?: WebhookEvent[];
  deliveries?: WebhookDelivery[];
  createEndpoint?: { ok: boolean; code?: string };
  replay?: { ok: boolean; code?: string; message?: string };
  /**
   * Pre-canned pages per resource, served in order: the first request (no
   * `cursor`) gets page one, a request carrying a cursor gets page two. When a
   * behaviour omits them, the resource answers with everything in a single page.
   */
  endpointPages?: CursorPage<WebhookEndpoint>[];
  eventPages?: CursorPage<WebhookEvent>[];
  deliveryPages?: CursorPage<WebhookDelivery>[];
  /** Latency for every response, so the loading state is observable. */
  delayMs?: number;
}

/**
 * Resolves the page a request is asking for. Canned pages win over `filtered`
 * (the fixtures and the filter) — a paging test drives the pages it declares.
 */
function pageFor<T>(
  pages: CursorPage<T>[] | undefined,
  fullUrl: string,
  fallback: T[],
  filtered?: T[],
): CursorPage<T> {
  if (!pages) return { data: filtered ?? fallback, next_cursor: null, has_more: false };
  const cursor = new URL(fullUrl).searchParams.get('cursor');
  return pages[cursor ? 1 : 0] ?? { data: [], next_cursor: null, has_more: false };
}

/**
 * Installs a scriptable `fetch` for the phase 10 webhooks page: the session
 * restore, the project/member lookups, and the whole webhook surface
 * (`webhook-endpoints`, `webhook-events`, deliveries, replay).
 */
export function stubWebhooksApi(behaviour: WebhooksApiBehaviour = {}) {
  const endpoints = behaviour.endpoints ?? endpointFixtures;
  const events = behaviour.events ?? eventFixtures;
  const deliveries = behaviour.deliveries ?? deliveryFixtures;
  const role = behaviour.role ?? 'owner';
  const members = memberFixtures.map((member) =>
    member.user_id === sessionFixture.user.id ? { ...member, role } : member,
  );

  const handle = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<FakeResponse> => {
    const fullUrl = String(input);
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const url = fullUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');

    if (url.endsWith('/auth/refresh')) return respond(200, sessionFixture);
    if (url.endsWith('/auth/me')) return respond(200, sessionFixture.user);

    const membersPath = url.match(/^\/organizations\/([^/]+)\/members(?:\?|$)/);
    if (membersPath) {
      return respond(200, { data: members, next_cursor: null, has_more: false });
    }

    if (url.match(/^\/organizations\/[^/]+(?:\?|$)/)) {
      return respond(200, orgFixture);
    }

    const replayPath = url.match(
      /^\/projects\/([^/]+)\/webhook-endpoints\/([^/]+)\/events\/([^/]+)\/replay(?:\?|$)/,
    );
    if (replayPath) {
      if (behaviour.replay?.ok === false) {
        return fail(
          behaviour.replay.code ?? 'BUSINESS_RULE_VIOLATION',
          behaviour.replay.message ?? 'The webhook endpoint cannot receive a replay of this event',
          behaviour.replay.code === 'NOT_FOUND' ? 404 : 422,
        );
      }
      return respond(202);
    }

    const deliveriesPath = url.match(/^\/projects\/([^/]+)\/webhook-endpoints\/([^/?]+)\/deliveries(?:\?|$)/);
    if (deliveriesPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      const status = new URL(fullUrl).searchParams.get('status');
      const filtered = status ? deliveries.filter((item) => item.status === status) : deliveries;
      return respond(200, pageFor(behaviour.deliveryPages, fullUrl, deliveries, filtered));
    }

    const endpointPath = url.match(/^\/projects\/([^/]+)\/webhook-endpoints(?:\/([^/?]+))?(?:\?|$)/);
    if (endpointPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      if (!endpointPath[2]) {
        if (method === 'POST') {
          if (behaviour.createEndpoint?.ok === false) {
            return fail(
              behaviour.createEndpoint.code ?? 'BUSINESS_RULE_VIOLATION',
              'url must be a valid absolute http(s) URL',
              422,
            );
          }
          return respond(201, createdEndpointFixture());
        }
        return respond(200, pageFor(behaviour.endpointPages, fullUrl, endpoints));
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Partial<WebhookEndpoint>;
        const current = endpoints.find((item) => item.id === endpointPath[2]) ?? endpoints[0];
        return respond(200, { ...current, ...body });
      }
      if (method === 'DELETE') return respond(204);
      const found = endpoints.find((item) => item.id === endpointPath[2]);
      if (!found) return fail('NOT_FOUND', 'Webhook endpoint not found', 404);
      return respond(200, found);
    }

    const eventsPath = url.match(/^\/projects\/([^/]+)\/webhook-events(?:\?|$)/);
    if (eventsPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      const type = new URL(fullUrl).searchParams.get('type');
      const filtered = type ? events.filter((event) => event.type === type) : events;
      return respond(200, pageFor(behaviour.eventPages, fullUrl, events, filtered));
    }

    const projectPath = url.match(/^\/projects\/([^/?]+)(?:\?|$)/);
    if (projectPath) {
      if (behaviour.failProjects) return fail(behaviour.failProjects, 'Project not found', 404);
      if (method === 'GET') return respond(200, projectFixture);
    }

    return fail('NOT_FOUND', `No stub for ${method} ${url}`, 404);
  };

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> => {
      if (behaviour.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      }
      return handle(input, init);
    },
  );

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
}

export function unstubWebhooksApi(): void {
  vi.unstubAllGlobals();
}
