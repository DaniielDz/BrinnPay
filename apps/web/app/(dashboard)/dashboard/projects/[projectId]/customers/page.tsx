'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../components/auth/auth-provider';
import {
  createCustomer,
  deleteCustomer,
  isEnvironment,
  listCustomers,
  listMembers,
  retrieveCustomer,
  retrieveProject,
  updateCustomer,
  type Customer,
  type Environment,
  type Project,
  type Role,
} from '../../../../../../lib/brinnpay/client';

const SEARCH_DEBOUNCE_MS = 300;

/** One row of the simple key/value metadata editor (phase 6 §5.1/§5.3). */
interface MetadataRow {
  key: string;
  value: string;
}

/** Flattens the editor rows into the contract's flat string map (D6): rows
 *  with a blank key are dropped; duplicate keys collapse (last row wins). */
function metadataFromRows(rows: MetadataRow[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== '') metadata[key] = row.value;
  }
  return metadata;
}

function MetadataEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: MetadataRow[];
  onChange: (rows: MetadataRow[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="metadata-row" key={index}>
          <label>
            Key
            <input
              name={`${label}-key-${index}`}
              value={row.key}
              onChange={(event) =>
                onChange(rows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))
              }
            />
          </label>
          <label>
            Value
            <input
              name={`${label}-value-${index}`}
              value={row.value}
              onChange={(event) =>
                onChange(rows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))
              }
            />
          </label>
          <button
            type="button"
            className="danger"
            onClick={() => onChange(rows.filter((_entry, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        Add metadata row
      </button>
    </fieldset>
  );
}

/**
 * Customers page (phase 6 §5.1): the placeholder route replaced by the
 * customers UI inside the project shell. The page operates on the environment
 * from the shell selector (`?environment=`, default `test`) — TEST/LIVE data
 * is never mixed (D2). List + debounced search + cursor pagination; create /
 * edit / delete for owner/admin per the capability matrix (§4.3); member/
 * viewer keep the read-only list and detail; a non-member sees the not-found
 * state (project access semantics, phase 5 §5.3). The API remains the
 * enforcement point — UI hiding is presentation only.
 */
export default function ProjectCustomersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [callerRole, setCallerRole] = useState<Role>('viewer');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createMetadata, setCreateMetadata] = useState<MetadataRow[]>([]);

  const [selected, setSelected] = useState<Customer | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editEmail, setEditEmail] = useState('');
  const [editName, setEditName] = useState('');
  const [editMetadata, setEditMetadata] = useState<MetadataRow[]>([]);

  const selectedEnvironment: Environment = useMemo(() => {
    const selected = searchParams.get('environment');
    return selected !== null && isEnvironment(selected) ? selected : 'test';
  }, [searchParams]);

  // Debounced search box (phase 6 §5.1): typing replaces the result set once
  // the term settles; the cursor resets with the new query.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadCustomers = useCallback(
    async (cursor: string | null = null) => {
      if (!accessToken) return;
      setError(null);
      try {
        const page = await listCustomers(accessToken, projectId, {
          environment: selectedEnvironment,
          search: search === '' ? undefined : search,
          cursor: cursor ?? undefined,
        });
        setCustomers((current) => (cursor ? [...current, ...page.data] : page.data));
        setNextCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load customers');
      } finally {
        setLoading(false);
      }
    },
    [accessToken, projectId, selectedEnvironment, search],
  );

  // Project access (phase 5 §5.3) + caller role from the owning org's roster;
  // the API remains the enforcement point.
  useEffect(() => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await retrieveProject(accessToken, projectId);
        const memberPage = await listMembers(accessToken, loaded.organization_id).catch(() => null);
        setProject(loaded);
        const self = memberPage?.data.find((member) => member.user_id === user?.id);
        setCallerRole(self?.role ?? 'viewer');
        setNotFound(false);
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) {
          setNotFound(true);
        } else {
          setError(err instanceof Error ? err.message : 'Unable to load project');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [accessToken, projectId, user?.id]);

  // (Re)load the environment's list on mount and whenever the shell selector
  // or the (debounced) search term changes; `loadCustomers` is recreated on
  // those inputs, so keying on it yields exactly that.
  useEffect(() => {
    if (!accessToken) return;
    void loadCustomers(null);
  }, [accessToken, loadCustomers]);

  if (!accessToken) return null;

  const canManage = callerRole === 'owner' || callerRole === 'admin';

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setActionError(null);
    setCreating(true);
    try {
      const email = createEmail.trim();
      const name = createName.trim();
      await createCustomer(accessToken, projectId, {
        environment: selectedEnvironment,
        email,
        ...(name !== '' ? { name } : {}),
        ...(createMetadata.length > 0 ? { metadata: metadataFromRows(createMetadata) } : {}),
      });
      // The API orders by UUIDv7 id ascending (oldest first), so the new
      // record lands at the end; refetch the current window instead of
      // prepending.
      setCreateEmail('');
      setCreateName('');
      setCreateMetadata([]);
      await loadCustomers(null);
      setLoading(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create customer');
    } finally {
      setCreating(false);
    }
  }

  async function onView(customerId: string): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    try {
      const loaded = await retrieveCustomer(accessToken, projectId, customerId);
      setSelected(loaded);
      setEditing(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load customer');
    }
  }

  async function onSaveEdit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken || !selected) return;
    setActionError(null);
    setSaving(true);
    try {
      const email = editEmail.trim();
      const name = editName.trim();
      const updated = await updateCustomer(accessToken, projectId, selected.id, {
        email,
        // `name` is non-nullable in the contract (D7): clearing is unsupported,
        // so an empty field is omitted rather than sent as null (400).
        ...(name !== '' ? { name } : {}),
        metadata: metadataFromRows(editMetadata),
      });
      setSelected(updated);
      setEditing(false);
      setCustomers((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update customer');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(customer: Customer): Promise<void> {
    if (!accessToken) return;
    if (!window.confirm(`Delete customer ${customer.email}? This cannot be undone.`)) return;
    setActionError(null);
    try {
      await deleteCustomer(accessToken, projectId, customer.id);
      setCustomers((current) => current.filter((entry) => entry.id !== customer.id));
      if (selected?.id === customer.id) {
        setSelected(null);
        setEditing(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to delete customer');
    }
  }

  if (loading) {
    return (
      <section>
        <h1>Customers</h1>
        <p>Loading customers…</p>
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

  return (
    <section>
      <p>
        <Link href={`/dashboard/projects/${projectId}`}>Back to project</Link>
      </p>
      <h1>
        Customers{' '}
        <span className={`env-badge env-${selectedEnvironment}`}>{selectedEnvironment.toUpperCase()}</span>
      </h1>
      <p className="owning-org">{project.name}</p>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <label>
        Search
        <input
          name="search"
          value={searchInput}
          placeholder="Search by email or name"
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </label>

      {canManage ? (
        <form onSubmit={onCreate} aria-label="Create customer">
          <h2>Create customer</h2>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              value={createEmail}
              onChange={(event) => setCreateEmail(event.target.value)}
            />
          </label>
          <label>
            Name
            <input name="name" value={createName} onChange={(event) => setCreateName(event.target.value)} />
          </label>
          <MetadataEditor
            label="Metadata"
            rows={createMetadata}
            onChange={setCreateMetadata}
          />
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create customer'}
          </button>
        </form>
      ) : null}

      <h2>Customers</h2>
      {customers.length === 0 ? <p>No customers in {selectedEnvironment.toUpperCase()} yet.</p> : null}
      <ul>
        {customers.map((customer) => (
          <li key={customer.id}>
            <span className="customer-email">{customer.email}</span>
            {customer.name ? <span className="customer-name"> — {customer.name}</span> : null}{' '}
            — created {customer.created_at}
            <button type="button" onClick={() => void onView(customer.id)}>
              View
            </button>
            {canManage ? (
              <button type="button" className="danger" onClick={() => void onDelete(customer)}>
                Delete
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button type="button" onClick={() => void loadCustomers(nextCursor)}>
          Load more
        </button>
      ) : null}

      {selected ? (
        <section aria-label="Customer detail">
          <h2>Customer detail</h2>
          {editing ? (
            <form onSubmit={onSaveEdit} aria-label="Edit customer">
              <label>
                Email
                <input
                  name="edit-email"
                  type="email"
                  required
                  value={editEmail}
                  onChange={(event) => setEditEmail(event.target.value)}
                />
              </label>
              <label>
                Name
                <input name="edit-name" value={editName} onChange={(event) => setEditName(event.target.value)} />
              </label>
              <MetadataEditor label="Metadata" rows={editMetadata} onChange={setEditMetadata} />
              <button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="dismiss" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <dl>
              <dt>ID</dt>
              <dd>{selected.id}</dd>
              <dt>Email</dt>
              <dd>{selected.email}</dd>
              <dt>Name</dt>
              <dd>{selected.name ?? '—'}</dd>
              <dt>Metadata</dt>
              <dd>
                {Object.keys(selected.metadata).length === 0 ? (
                  '—'
                ) : (
                  <ul>
                    {Object.entries(selected.metadata).map(([key, value]) => (
                      <li key={key}>
                        <code>{key}</code>: {value}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt>Created</dt>
              <dd>{selected.created_at}</dd>
              <dt>Updated</dt>
              <dd>{selected.updated_at}</dd>
            </dl>
          )}
          {canManage && !editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditEmail(selected.email);
                  setEditName(selected.name ?? '');
                  setEditMetadata(
                    Object.entries(selected.metadata).map(([key, value]) => ({ key, value })),
                  );
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <button type="button" className="danger" onClick={() => void onDelete(selected)}>
                Delete
              </button>
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}