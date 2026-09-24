'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../components/auth/auth-provider';
import {
  createApiKey,
  isEnvironment,
  listApiKeys,
  listMembers,
  retrieveProject,
  revokeApiKey,
  type ApiKey,
  type ApiKeyCreated,
  type Environment,
  type Project,
  type Role,
} from '../../../../../../lib/brinnpay/client';

const ENVIRONMENT_OPTIONS: Environment[] = ['test', 'live'];

/**
 * API-key management page (phase 5 §5.2): project-wide list (both
 * environments, per D5), create with **once-only** plaintext display, revoke
 * with confirmation, and rotate (create-then-revoke, D1). The key material is
 * never shown again: the create response is kept in component state only,
 * cleared by any reload or subsequent create. Owner/admin see the management
 * controls; the API remains the enforcement point. A non-member sees the
 * not-found state (project access semantics, §4.2/D2).
 */
export default function ProjectApiKeysPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [callerRole, setCallerRole] = useState<Role>('viewer');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createEnvironment, setCreateEnvironment] = useState<Environment>('test');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The plaintext credential, shown exactly once and never re-fetched.
  const [revealed, setRevealed] = useState<ApiKeyCreated | null>(null);
  const [rotateSource, setRotateSource] = useState<ApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedEnvironment: Environment = useMemo(() => {
    const selected = searchParams.get('environment');
    return selected !== null && isEnvironment(selected) ? selected : 'test';
  }, [searchParams]);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setError(null);
    try {
      const loaded = await retrieveProject(accessToken, projectId);
      const [keysPage, memberPage] = await Promise.all([
        listApiKeys(accessToken, projectId),
        listMembers(accessToken, loaded.organization_id).catch(() => null),
      ]);
      setProject(loaded);
      setKeys(keysPage.data);

      // Caller role derived from the owning org's roster (phase 4 pattern);
      // the API remains the enforcement point.
      const self = memberPage?.data.find((member) => member.user_id === user?.id);
      setCallerRole(self?.role ?? 'viewer');
      setNotFound(false);
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        setNotFound(true);
      } else {
        setError(err instanceof Error ? err.message : 'Unable to load API keys');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, projectId, user?.id]);

  useEffect(() => {
    // The shell hands the selection over via `?environment=`; a freshly
    // opened page defaults accordingly.
    setCreateEnvironment(selectedEnvironment);
    // A reload must never re-show key material.
    setRevealed(null);
    setLoading(true);
    void reload();
  }, [reload, selectedEnvironment]);

  if (!accessToken) return null;

  if (loading) {
    return (
      <section>
        <h1>API keys</h1>
        <p>Loading API keys…</p>
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

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setActionError(null);
    setCreating(true);
    setCopied(false);
    setRotateSource(null);
    try {
      const created = await createApiKey(accessToken, projectId, createEnvironment);
      setRevealed(created);
      setKeys((current) => [created, ...current]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create API key');
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(key: ApiKey): Promise<void> {
    if (!accessToken) return;
    if (!window.confirm(`Revoke this ${key.environment.toUpperCase()} API key? This cannot be undone.`)) return;
    setActionError(null);
    try {
      await revokeApiKey(accessToken, projectId, key.id);
      setKeys((current) =>
        current.map((entry) =>
          entry.id === key.id ? { ...entry, revoked_at: new Date().toISOString() } : entry,
        ),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to revoke API key');
    }
  }

  /** Rotate (D1): create a replacement, then revoke the selected key — the
   *  plaintext of the replacement is shown once. */
  async function onRotate(key: ApiKey): Promise<void> {
    if (!accessToken) return;
    if (
      !window.confirm(
        `Rotate this ${key.environment.toUpperCase()} API key? A new key is created and the current one is revoked.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setCreating(true);
    setCopied(false);
    try {
      const created = await createApiKey(accessToken, projectId, key.environment);
      // D1 rotation workflow: create the replacement, then revoke the old key.
      setRotateSource(key);
      setRevealed(created);
      await revokeApiKey(accessToken, projectId, key.id);
      setKeys((current) => [
        created,
        ...current.map((entry) =>
          entry.id === key.id ? { ...entry, revoked_at: new Date().toISOString() } : entry,
        ),
      ]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to rotate API key');
    } finally {
      setCreating(false);
    }
  }

  async function onCopy(): Promise<void> {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
    } catch {
      // Clipboard unavailable (non-secure context); the plaintext stays visible.
    }
  }

  return (
    <section>
      <p>
        <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
      </p>
      <h1>API keys</h1>
      <p className="owning-org">{project.name}</p>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {revealed ? (
        <div className="revealed-key" role="region" aria-label="New API key">
          <div className="revealed-env">{revealed.environment.toUpperCase()}</div>
          <code>{revealed.key}</code>
          {rotatingLabel(revealed, rotateSource)}
          <p className="warning">
            This is the only time this key is shown. Copy it now — it cannot be retrieved later.
          </p>
          <button type="button" onClick={() => void onCopy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="dismiss" onClick={() => setRevealed(null)}>
            Done
          </button>
        </div>
      ) : null}

      {canManage ? (
        <form onSubmit={onCreate}>
          <h2>Create API key</h2>
          <label>
            Environment
            <select
              name="environment"
              value={createEnvironment}
              onChange={(event) => setCreateEnvironment(event.target.value as Environment)}
            >
              {ENVIRONMENT_OPTIONS.map((environment) => (
                <option key={environment} value={environment}>
                  {environment.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </form>
      ) : null}

      <h2>Keys</h2>
      {keys.length === 0 ? (
        <p>No API keys yet.</p>
      ) : (
        <ul>
          {keys.map((key) => (
            <li key={key.id}>
              <span className={`env-badge env-${key.environment}`}>{key.environment.toUpperCase()}</span>{' '}
              <span className="key-id">{key.id}</span> — created {key.created_at}
              {key.revoked_at ? (
                <> — revoked {key.revoked_at}</>
              ) : (
                <>
                  — <span className="key-status-active">active</span>
                </>
              )}
              {canManage && key.revoked_at ? (
                <button type="button" onClick={() => void onRotate(key)}>
                  Rotate
                </button>
              ) : null}
              {canManage && !key.revoked_at ? (
                <button type="button" className="danger" onClick={() => void onRevoke(key)}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function rotatingLabel(revealed: ApiKeyCreated, rotateSource: ApiKey | null): string | null {
  return rotateSource && rotateSource.id !== revealed.id
    ? ` — rotating ${rotateSource.environment.toUpperCase()} key ${rotateSource.id}`
    : null;
}