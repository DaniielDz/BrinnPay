'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useAuth } from '../../../components/auth/auth-provider';
import {
  listMembers,
  listOrganizations,
  listProjects,
  type Environment,
  type Organization,
  type Project,
  type Role,
} from '../../../lib/brinnpay/client';

interface OrganizationEntry extends Organization {
  caller_role: Role;
}

/**
 * Dashboard overview (phase 14 §6.2, D2): a read-only summary assembled from
 * the existing first-page read endpoints — organizations (with the caller's
 * role) and projects (with owning organization and TEST/LIVE context) — plus
 * quick links. No metrics, counts or aggregates: those would require API
 * surface that does not exist (Q3). Registration always creates a default
 * organization (ADR-0010), so the primary empty state is "no projects yet".
 */
export default function DashboardOverviewPage() {
  const { accessToken, user } = useAuth();
  const [organizations, setOrganizations] = useState<OrganizationEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!accessToken || !user) return;
      setLoading(true);
      setError(null);
      try {
        const [orgPage, projectPage] = await Promise.all([
          listOrganizations(accessToken),
          listProjects(accessToken),
        ]);

        const withRoles = await Promise.all(
          orgPage.data.map(async (organization) => {
            let callerRole: Role = 'viewer';
            try {
              const members = await listMembers(accessToken, organization.id, { limit: 100 });
              const self = members.data.find((member) => member.user_id === user.id);
              if (self) callerRole = self.role;
            } catch {
              // Membership may have changed; fall back to a read-only role.
            }
            return { ...organization, caller_role: callerRole };
          }),
        );

        if (!cancelled) {
          setOrganizations(withRoles);
          setProjects(projectPage.data);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load the overview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, user]);

  if (!accessToken) {
    return null; // AuthGuard gates this route; the token arrives after refresh.
  }

  const organizationName = (organizationId: string): string =>
    organizations.find((organization) => organization.id === organizationId)?.name ??
    'Unknown organization';

  return (
    <section className="page overview-page">
      <h1>Overview</h1>
      <p className="page-subtitle">Where do you want to go?</p>

      {loading ? <p className="state state-loading">Loading your workspace…</p> : null}
      {!loading && error ? <p role="alert">{error}</p> : null}

      {!loading && !error ? (
        <>
          <section aria-labelledby="overview-organizations-heading">
            <div className="page-section-header">
              <h2 id="overview-organizations-heading">Organizations</h2>
              <Link href="/dashboard/organizations">View all</Link>
            </div>
            {organizations.length === 0 ? (
              <div className="state state-empty">
                <p>No organizations yet. Create one to get started.</p>
                <Link href="/dashboard/organizations" className="button button-primary">
                  Create organization
                </Link>
              </div>
            ) : (
              <ul className="item-list">
                {organizations.map((organization) => (
                  <li key={organization.id} className="item-row">
                    <Link href={`/dashboard/organizations/${organization.id}`}>
                      {organization.name}
                    </Link>
                    <span className="caller-role">your role: {organization.caller_role}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="overview-projects-heading">
            <div className="page-section-header">
              <h2 id="overview-projects-heading">Projects</h2>
              <Link href="/dashboard/projects">View all</Link>
            </div>
            {projects.length === 0 ? (
              <div className="state state-empty">
                <p>
                  {organizations.length > 0
                    ? 'No projects yet. Create your first project to issue API keys and start taking simulated payments.'
                    : 'No projects yet. Create an organization first, then create a project inside it.'}
                </p>
                <Link
                  href={organizations.length > 0 ? '/dashboard/projects' : '/dashboard/organizations'}
                  className="button button-primary"
                >
                  {organizations.length > 0 ? 'Create project' : 'Create organization'}
                </Link>
              </div>
            ) : (
              <ul className="item-list">
                {projects.map((project) => (
                  <li key={project.id} className="item-row">
                    <Link href={`/dashboard/projects/${project.id}`}>{project.name}</Link>
                    <span className="owning-org">{organizationName(project.organization_id)}</span>
                    <span className="environments">
                      {project.environments.map((environment: Environment) => (
                        <span key={environment} className={`env-badge env-${environment}`}>
                          {environment.toUpperCase()}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <nav className="quick-links" aria-labelledby="overview-quick-links-heading">
            <h2 id="overview-quick-links-heading">Quick links</h2>
            <ul>
              <li>
                <Link href="/dashboard/organizations">Create organization</Link>
              </li>
              <li>
                <Link href="/dashboard/projects">Create project</Link>
              </li>
              <li>
                <Link href="/docs">Docs</Link>
              </li>
              <li>
                <Link href="/dashboard/settings">Settings</Link>
              </li>
            </ul>
          </nav>
        </>
      ) : null}
    </section>
  );
}
