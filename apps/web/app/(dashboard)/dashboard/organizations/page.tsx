'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../components/auth/auth-provider';
import {
  createOrganization,
  listMembers,
  listOrganizations,
  type Organization,
  type Role,
} from '../../../../lib/brinnpay/client';

interface OrganizationWithRole extends Organization {
  caller_role: Role;
}

/**
 * Organization list + create (phase 4 §5.1). The API is the enforcement point;
 * the caller's role per organization is derived from `organizations.listMembers`
 * so the list can present it (the contract's `organizations.list` carries only
 * the organization itself). An empty result (no memberships) renders an empty
 * state with the create form.
 */
export default function OrganizationsPage() {
  const { accessToken, user } = useAuth();
  const [organizations, setOrganizations] = useState<OrganizationWithRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
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
        const page = await listOrganizations(accessToken);
        const withRoles = await Promise.all(
          page.data.map(async (organization) => {
            let callerRole: Role = 'viewer';
            try {
              const members = await listMembers(accessToken, organization.id, { limit: 100 });
              const self = members.data.find((member) => member.user_id === user.id);
              if (self) callerRole = self.role;
            } catch {
              // A member of the (just-deleted) org might no longer be a member;
              // keep the entry but fall back to a read-only presentation.
            }
            return { ...organization, caller_role: callerRole };
          }),
        );
        if (!cancelled) setOrganizations(withRoles);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load organizations');
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
    if (!accessToken) return;
    setCreateError(null);
    setCreating(true);
    try {
      await createOrganization(accessToken, { name });
      setName('');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Unable to create organization');
    } finally {
      setCreating(false);
    }
  }

  if (!accessToken) {
    return null; // AuthGuard gates this route; token arrives after refresh.
  }

  return (
    <section>
      <h1>Organizations</h1>

      {loading ? <p>Loading organizations…</p> : null}
      {!loading && error ? <p role="alert">{error}</p> : null}

      {!loading && !error ? (
        organizations.length === 0 ? (
          <p>No organizations yet. Create your first one below.</p>
        ) : (
          <ul>
            {organizations.map((organization) => (
              <li key={organization.id}>
                <Link href={`/dashboard/organizations/${organization.id}`}>{organization.name}</Link>
                <span className="caller-role"> — your role: {organization.caller_role}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form onSubmit={onCreate}>
        <h2>Create organization</h2>
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
    </section>
  );
}