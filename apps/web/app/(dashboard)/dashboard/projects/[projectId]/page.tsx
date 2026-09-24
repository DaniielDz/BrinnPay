'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../components/auth/auth-provider';
import {
  deleteProject,
  isEnvironment,
  listMembers,
  retrieveProject,
  updateProject,
  type Environment,
  type Project,
  type Role,
} from '../../../../../lib/brinnpay/client';

/** Project-scoped child pages (phase 5 §5.3): the shell hands the selected
 *  environment to them via the `environment` query parameter. */
const PROJECT_CHILD_LINKS: { href: (projectId: string) => string; label: string }[] = [
  { href: (projectId: string) => `/dashboard/projects/${projectId}/customers`, label: 'Customers' },
  { href: (projectId: string) => `/dashboard/projects/${projectId}/payments`, label: 'Payments' },
  {
    href: (projectId: string) => `/dashboard/projects/${projectId}/api-keys`,
    label: 'API keys',
  },
  {
    href: (projectId: string) => `/dashboard/projects/${projectId}/webhooks`,
    label: 'Webhooks',
  },
  {
    href: (projectId: string) => `/dashboard/projects/${projectId}/refunds`,
    label: 'Refunds',
  },
  {
    href: (projectId: string) => `/dashboard/projects/${projectId}/logs/requests`,
    label: 'Request logs',
  },
  {
    href: (projectId: string) => `/dashboard/projects/${projectId}/logs/audit`,
    label: 'Audit logs',
  },
];

const ENVIRONMENT_OPTIONS: Environment[] = ['test', 'live'];

/**
 * Project shell (phase 5 §5.1/§5.3): project name, owner/admin rename/delete
 * controls, and the TEST/LIVE environment selector. The selector is the
 * presentation of the phase 1 §5.2 environment model: it persists as UI state
 * (the `environment` query parameter applied to every child link) and the
 * API-key page lists both environments regardless of the selection because the
 * contract list is project-wide (D5). A non-member receives the not-found
 * state exactly like the API's 404 (project access semantics, §4.2/D2).
 */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [callerRole, setCallerRole] = useState<Role>('viewer');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const environment: Environment = useMemo(() => {
    const selected = searchParams.get('environment');
    return selected !== null && isEnvironment(selected) ? selected : 'test';
  }, [searchParams]);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setError(null);
    try {
      const loaded = await retrieveProject(accessToken, projectId);
      setProject(loaded);
      setRenameValue(loaded.name);
      setNotFound(false);

      // The contract carries no role; derive the caller's membership from the
      // owning organization's roster (same pattern as the Phase 4 detail page).
      let role: Role = 'viewer';
      try {
        const members = await listMembers(accessToken, loaded.organization_id);
        const self = members.data.find((member) => member.user_id === user?.id);
        if (self) role = self.role;
      } catch {
        // Read-only presentation fallback; the API remains the enforcement.
      }
      setCallerRole(role);
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        setNotFound(true);
      } else {
        setError(err instanceof Error ? err.message : 'Unable to load project');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, projectId, user?.id]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  if (!accessToken) return null;

  if (loading) {
    return (
      <section>
        <h1>Project</h1>
        <p>Loading project…</p>
      </section>
    );
  }

  if (notFound || !project) {
    return (
      <section>
        <h1>Project not found</h1>
        <p>The project does not exist or you are not a member of its organization.</p>
        <p>
          <Link href="/dashboard/projects">Back to projects</Link>
        </p>
      </section>
    );
  }

  const canManage = callerRole === 'owner' || callerRole === 'admin';

  async function onRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken || !renameValue.trim()) return;
    setActionError(null);
    setRenaming(true);
    try {
      const updated = await updateProject(accessToken, projectId, renameValue.trim());
      setProject(updated);
      setRenameValue(updated.name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to rename project');
    } finally {
      setRenaming(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!accessToken) return;
    if (
      !window.confirm(
        `Delete "${project?.name ?? 'this project'}"? This removes the project and all of its API keys.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setDeleting(true);
    try {
      await deleteProject(accessToken, projectId);
      router.replace('/dashboard/projects');
    } catch (err) {
      setDeleting(false);
      setActionError(err instanceof Error ? err.message : 'Unable to delete project');
    }
  }

  function childHref(href: string): string {
    return `${href}?environment=${environment}`;
  }

  return (
    <section>
      <p>
        <Link href="/dashboard/projects">Back to projects</Link>
      </p>
      <h1>{project.name}</h1>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <div className="environment-selector" role="group" aria-label="Environment selector">
        {ENVIRONMENT_OPTIONS.map((option) => (
          <span key={option} className={`${option === environment ? 'env-selected' : ''}`}>
            {option.toUpperCase()}
          </span>
        ))}
      </div>

      {canManage ? (
        <form onSubmit={onRename}>
          <label>
            Project name
            <input
              type="text"
              name="name"
              required
              maxLength={200}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </label>
          <button type="submit" disabled={renaming || renameValue.trim() === project.name}>
            {renaming ? 'Saving…' : 'Rename'}
          </button>
        </form>
      ) : null}

      {canManage ? (
        <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete project'}
        </button>
      ) : null}

      <h2>Workspace</h2>
      <ul>
        {PROJECT_CHILD_LINKS.map((link) => (
          <li key={link.href(projectId)}>
            <Link href={childHref(link.href(projectId))}>{link.label}</Link>
            <span className="environments">
              {' '}
              <span className={`env-badge env-${environment}`}>{environment.toUpperCase()}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}