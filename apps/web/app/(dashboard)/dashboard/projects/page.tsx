'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../components/auth/auth-provider';
import {
  createProject,
  listMembers,
  listOrganizations,
  listProjects,
  type Environment,
  type Organization,
  type Project,
  type Role,
} from '../../../../lib/brinnpay/client';

interface Row extends Project {
  organization_name: string;
}

/** Presentation mirror of the phase 5 capability matrix (§4.3): only owner/
 *  admin may create projects; the API remains the enforcement point. */
const canCreateProjects = (role: Role) => role === 'owner' || role === 'admin';

/**
 * Project list + create (phase 5 §5.1). `projects.list` carries only the
 * owning organization id, so the owning organization's name is mapped from
 * `organizations.list`; the create form offers only the caller's organizations
 * where they hold `projects.create` (owner/admin), derived from the member
 * roster the same way the Phase 4 list derives the caller role.
 */
export default function ProjectsPage() {
  const { accessToken, user } = useAuth();
  const [projects, setProjects] = useState<Row[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!accessToken || !user) return;
      setLoading(true);
      setError(null);
      try {
        const [projectPage, orgPage] = await Promise.all([
          listProjects(accessToken),
          listOrganizations(accessToken),
        ]);

        // Owning-organization name map, plus the caller's role per org so the
        // create selector only offers orgs where projects.create applies.
        const withRoles = await Promise.all(
          orgPage.data.map(async (organization) => {
            let callerRole: Role = 'viewer';
            try {
              const members = await listMembers(accessToken, organization.id, { limit: 100 });
              const self = members.data.find((member) => member.user_id === user.id);
              if (self) callerRole = self.role;
            } catch {
              // Membership may have just been removed; fall back to read-only.
            }
            return { organization, callerRole };
          }),
        );
        const nameById = new Map(orgPage.data.map((organization) => [organization.id, organization.name]));
        const createable = withRoles
          .filter(({ callerRole }) => canCreateProjects(callerRole))
          .map(({ organization }) => organization);

        if (!cancelled) {
          setOrganizations(createable);
          setProjects(
            projectPage.data.map((project) => ({
              ...project,
              organization_name: nameById.get(project.organization_id) ?? 'Unknown organization',
            })),
          );
          setOrganizationId((current) => current || (createable[0]?.id ?? ''));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load projects');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, user, refreshKey]);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken || !organizationId || !name.trim()) return;
    setCreateError(null);
    setCreating(true);
    try {
      await createProject(accessToken, { organization_id: organizationId, name });
      setName('');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Unable to create project');
    } finally {
      setCreating(false);
    }
  }

  if (!accessToken) {
    return null; // AuthGuard gates this route; token arrives after refresh.
  }

  return (
    <section>
      <h1>Projects</h1>

      {loading ? <p>Loading projects…</p> : null}
      {!loading && error ? <p role="alert">{error}</p> : null}

      {!loading && !error ? (
        projects.length === 0 ? (
          <p>No projects yet. Create your first one below.</p>
        ) : (
          <ul>
            {projects.map((project) => (
              <li key={project.id}>
                <Link href={`/dashboard/projects/${project.id}`}>{project.name}</Link>
                <span className="owning-org"> — {project.organization_name}</span>
                <span className="environments">
                  {' '}
                  {project.environments.map((environment) => (
                    <span key={environment} className={`env-badge env-${environment}`}>
                      {ENV_LABEL[environment]}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {!loading && !error && organizations.length > 0 ? (
        <form onSubmit={onCreate}>
          <h2>Create project</h2>
          <label>
            Organization
            <select
              name="organization_id"
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              type="text"
              name="name"
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {createError ? <p role="alert">{createError}</p> : null}
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

const ENV_LABEL: Record<Environment, string> = {
  test: 'TEST',
  live: 'LIVE',
};