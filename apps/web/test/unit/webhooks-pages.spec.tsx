import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WebhooksPage from '../../app/(dashboard)/dashboard/projects/[projectId]/webhooks/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import {
  deliveryFixtures,
  endpointFixtures,
  eventFixtures,
  stubWebhooksApi,
  unstubWebhooksApi,
} from './webhooks-test-utils';
import type { WebhookDelivery, WebhookEndpoint, WebhookEvent } from '../../lib/brinnpay/client';

/** The route params/search params the App Router would provide. */
const useParamsMock = vi.fn(() => ({ projectId: 'proj-1' }));
const useSearchParamsMock = vi.fn(
  () => new URLSearchParams('environment=test') as unknown as Readonly<URLSearchParams>,
);

vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

async function renderPage() {
  render(
    <AuthProvider>
      <WebhooksPage />
    </AuthProvider>,
  );
  // The loading state renders the same heading, so wait for the loaded data.
  await screen.findByRole('heading', { level: 2, name: 'Endpoints' });
}

/** The events area, so catalog names are not confused with the form checkboxes. */
function eventsRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Webhook events' });
}

/** Event types as listed; the filter `<option>`s share the same names. */
function listedEventTypes(): (string | null)[] {
  return Array.from(eventsRegion().querySelectorAll('.event-type')).map(
    (node) => node.textContent,
  );
}

