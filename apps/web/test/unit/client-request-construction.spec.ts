import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPayment,
  createRefund,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getApiBaseUrl,
  listAuditLogs,
  listPayments,
  listRefunds,
  listRequestLogs,
  listWebhookDeliveries,
  login,
  logout,
  me,
  register,
  replayWebhookEvent,
  retrievePayment,
  updateOrganization,
} from '../../lib/brinnpay/client';

const TOKEN = 'test-access-token';

type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

/** Installs a fetch that answers `status`/`body` and records every call. */
function stubFetch(status: number, body: unknown = { data: [], next_cursor: null, has_more: false }) {
  const fetchMock = vi.fn(async (): Promise<unknown> => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: { mock: { calls: unknown[][] } }): FetchCall {
  const call = fetchMock.mock.calls.at(-1) as FetchCall | undefined;
  if (!call) throw new Error('expected fetch to have been called');
  return call;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('client request construction (phase 17 AC1 — apps/web/lib/brinnpay)', () => {
  it('prefixes API paths with the configured base URL and sends JSON with credentials', async () => {
    const fetchMock = stubFetch(200);
    await listPayments(TOKEN, 'proj-1');

    const [input, init] = lastCall(fetchMock);
    expect(String(input)).toBe(`${getApiBaseUrl()}/projects/proj-1/payments`);
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      }),
    );
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('serializes list queries, skipping absent and empty filters', async () => {
    const fetchMock = stubFetch(200);

    await listPayments(TOKEN, 'proj-1', { environment: 'test', limit: 5, cursor: 'cur-1' });
    expect(String(lastCall(fetchMock)[0])).toBe(
      `${getApiBaseUrl()}/projects/proj-1/payments?environment=test&limit=5&cursor=cur-1`,
    );

    // No filters → no query string at all.
    await listPayments(TOKEN, 'proj-1');
    expect(String(lastCall(fetchMock)[0])).toBe(`${getApiBaseUrl()}/projects/proj-1/payments`);

    // An empty request-id filter is dropped rather than sent as `request_id=`.
    await listRequestLogs(TOKEN, 'proj-1', { request_id: '' });
    expect(String(lastCall(fetchMock)[0])).toBe(
      `${getApiBaseUrl()}/projects/proj-1/logs/requests`,
    );

    await listRequestLogs(TOKEN, 'proj-1', { environment: 'test', request_id: 'req_1', limit: 10 });
    expect(String(lastCall(fetchMock)[0])).toBe(
      `${getApiBaseUrl()}/projects/proj-1/logs/requests?environment=test&request_id=req_1&limit=10`,
    );

    await listWebhookDeliveries(TOKEN, 'proj-1', 'we-1', { status: 'pending', cursor: 'c2' });
    expect(String(lastCall(fetchMock)[0])).toBe(
      `${getApiBaseUrl()}/projects/proj-1/webhook-endpoints/we-1/deliveries?status=pending&cursor=c2`,
    );
  });

  it('builds payment and refund mutations with the contracted method and JSON body', async () => {
    const fetchMock = stubFetch(201);
    const input = {
      environment: 'test' as const,
      customer_id: 'cus-1',
      amount: '10.00',
      currency: 'usd' as const,
      description: 'Smoke',
    };

    await createPayment(TOKEN, 'proj-1', input);
    let [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/projects/proj-1/payments`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(input));

    // Reads never carry a body.
    await retrievePayment(TOKEN, 'proj-1', 'pay-1');
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/projects/proj-1/payments/pay-1`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();

    // Refunds are addressed through the parent payment (phase 9).
    await createRefund(TOKEN, 'pay-2', { amount: '5.50', reason: 'retry' });
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/payments/pay-2/refunds`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ amount: '5.50', reason: 'retry' }));

    await listRefunds(TOKEN, 'pay-2', { limit: 2 });
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/payments/pay-2/refunds?limit=2`);
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('builds webhook management calls: endpoints, deliveries and replay', async () => {
    const fetchMock = stubFetch(200);
    const endpointInput = {
      environment: 'test' as const,
      url: 'https://example.com/hooks',
      event_types: ['payment.succeeded' as const],
    };

    await createWebhookEndpoint(TOKEN, 'proj-1', endpointInput);
    let [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/projects/proj-1/webhook-endpoints`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(endpointInput));

    await deleteWebhookEndpoint(TOKEN, 'proj-1', 'we-1');
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/projects/proj-1/webhook-endpoints/we-1`);
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();

    // Replay is a POST with no body and answers 202 with no payload (D12).
    await replayWebhookEvent(TOKEN, 'proj-1', 'we-1', 'evt-1');
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(
      `${getApiBaseUrl()}/projects/proj-1/webhook-endpoints/we-1/events/evt-1/replay`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('sends session routes without a bearer token (cookie-credential flow)', async () => {
    const fetchMock = stubFetch(200);

    await login('dev@example.com', 'password-123');
    let [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/auth/login`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'dev@example.com', password: 'password-123' }));
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(init?.credentials).toBe('include');

    await register({ email: 'dev@example.com', password: 'password-123' });
    [, init] = lastCall(fetchMock);
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    // Logout is idempotent and cookie-authorized, so it never carries a token.
    await logout();
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/auth/logout`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    // `me` is the one session read that is explicitly bearer-authorized.
    await me(TOKEN);
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/auth/me`);
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    );
  });

  it('builds organization-scoped reads and mutations with bearer authorization', async () => {
    const fetchMock = stubFetch(200);

    await listAuditLogs(TOKEN, 'org-1', { limit: 10, cursor: 'c1' });
    let [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/organizations/org-1/logs/audit?limit=10&cursor=c1`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    );

    await updateOrganization(TOKEN, 'org-1', 'Acme Sandbox');
    [url, init] = lastCall(fetchMock);
    expect(String(url)).toBe(`${getApiBaseUrl()}/organizations/org-1`);
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ name: 'Acme Sandbox' }));
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    );
  });
});
