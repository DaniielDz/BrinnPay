'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../../../../../../components/auth/auth-provider';
import {
  ApiClientError,
  listAuditLogs,
  retrieveProject,
  type AuditLogEntry,
  type CursorPage,
  type Project,
} from '../../../../../../../lib/brinnpay/client';

/** Resolution of the addressed project, keyed by project id so a route change
 *  never re-uses the previous project's outcome (phase 11 §7 pattern). */
interface ProjectViewState {
  projectId: string;
  status: 'loading' | 'ready' | 'notFound' | 'error';
  project: Project | null;
  message: string | null;
}

/**
 * Audit-log viewer (phase 12 §8).
 *
 * The read-only surface for `logs.listAuditLogs`: cursor-paginated, immutable
 * entries of the organization the addressed project belongs to. Three
 * boundaries are deliberate:
 *
 * - **Project → organization scope (D12).** The contract's operation is
 *   organization-scoped while the route stays project-scoped, so the viewer
 *   resolves the project first and then lists its organization's entries. The
 *   view is labeled **organization-wide** — entries of sibling projects and of
 *   both environments appearing under a project route is expected behavior,
 *   not a leak.
 * - **The API is the authority.** Nothing is fetched without a session token;
 *   a foreign or unknown project resolves to the not-found state before any
 *   entry is requested (direct-URL isolation), and there is no write path at
 *   all — no operation creates, edits or deletes an entry, because the trail
 *   is append-only.
 * - **No accumulation.** Only the pages the operator explicitly asked for are
 *   held; the cursor is never walked to exhaust the trail, and there are no
 *   filters (D11) — ordering follows the ascending cursor contract (D10).
 *
 * `data` is rendered as the key/value pairs the per-action allowlist produced,
 * including a copyable `request_id` for cross-reference into the request-log
 * viewer (`docs/api-conventions.md` §7 issue-reporting flow).
 */
export default function ProjectLogsAuditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { accessToken } = useAuth();

  const [projectView, setProjectView] = useState<ProjectViewState | null>(null);

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  /** The project the entries currently in state belong to. A client-side
   *  route change re-uses this component, so without this guard another
   *  project's entries could be shown for a frame — stale state is never
   *  displayed (phase 11 §7). */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listGeneration = useRef(0);

  // Project resolution is keyed by project: a route change to another
  // project's page falls back to "resolving" on the first frame instead of
  // re-showing the previous project's outcome.
  const view = projectView !== null && projectView.projectId === projectId ? projectView : null;
  const project = view?.project ?? null;
  const notFound = view?.status === 'notFound';
  const projectError = view?.status === 'error' ? view.message : null;
  const resolvingProject = view === null || view.status === 'loading';
  const projectReady = view?.status === 'ready';

  // Project access first: a direct URL to another organization's project must
  // reach the not-found state before any audit entry is requested.
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
            message: err instanceof Error ? err.message : 'Unable to load audit logs',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId]);

  // First page of this project's organization's entries.
  useEffect(() => {
    if (!accessToken || !projectReady || !project) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setCopiedId(null);
    listGeneration.current += 1;
    void (async () => {
      try {
        const page: CursorPage<AuditLogEntry> = await listAuditLogs(
          accessToken,
          project.organization_id,
        );
        if (cancelled) return;
        setEntries(page.data);
        setNextCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404)
          setProjectView({ projectId, status: 'notFound', project: null, message: null });
        else setListError(err instanceof Error ? err.message : 'Unable to load audit logs');
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
  }, [accessToken, projectId, project, projectReady]);

  async function onLoadMore(): Promise<void> {
    if (!accessToken || !project || !nextCursor || listLoading) return;
    setListLoading(true);
    setListError(null);
    const generation = listGeneration.current;
    try {
      const page = await listAuditLogs(accessToken, project.organization_id, {
        cursor: nextCursor,
      });
      if (listGeneration.current !== generation) return;
      setEntries((current) => [...current, ...page.data]);
      setNextCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch (err) {
      if (listGeneration.current !== generation) return;
      setListError(err instanceof Error ? err.message : 'Unable to load audit logs');
    } finally {
      if (listGeneration.current === generation) setListLoading(false);
    }
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
        <h1>Audit logs</h1>
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
  // project's organization: entries held from another project (a client-side
  // route change re-uses the component) are never displayed.
  if (resolvingProject || !project || loadedFor !== projectId) {
    return (
      <section>
        <h1>Audit logs</h1>
        <p>Loading audit logs…</p>
      </section>
    );
  }

  return (
    <section>
      <p>
        <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
      </p>
      <h1>Audit logs</h1>
      <p className="owning-org">{project.name}</p>
      {/* D12: the operation is organization-scoped — sibling projects and both
          environments are expected under this route. */}
      <p>
        Organization-wide: every project and both environments (TEST and LIVE) of this
        organization&apos;s audit trail.
      </p>

      {listError ? <p role="alert">{listError}</p> : null}

      <p>{entries.length > 0 ? `${entries.length} shown` : ''}</p>

      {listLoading && entries.length === 0 ? <p>Loading audit logs…</p> : null}

      {!listLoading && !listError && entries.length === 0 ? (
        <p>No audit entries yet.</p>
      ) : null}

      {entries.length > 0 ? (
        <table aria-label="Audit logs">
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Resource</th>
              <th scope="col">Project</th>
              <th scope="col">Environment</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.created_at}</td>
                <td>
                  <code>{entry.action}</code>
                </td>
                <td>
                  {entry.actor_type}
                  {entry.actor_id ? (
                    <>
                      {' '}
                      <code>{entry.actor_id}</code>
                    </>
                  ) : (
                    ' —'
                  )}
                </td>
                <td>
                  {entry.resource_type}
                  {entry.resource_id ? (
                    <>
                      {' '}
                      <code>{entry.resource_id}</code>
                    </>
                  ) : (
                    ' —'
                  )}
                </td>
                <td>{entry.project_id ? <code>{entry.project_id}</code> : '—'}</td>
                <td>{entry.environment ? entry.environment.toUpperCase() : '—'}</td>
                <td>
                  {entry.data && Object.keys(entry.data).length > 0 ? (
                    <ul>
                      {Object.entries(entry.data).map(([key, value]) => (
                        <li key={key}>
                          {key}: {value === null ? 'null' : String(value)}
                          {key === 'request_id' && typeof value === 'string' ? (
                            <>
                              {' '}
                              <button
                                type="button"
                                onClick={() => void onCopyRequestId(value)}
                              >
                                {copiedId === value ? 'Copied' : 'Copy'}
                              </button>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  )}
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
