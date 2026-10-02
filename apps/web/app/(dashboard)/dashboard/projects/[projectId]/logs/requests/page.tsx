'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../../components/auth/auth-provider';
import {
  ApiClientError,
  listRequestLogs,
  retrieveProject,
  type CursorPage,
  type Environment,
  type Project,
  type RequestLog,
} from '../../../../../../../lib/brinnpay/client';

/** Options of the D1 environment control: an explicit "All" (the parameter
 *  absent, which returns environment-less records too) beside the two
 *  environments. */
const ENVIRONMENT_OPTIONS: Environment[] = ['test', 'live'];

/** Resolution of the addressed project, keyed by project id so a route change
 *  never re-uses the previous project's outcome (phase 11 §7). */
interface ProjectViewState {
  projectId: string;
  status: 'loading' | 'ready' | 'notFound' | 'error';
  project: Project | null;
  message: string | null;
}

/**
 * Request-log viewer (phase 11 §7).
 *
 * The read-only surface for `logs.listRequestLogs`: cursor-paginated records
 * of the addressed project with the environment control (D1) and the exact
 * request-ID lookup (D8) for correlating an `X-Request-Id` reported from an
 * error envelope (`docs/api-conventions.md` §7).
 *
 * Three boundaries are deliberate:
 *
 * - **The API is the authority.** Nothing is fetched without a session token,
 *   a non-member gets the not-found state (404) instead of data, and there is
 *   no write path at all — no operation creates, edits or deletes a log.
 * - **Metadata only.** The contract stores an allowlist projection (§8): no
 *   bodies, headers or query strings, so the page cannot display secrets even
 *   if it wanted to. The request ID is the only copyable value.
 * - **No full-log accumulation.** The list holds only the pages the operator
 *   explicitly asked for; the cursor is never walked to exhaust the log, and
 *   retention (D5) bounds what the API can return anyway.
 *
 * The operation is project-wide, not environment-scoped data like customers or
 * payments (the environment parameter is an optional equality filter, D1), so
 * the list starts at "All environments" regardless of the shell selector — the
 * same project-wide precedent as the API-keys page (phase 5 D5).
 */
