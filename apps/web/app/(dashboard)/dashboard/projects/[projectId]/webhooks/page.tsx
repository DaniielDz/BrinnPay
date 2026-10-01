'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../components/auth/auth-provider';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  isEnvironment,
  listMembers,
  listWebhookDeliveries,
  listWebhookEndpoints,
  listWebhookEvents,
  replayWebhookEvent,
  retrieveProject,
  updateWebhookEndpoint,
  WEBHOOK_EVENT_TYPES,
  type Environment,
  type Project,
  type Role,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookDeliveryStatus,
} from '../../../../../../lib/brinnpay/client';

const DELIVERY_STATUSES: WebhookDeliveryStatus[] = ['pending', 'delivered', 'failed'];

/**
 * Webhook management and observability (phase 10 §7).
 *
 * Three areas over the documented API only (ADR-0012): the endpoint registry of
 * the shell-selected environment, the environment's event log with its stored
 * envelopes, and per-endpoint deliveries with a replay action.
 *
 * Two rules shape the code:
 *
 * - **The signing secret is shown exactly once** (D8). It lives in component
 *   state from the create response until it is dismissed, is never re-fetched
 *   (no API can return it), and is never written to storage. A reload loses it.
 * - **Owner/admin only** get the mutation controls; the API remains the
 *   enforcement point, and a non-member sees the not-found state (§4.2/D2).
 */