describe('project webhooks page (phase 10 §7)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    unstubWebhooksApi();
    vi.restoreAllMocks();
  });

  it('lists the environment endpoints and events from the API', async () => {
    stubWebhooksApi();
    await renderPage();

    // The route heading carries the environment badge, so match on the prefix.
    expect(screen.getByRole('heading', { level: 1, name: /Webhooks/ })).toBeInTheDocument();

    expect(await screen.findByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/hooks/paused')).toBeInTheDocument();
    expect(listedEventTypes()).toEqual(['payment.succeeded', 'refund.created']);
  });

  it('shows the signing secret exactly once, with the copy-now notice', async () => {
    const { fetchMock } = stubWebhooksApi();
    await renderPage();

    fireEvent.change(screen.getByLabelText(/Destination URL/i), {
      target: { value: 'https://example.com/hooks/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Register endpoint/i }));

    const region = await screen.findByRole('region', { name: /New webhook signing secret/i });
    expect(within(region).getByText('whsec_Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FyZ2x5')).toBeInTheDocument();
    expect(within(region).getByText(/Shown once — copy it now/i)).toBeInTheDocument();

    // It is never persisted: the page has no storage write, and dismissing it
    // removes it from the DOM for good.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    fireEvent.click(within(region).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /New webhook signing secret/i })).toBeNull(),
    );
    const createCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        init?.method === 'POST' && String(input).includes('/webhook-endpoints'),
    );
    expect(createCalls).toHaveLength(1);
  });

  it('adds a newly registered endpoint in the order the API returns them', async () => {
    stubWebhooksApi();
    await renderPage();

    const urls = () =>
      Array.from(document.querySelectorAll('.endpoint-url')).map((node) => node.textContent);
    expect(urls()).toEqual(['https://example.com/hooks/brinnpay', 'https://example.com/hooks/paused']);

    fireEvent.change(screen.getByLabelText(/Destination URL/i), {
      target: { value: 'https://example.com/hooks/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Register endpoint/i }));
    await screen.findByRole('region', { name: /New webhook signing secret/i });

    // Appended, not prepended: the API lists endpoints ascending by id, so a new
    // one belongs last. Prepending would move the row on the next reload.
    expect(urls()).toEqual([
      'https://example.com/hooks/brinnpay',
      'https://example.com/hooks/paused',
      'https://example.com/hooks/new',
    ]);
  });

  it('surfaces a rejected registration as an API error message', async () => {
    stubWebhooksApi({ createEndpoint: { ok: false } });
    await renderPage();

    // A well-formed URL the server still refuses: the browser cannot be the
    // one rejecting it, so the API's 422 is what surfaces.
    fireEvent.change(screen.getByLabelText(/Destination URL/i), {
      target: { value: 'ftp://example.com/hooks' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Register endpoint/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'url must be a valid absolute http(s) URL',
    );
    expect(screen.queryByRole('region', { name: /New webhook signing secret/i })).toBeNull();
  });

  it('toggles the enabled state and the subscription of an endpoint', async () => {
    const { fetchMock } = stubWebhooksApi();
    await renderPage();

    const row = (await screen.findByText('https://example.com/hooks/brinnpay')).closest('li');
    expect(row).not.toBeNull();

    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(String(patch?.[1]?.body)).toContain('"enabled":false');
    });

    const addRefund = within(row as HTMLElement).getByRole('button', { name: '+ refund.created' });
    fireEvent.click(addRefund);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
      expect(calls.some(([, init]) => String(init?.body).includes('refund.created'))).toBe(true);
    });
  });

  it('deletes an endpoint after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetchMock } = stubWebhooksApi();
    await renderPage();

    const row = (await screen.findByText('https://example.com/hooks/paused')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(String(del?.[0])).toContain('we-2');
    });
    await waitFor(() =>
      expect(screen.queryByText('https://example.com/hooks/paused')).toBeNull(),
    );
    expect(confirmSpy).toHaveBeenCalled();
  });

  it('shows deliveries with status, attempts, and the last error, and filters by status', async () => {
    const { fetchMock } = stubWebhooksApi();
    await renderPage();

    const row = (await screen.findByText('https://example.com/hooks/brinnpay')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Deliveries' }));

    expect(await screen.findByText(/1 attempt\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 200/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'delivered' } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/deliveries?status=delivered'));
      expect(call).toBeDefined();
    });
  });

  it('replays an event for owners and surfaces a 422 from the API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubWebhooksApi({ replay: { ok: false, code: 'BUSINESS_RULE_VIOLATION' } });
    await renderPage();

    const row = (await screen.findByText('https://example.com/hooks/brinnpay')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Deliveries' }));
    const eventRow = await waitFor(() => {
      const node = eventsRegion().querySelector('.event-type');
      if (!node?.closest('li')) throw new Error('event list not rendered yet');
      return node.closest('li') as HTMLElement;
    });
    fireEvent.click(within(eventRow).getByRole('button', { name: /Replay to selected endpoint/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot receive a replay/i);
  });

  it('hides the management controls and replay for a viewer', async () => {
    stubWebhooksApi({ role: 'viewer' });
    await renderPage();

    expect(await screen.findByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /Register webhook endpoint/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('shows the not-found state for a project the caller cannot reach', async () => {
    stubWebhooksApi({ failProjects: 'NOT_FOUND' });
    render(
      <AuthProvider>
        <WebhooksPage />
      </AuthProvider>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Project not found' })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Loading, empty, and paginated states (§10 web)
  // ---------------------------------------------------------------------------

  it('shows the loading state until the first page resolves', async () => {
    stubWebhooksApi({ delayMs: 120 });
    render(
      <AuthProvider>
        <WebhooksPage />
      </AuthProvider>,
    );

    // The heading alone is ambiguous: the loading branch renders it too.
    expect(await screen.findByText('Loading webhooks…')).toBeInTheDocument();
    expect(await screen.findByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    expect(screen.queryByText('Loading webhooks…')).toBeNull();
  });

  it('explains an empty endpoint and event list instead of rendering bare headings', async () => {
    stubWebhooksApi({ endpoints: [], events: [] });
    await renderPage();

    expect(screen.getByText('No webhook endpoints in TEST yet.')).toBeInTheDocument();
    expect(screen.getByText('No events in TEST yet.')).toBeInTheDocument();
    expect(screen.queryByText('https://example.com/hooks/brinnpay')).toBeNull();
  });

  it('explains an empty delivery history for a selected endpoint', async () => {
    stubWebhooksApi({ deliveries: [] });
    await renderPage();

    const row = (await screen.findByText('https://example.com/hooks/brinnpay')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Deliveries' }));

    expect(await screen.findByText('No deliveries for this endpoint yet.')).toBeInTheDocument();
  });

  it('appends the next cursor page for endpoints, events, and deliveries', async () => {
    const secondEndpoint: WebhookEndpoint = {
      ...endpointFixtures[0],
      id: 'we-3',
      url: 'https://example.com/hooks/page-two',
    };
    const secondEvent: WebhookEvent = {
      ...eventFixtures[0],
      id: 'ev-3',
      type: 'payment.created',
      data: { id: 'pay-2' },
    };
    const secondDelivery: WebhookDelivery = {
      ...deliveryFixtures[0],
      id: 'dl-3',
      event_id: 'ev-3',
      created_at: '2026-09-24T05:00:01.000Z',
    };

    const { fetchMock } = stubWebhooksApi({
      endpointPages: [
        { data: [endpointFixtures[0]], next_cursor: 'we-1', has_more: true },
        { data: [secondEndpoint], next_cursor: null, has_more: false },
      ],
      eventPages: [
        { data: [eventFixtures[0]], next_cursor: 'ev-1', has_more: true },
        { data: [secondEvent], next_cursor: null, has_more: false },
      ],
      deliveryPages: [
        { data: [deliveryFixtures[0]], next_cursor: 'dl-1', has_more: true },
        { data: [secondDelivery], next_cursor: null, has_more: false },
      ],
    });
    await renderPage();

    // Only page one is listed, and the control advertises that more exists.
    expect(screen.getByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    expect(screen.queryByText('https://example.com/hooks/page-two')).toBeNull();
    expect(listedEventTypes()).toEqual(['payment.succeeded']);

    fireEvent.click(screen.getByRole('button', { name: /Load more endpoints/i }));
    // Appending, not replacing: page one survives next to page two.
    expect(await screen.findByText('https://example.com/hooks/page-two')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/hooks/brinnpay')).toBeInTheDocument();
    // The last page sets has_more false, so the control is gone for good.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load more endpoints/i })).toBeNull(),
    );
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('cursor=we-1')),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Load more events/i }));
    await waitFor(() => expect(listedEventTypes()).toEqual(['payment.succeeded', 'payment.created']));

    const row = (await screen.findByText('https://example.com/hooks/brinnpay')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Deliveries' }));
    expect(await screen.findByText(/1 attempt\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load more deliveries/i }));
    await waitFor(() => expect(screen.getAllByText(/1 attempt\(s\)/)).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load more deliveries/i })).toBeNull(),
    );
  });

  it('hides the load-more controls when the API reports no further pages', async () => {
    stubWebhooksApi();
    await renderPage();

    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
  });
});