export default function ProjectLogsRequestsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { accessToken } = useAuth();

  const [projectView, setProjectView] = useState<ProjectViewState | null>(null);

  const [records, setRecords] = useState<RequestLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  /** The project the rows currently in state belong to. A client-side route
   *  change re-uses this component, so without this guard another project's
   *  rows could be shown for a frame — stale state is never displayed (§7). */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const listGeneration = useRef(0);

  const [environmentFilter, setEnvironmentFilter] = useState<Environment | ''>('');
  const [requestIdInput, setRequestIdInput] = useState('');
  const [requestIdFilter, setRequestIdFilter] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Project resolution is keyed by project: a route change to another
  // project's page falls back to "resolving" on the first frame instead of
  // re-showing the previous project's outcome (§7: no stale state).
  const view = projectView !== null && projectView.projectId === projectId ? projectView : null;
  const project = view?.project ?? null;
  const notFound = view?.status === 'notFound';
  const projectError = view?.status === 'error' ? view.message : null;
  const resolvingProject = view === null || view.status === 'loading';
  const projectReady = view?.status === 'ready';

  /** The server-side filter set (phase 11 D1/D8); absent keys are omitted so
   *  the API applies its own default (every record of the project). */
  const query = useMemo(
    () => ({
      ...(environmentFilter !== '' ? { environment: environmentFilter } : {}),
      ...(requestIdFilter !== '' ? { request_id: requestIdFilter } : {}),
    }),
    [environmentFilter, requestIdFilter],
  );

  // Project access first: a direct URL to another organization's project must
  // reach the not-found state before any log is requested.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setProjectView({ projectId, status: 'loading', project: null, message: null });
    listGeneration.current += 1;
    void (async () => {
      try {
        const loaded = await retrieveProject(accessToken, projectId);
        if (!cancelled) setProjectView({ projectId, status: 'ready', project: loaded, message: null });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404)
          setProjectView({ projectId, status: 'notFound', project: null, message: null });
        else
          setProjectView({
            projectId,
            status: 'error',
            project: null,
            message: err instanceof Error ? err.message : 'Unable to load request logs',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId]);

  // Page one of the filtered list (phase 11 §7): changing either filter
  // restarts the cursor, so stale pages are never shown under a new filter.
  useEffect(() => {
    if (!accessToken || !projectReady) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setCopiedId(null);
    listGeneration.current += 1;
    void (async () => {
      try {
        const page: CursorPage<RequestLog> = await listRequestLogs(accessToken, projectId, query);
        if (cancelled) return;
        setRecords(page.data);
        setNextCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404)
          setProjectView({ projectId, status: 'notFound', project: null, message: null });
        else setListError(err instanceof Error ? err.message : 'Unable to load request logs');
      } finally {
        if (!cancelled) {
          setListLoading(false);
          // Both outcomes resolve the view for this project: an error must
          // reach the alert instead of being hidden behind the loading state.
          setLoadedFor(projectId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId, query, projectReady]);

  async function onLoadMore(): Promise<void> {
    if (!accessToken || !nextCursor || listLoading) return;
    setListLoading(true);
    setListError(null);
    const generation = listGeneration.current;
    try {
      const page = await listRequestLogs(accessToken, projectId, { ...query, cursor: nextCursor });
      if (listGeneration.current !== generation) return;
      setRecords((current) => [...current, ...page.data]);
      setNextCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch (err) {
      if (listGeneration.current !== generation) return;
      setListError(err instanceof Error ? err.message : 'Unable to load request logs');
    } finally {
      if (listGeneration.current === generation) setListLoading(false);
    }
  }

  function onFindRequestId(event: FormEvent): void {
    event.preventDefault();
    setRequestIdFilter(requestIdInput.trim());
  }

  function onClearRequestId(): void {
    setRequestIdInput('');
    setRequestIdFilter('');
  }

  async function onCopyRequestId(requestId: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setListError('Copying the request ID is not available in this browser');
      return;
    }
    try {
      await navigator.clipboard.writeText(requestId);
      setCopiedId(requestId);
      setListError(null);
    } catch {
      setListError('Unable to copy the request ID');
    }
  }

  // A project-level failure is an error, not an absence: never claim
  // "not found" for something that simply could not be loaded.
  if (projectError) {
    return (
      <section>
        <h1>Request logs</h1>
        <p role="alert">{projectError}</p>
        <p>
          <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
        </p>
      </section>
    );
  }

  if (notFound) {
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

  // Loading covers the project resolution and the first page of *this*
  // project's list: rows held from another project (a client-side route
  // change re-uses the component) are never displayed (§7).
  if (resolvingProject || !project || loadedFor !== projectId) {
    return (
      <section>
        <h1>Request logs</h1>
        <p>Loading request logs…</p>
      </section>
    );
  }

  return (
    <section>
      <p>
        <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
      </p>
      <h1>Request logs</h1>
      <p className="owning-org">{project.name}</p>

      {listError ? <p role="alert">{listError}</p> : null}

      <form aria-label="Filter request logs" onSubmit={onFindRequestId}>
        <label>
          Environment
          <select
            value={environmentFilter}
            onChange={(event) => setEnvironmentFilter(event.target.value as Environment | '')}
          >
            <option value="">All environments</option>
            {ENVIRONMENT_OPTIONS.map((environment) => (
              <option key={environment} value={environment}>
                {environment.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          Request ID
          <input
            name="request_id"
            placeholder="req_00000000000000000000000000000000"
            value={requestIdInput}
            onChange={(event) => setRequestIdInput(event.target.value)}
          />
        </label>
        <button type="submit" disabled={listLoading}>
          Find
        </button>
        {requestIdFilter ? (
          <button type="button" className="dismiss" onClick={onClearRequestId}>
            Clear
          </button>
        ) : null}
      </form>

      <p>
        {environmentFilter ? `Environment: ${environmentFilter.toUpperCase()}` : 'Environment: all'}
        {requestIdFilter ? ` — request ID: ${requestIdFilter}` : ''}
        {records.length > 0 ? ` — ${records.length} shown` : ''}
      </p>

      {listLoading && records.length === 0 ? <p>Loading request logs…</p> : null}

      {!listLoading && !listError && records.length === 0 ? (
        <p>
          {requestIdFilter
            ? `No request found for ${requestIdFilter}.`
            : environmentFilter
              ? `No request logs in ${environmentFilter.toUpperCase()} yet.`
              : 'No request logs yet.'}
        </p>
      ) : null}

      {records.length > 0 ? (
        <table aria-label="Request logs">
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Method</th>
              <th scope="col">Path</th>
              <th scope="col">Status</th>
              <th scope="col">Duration</th>
              <th scope="col">Environment</th>
              <th scope="col">Actor</th>
              <th scope="col">Request ID</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{record.created_at}</td>
                <td>{record.method}</td>
                <td>
                  <code>{record.path}</code>
                </td>
                <td>{record.status_code}</td>
                <td>{record.duration_ms === undefined ? '—' : `${record.duration_ms} ms`}</td>
                <td>{record.environment === null ? '—' : record.environment.toUpperCase()}</td>
                <td>{record.api_key_id ? 'API key' : record.user_id ? 'User' : '—'}</td>
                <td>
                  <code>{record.request_id}</code>{' '}
                  <button type="button" onClick={() => void onCopyRequestId(record.request_id)}>
                    {copiedId === record.request_id ? 'Copied' : 'Copy'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {hasMore ? (
        <button type="button" disabled={listLoading} onClick={() => void onLoadMore()}>
          Load more
        </button>
      ) : null}
    </section>
  );
}