export default function ProjectWebhooksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();

  const environment: Environment = useMemo(() => {
    const selected = searchParams.get('environment');
    return selected !== null && isEnvironment(selected) ? selected : 'test';
  }, [searchParams]);

  const [project, setProject] = useState<Project | null>(null);
  const [callerRole, setCallerRole] = useState<Role>('viewer');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Endpoints
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [endpointsCursor, setEndpointsCursor] = useState<string | null>(null);
  const [endpointsMore, setEndpointsMore] = useState(false);
  const [revealed, setRevealed] = useState<WebhookEndpointCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [subscribed, setSubscribed] = useState<WebhookEventType[]>([...WEBHOOK_EVENT_TYPES]);

  // Events
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [eventsMore, setEventsMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState<WebhookEventType | ''>('');
  const [envelope, setEnvelope] = useState<WebhookEvent | null>(null);

  // Deliveries of the selected endpoint
  const [selected, setSelected] = useState<WebhookEndpoint | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesCursor, setDeliveriesCursor] = useState<string | null>(null);
  const [deliveriesMore, setDeliveriesMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<WebhookDeliveryStatus | ''>('');

  const loadEndpoints = useCallback(async (cursor?: string) => {
    if (!accessToken) return;
    try {
      const page = await listWebhookEndpoints(accessToken, projectId, { environment, cursor });
      setEndpoints((current) => (cursor ? [...current, ...page.data] : page.data));
      setEndpointsCursor(page.next_cursor);
      setEndpointsMore(page.has_more);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load webhook endpoints');
    }
  }, [accessToken, projectId, environment]);

  const loadEvents = useCallback(async (cursor?: string) => {
    if (!accessToken) return;
    try {
      const page = await listWebhookEvents(accessToken, projectId, {
        environment,
        ...(typeFilter ? { type: typeFilter } : {}),
        cursor,
      });
      setEvents((current) => (cursor ? [...current, ...page.data] : page.data));
      setEventsCursor(page.next_cursor);
      setEventsMore(page.has_more);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load webhook events');
    }
  }, [accessToken, projectId, environment, typeFilter]);

  const loadDeliveries = useCallback(
    async (endpointId: string, status: WebhookDeliveryStatus | '', cursor?: string) => {
      if (!accessToken) return;
      try {
        const page = await listWebhookDeliveries(accessToken, projectId, endpointId, {
          ...(status ? { status } : {}),
          cursor,
        });
        setDeliveries((current) => (cursor ? [...current, ...page.data] : page.data));
        setDeliveriesCursor(page.next_cursor);
        setDeliveriesMore(page.has_more);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Unable to load deliveries');
      }
    },
    [accessToken, projectId],
  );

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    // A reload (or an environment change) must never re-show secret material.
    setRevealed(null);
    setSelected(null);
    setDeliveries([]);
    setEnvelope(null);
    void (async () => {
      try {
        const loaded = await retrieveProject(accessToken, projectId);
        const [members, endpointPage, eventPage] = await Promise.all([
          listMembers(accessToken, loaded.organization_id).catch(() => null),
          listWebhookEndpoints(accessToken, projectId, { environment }),
          listWebhookEvents(accessToken, projectId, { environment }),
        ]);
        if (cancelled) return;
        setProject(loaded);
        setCallerRole(members?.data.find((member) => member.user_id === user?.id)?.role ?? 'viewer');
        setEndpoints(endpointPage.data);
        setEndpointsCursor(endpointPage.next_cursor);
        setEndpointsMore(endpointPage.has_more);
        setEvents(eventPage.data);
        setEventsCursor(eventPage.next_cursor);
        setEventsMore(eventPage.has_more);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && /not found/i.test(err.message)) setNotFound(true);
        else setError(err instanceof Error ? err.message : 'Unable to load webhooks');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId, environment, user?.id]);

  // The D15 event-type filter is server-side, so changing it reloads page one.
  useEffect(() => {
    if (!accessToken || loading) return;
    void loadEvents();
  }, [loadEvents, accessToken, loading]);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setCreating(true);
    setActionError(null);
    setCopied(false);
    try {
      const created = await createWebhookEndpoint(accessToken, projectId, {
        environment,
        url: url.trim(),
        event_types: subscribed,
      });
      setRevealed(created);
      // Appended, not prepended: the API orders endpoints ascending by UUIDv7, so
      // the newest belongs last. Prepending would show the new row in a different
      // position than it occupies on the next load.
      setEndpoints((current) => [...current, created]);
      setUrl('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create webhook endpoint');
    } finally {
      setCreating(false);
    }
  }

  async function onToggle(endpoint: WebhookEndpoint): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    try {
      const updated = await updateWebhookEndpoint(accessToken, projectId, endpoint.id, {
        enabled: !endpoint.enabled,
      });
      setEndpoints((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelected((current) => (current && current.id === updated.id ? updated : current));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update webhook endpoint');
    }
  }

  async function onResubscribe(endpoint: WebhookEndpoint, type: WebhookEventType): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    const next = endpoint.event_types.includes(type)
      ? endpoint.event_types.filter((item) => item !== type)
      : [...endpoint.event_types, type];
    // An empty subscription is rejected by the API; the control is disabled there.
    if (next.length === 0) return;
    try {
      const updated = await updateWebhookEndpoint(accessToken, projectId, endpoint.id, {
        event_types: next,
      });
      setEndpoints((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelected((current) => (current && current.id === updated.id ? updated : current));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update the subscription');
    }
  }

  async function onDelete(endpoint: WebhookEndpoint): Promise<void> {
    if (!accessToken) return;
    if (!window.confirm(`Delete ${endpoint.url}? Its delivery history is removed with it.`)) return;
    setActionError(null);
    try {
      await deleteWebhookEndpoint(accessToken, projectId, endpoint.id);
      setEndpoints((current) => current.filter((item) => item.id !== endpoint.id));
      if (selected?.id === endpoint.id) {
        setSelected(null);
        setDeliveries([]);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to delete webhook endpoint');
    }
  }

  async function onSelect(endpoint: WebhookEndpoint): Promise<void> {
    setSelected(endpoint);
    setActionError(null);
    await loadDeliveries(endpoint.id, statusFilter);
  }

  async function onStatusFilter(next: WebhookDeliveryStatus | ''): Promise<void> {
    setStatusFilter(next);
    if (selected) await loadDeliveries(selected.id, next);
  }

  /** Replay is repeatable by design (D12): a 202 creates another delivery. */
  async function onReplay(eventId: string): Promise<void> {
    if (!accessToken || !selected) return;
    setActionError(null);
    if (
      !window.confirm(
        `Replay event ${eventId} to ${selected.url}? This creates a new delivery; a destination that already processed it will see it again.`,
      )
    ) {
      return;
    }
    try {
      await replayWebhookEvent(accessToken, projectId, selected.id, eventId);
      await loadDeliveries(selected.id, statusFilter);
    } catch (err) {
      // 404 (foreign/expired event) and 422 (disabled or unsubscribed endpoint)
      // are surfaced verbatim; both are normal outcomes, not bugs.
      setActionError(err instanceof Error ? err.message : 'Unable to replay the event');
    }
  }

  async function onCopySecret(): Promise<void> {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.signing_secret);
      setCopied(true);
    } catch {
      // Clipboard unavailable (non-secure context); the secret stays visible.
    }
  }

  if (!accessToken) return null;

  if (loading) {
    return (
      <section>
        <h1>Webhooks</h1>
        <p>Loading webhooks…</p>
      </section>
    );
  }

  if (notFound || !project) {
    return (
      <section>
        <h1>Project not found</h1>
        <p>The project does not exist or you are not a member of its organization.</p>
        <p>
          <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
        </p>
      </section>
    );
  }

  const canManage = callerRole === 'owner' || callerRole === 'admin';
  const replayable = canManage && selected?.enabled === true;

  return (
    <section>
      <p>
        <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
      </p>
      <h1>
        Webhooks <span className={`env-badge env-${environment}`}>{environment.toUpperCase()}</span>
      </h1>
      <p className="owning-org">{project.name}</p>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {revealed ? (
        <div className="revealed-key" role="region" aria-label="New webhook signing secret">
          <div className="revealed-env">{revealed.environment.toUpperCase()}</div>
          <code>{revealed.signing_secret}</code>
          <p className="warning">
            Shown once — copy it now. The signing secret cannot be retrieved later; recovery is
            deleting and recreating the endpoint.
          </p>
          <button type="button" onClick={() => void onCopySecret()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="dismiss" onClick={() => setRevealed(null)}>
            Done
          </button>
        </div>
      ) : null}

      {canManage ? (
        <form onSubmit={onCreate} aria-label="Register webhook endpoint">
          <h2>Register endpoint</h2>
          <label>
            Destination URL
            <input
              required
              type="url"
              maxLength={2048}
              placeholder="https://example.com/hooks/brinnpay"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Subscribed events</legend>
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={subscribed.includes(type)}
                  onChange={(event) =>
                    setSubscribed((current) =>
                      event.target.checked
                        ? [...current, type]
                        : current.filter((item) => item !== type),
                    )
                  }
                />{' '}
                {type}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={creating || subscribed.length === 0}>
            {creating ? 'Registering…' : 'Register endpoint'}
          </button>
        </form>
      ) : null}

      <h2>Endpoints</h2>
      {endpoints.length === 0 ? (
        <p>No webhook endpoints in {environment.toUpperCase()} yet.</p>
      ) : (
        <ul>
          {endpoints.map((endpoint) => (
            <li key={endpoint.id}>
              <span className="key-id">{endpoint.id}</span> —{' '}
              <span className="endpoint-url">{endpoint.url}</span>{' '}
              <span>{endpoint.enabled ? 'enabled' : 'disabled'}</span>{' '}
              <span>[{endpoint.event_types.join(', ')}]</span>
              <button type="button" onClick={() => void onSelect(endpoint)}>
                Deliveries
              </button>
              {canManage ? (
                <button type="button" onClick={() => void onToggle(endpoint)}>
                  {endpoint.enabled ? 'Disable' : 'Enable'}
                </button>
              ) : null}
              {canManage
                ? WEBHOOK_EVENT_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={endpoint.event_types.includes(type)}
                      onClick={() => void onResubscribe(endpoint, type)}
                    >
                      {endpoint.event_types.includes(type) ? `− ${type}` : `+ ${type}`}
                    </button>
                  ))
                : null}
              {canManage ? (
                <button type="button" className="danger" onClick={() => void onDelete(endpoint)}>
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {endpointsMore ? (
        <button type="button" onClick={() => void loadEndpoints(endpointsCursor ?? undefined)}>
          Load more endpoints
        </button>
      ) : null}

      {selected ? (
        <section aria-label={`Deliveries for ${selected.id}`}>
          <h2>Deliveries</h2>
          <p>
            <span className="endpoint-url">{selected.url}</span> —{' '}
            {selected.enabled ? 'enabled' : 'disabled'}. Delivery is at-least-once and unordered:
            a destination must deduplicate by event id.
          </p>
          <label>
            Status
            <select
              value={statusFilter}
              onChange={(event) => void onStatusFilter(event.target.value as WebhookDeliveryStatus | '')}
            >
              <option value="">All</option>
              {DELIVERY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          {deliveries.length === 0 ? (
            <p>No deliveries for this endpoint yet.</p>
          ) : (
            <ul>
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <span className="key-id">{delivery.event_id}</span> — {delivery.status},{' '}
                  {delivery.attempts} attempt(s)
                  {delivery.response_status ? `, HTTP ${delivery.response_status}` : ''}
                  {delivery.is_replay ? ' — replay' : ''}
                  {delivery.next_attempt_at ? ` — retry at ${delivery.next_attempt_at}` : ''}
                  {delivery.last_error ? ` — ${delivery.last_error}` : ''}
                  {replayable ? (
                    <button type="button" onClick={() => void onReplay(delivery.event_id)}>
                      Replay
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {deliveriesMore ? (
            <button
              type="button"
              onClick={() => void loadDeliveries(selected.id, statusFilter, deliveriesCursor ?? undefined)}
            >
              Load more deliveries
            </button>
          ) : null}
          {replayable ? null : (
            <p>
              Replay needs an enabled endpoint and owner or admin role{selected.enabled ? '' : '; this endpoint is disabled'}.
            </p>
          )}
        </section>
      ) : null}

      <section aria-label="Webhook events">
      <h2>Events</h2>
      <label>
        Type
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value as WebhookEventType | '')}
        >
          <option value="">All</option>
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      {events.length === 0 ? (
        <p>No events in {environment.toUpperCase()} yet.</p>
      ) : (
        <ul>
          {events.map((event) => (
            <li key={event.id}>
              <span className="key-id">{event.id}</span> —{' '}
              <span className="event-type">{event.type}</span> — {event.created_at}{' '}
              <button type="button" onClick={() => setEnvelope(event)}>
                Envelope
              </button>
              {replayable ? (
                <button type="button" onClick={() => void onReplay(event.id)}>
                  Replay to selected endpoint
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {eventsMore ? (
        <button type="button" onClick={() => void loadEvents(eventsCursor ?? undefined)}>
          Load more events
        </button>
      ) : null}
      </section>

      {envelope ? (
        <section aria-label="Event envelope">
          <h2>Envelope</h2>
          <dl>
            <dt>ID</dt>
            <dd>{envelope.id}</dd>
            <dt>Type</dt>
            <dd>{envelope.type}</dd>
            <dt>Environment</dt>
            <dd>{envelope.environment}</dd>
            <dt>Created</dt>
            <dd>{envelope.created_at}</dd>
          </dl>
          <pre>{JSON.stringify(envelope.data, null, 2)}</pre>
          <button type="button" onClick={() => setEnvelope(null)}>
            Close
          </button>
        </section>
      ) : null}
    </section>
  );
}
