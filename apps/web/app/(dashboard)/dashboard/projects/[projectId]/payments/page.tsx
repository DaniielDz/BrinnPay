'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../components/auth/auth-provider';
import {
  createPayment,
  isEnvironment,
  isTerminalPayment,
  listCustomers,
  listMembers,
  listPayments,
  retrievePayment,
  retrieveProject,
  type Environment,
  type Payment,
  type Project,
  type Role,
} from '../../../../../../lib/brinnpay/client';

/** The simulation advances `pending → processing → succeeded` within seconds
 *  of creation (defaults 1000/2000 ms), so a while-any-non-terminal poll makes
 *  the lifecycle visible without hammering the API. */
const PAYMENT_POLL_MS = 3_000;

/**
 * Payments page (phase 7 §5.2): the placeholder replaced by the payments UI
 * inside the project shell. The page operates on the environment from the
 * shell selector (`?environment=`, default `test`) — TEST/LIVE data is never
 * mixed (D1). List + cursor pagination + a refresh button; while any visible
 * payment is non-terminal the page polls so the default-success simulation
 * (D2) becomes visible. Create for owner/admin per the capability matrix
 * (§4.3, D5) with a customer select scoped to the same (project, environment)
 * (D3); member/viewer keep the read-only list and detail; a non-member sees
 * the not-found state. The API remains the enforcement point — UI hiding is
 * presentation only.
 */
export default function ProjectPaymentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [callerRole, setCallerRole] = useState<Role>('viewer');
  const [payments, setPayments] = useState<Payment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [customerOptions, setCustomerOptions] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [createCustomerId, setCreateCustomerId] = useState('');
  const [createAmount, setCreateAmount] = useState('');
  const [createDescription, setCreateDescription] = useState('');

  const [selected, setSelected] = useState<Payment | null>(null);

  const selectedEnvironment: Environment = useMemo(() => {
    const selected = searchParams.get('environment');
    return selected !== null && isEnvironment(selected) ? selected : 'test';
  }, [searchParams]);

  const loadPayments = useCallback(
    async (cursor: string | null = null) => {
      if (!accessToken) return;
      setError(null);
      try {
        const page = await listPayments(accessToken, projectId, {
          environment: selectedEnvironment,
          cursor: cursor ?? undefined,
        });
        setPayments((current) => (cursor ? [...current, ...page.data] : page.data));
        setNextCursor(page.next_cursor);
        setHasMore(page.has_more);
        // Keep the open detail in sync with the authoritative snapshot.
        if (!cursor) {
          setSelected((current) => {
            if (!current) return current;
            return page.data.find((payment) => payment.id === current.id) ?? current;
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load payments');
      } finally {
        setLoading(false);
      }
    },
    [accessToken, projectId, selectedEnvironment],
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
  // changes; `loadPayments` is recreated on those inputs.
  useEffect(() => {
    if (!accessToken) return;
    void loadPayments(null);
  }, [accessToken, loadPayments]);

  const canManage = callerRole === 'owner' || callerRole === 'admin';

  // The default-success simulation makes every payment terminal within the
  // two configured delays; while any visible payment is still moving, poll so
  // the page reflects the lifecycle without a manual reload.
  useEffect(() => {
    if (!accessToken || payments.length === 0) return;
    const active = payments.some((payment) => !isTerminalPayment(payment));
    if (!active) return;
    const timer = setInterval(() => {
      void loadPayments(null);
    }, PAYMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [accessToken, payments, loadPayments]);

  // Customer options for the create select (owner/admin only, D1/D3): the
  // same project+environment as the payment will live in.
  useEffect(() => {
    if (!accessToken || !canManage) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await listCustomers(accessToken, projectId, {
          environment: selectedEnvironment,
          limit: 100,
        });
        if (!cancelled) {
          setCustomerOptions(page.data);
          setCreateCustomerId((current) =>
            current === '' || !page.data.some((customer) => customer.id === current)
              ? (page.data[0]?.id ?? '')
              : current,
          );
        }
      } catch {
        if (!cancelled) setCustomerOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canManage, projectId, selectedEnvironment]);

  async function onRefresh(): Promise<void> {
    if (!accessToken) return;
    setRefreshing(true);
    try {
      await loadPayments(null);
      if (selected) {
        const fresh = await retrievePayment(accessToken, projectId, selected.id).catch(() => null);
        if (fresh) setSelected(fresh);
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setActionError(null);
    setCreating(true);
    try {
      const amount = createAmount.trim();
      const description = createDescription.trim();
      await createPayment(accessToken, projectId, {
        environment: selectedEnvironment,
        customer_id: createCustomerId,
        amount,
        currency: 'usd',
        ...(description !== '' ? { description } : {}),
      });
      // The API orders by UUIDv7 id ascending (oldest first), so the new
      // record lands at the end; refetch the current window.
      setCreateAmount('');
      setCreateDescription('');
      await loadPayments(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create payment');
    } finally {
      setCreating(false);
    }
  }

  async function onView(paymentId: string): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    try {
      const loaded = await retrievePayment(accessToken, projectId, paymentId);
      setSelected(loaded);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load payment');
    }
  }

  if (loading) {
    return (
      <section>
        <h1>Payments</h1>
        <p>Loading payments…</p>
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
        Payments{' '}
        <span className={`env-badge env-${selectedEnvironment}`}>{selectedEnvironment.toUpperCase()}</span>
      </h1>
      <p className="owning-org">{project.name}</p>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <button type="button" onClick={() => void onRefresh()} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>

      {canManage ? (
        <form onSubmit={onCreate} aria-label="Create payment">
          <h2>Create payment</h2>
          <label>
            Customer
            {customerOptions.length === 0 ? (
              <select name="customer" disabled>
                <option>No customers in {selectedEnvironment.toUpperCase()} yet</option>
              </select>
            ) : (
              <select
                name="customer"
                required
                value={createCustomerId}
                onChange={(event) => setCreateCustomerId(event.target.value)}
              >
                {customerOptions.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.email}
                    {customer.name ? ` (${customer.name})` : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            Amount (USD)
            <input
              name="amount"
              inputMode="decimal"
              placeholder="10.00"
              required
              value={createAmount}
              onChange={(event) => setCreateAmount(event.target.value)}
            />
          </label>
          <label>
            Description
            <input
              name="description"
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
            />
          </label>
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create payment'}
          </button>
        </form>
      ) : null}

      <h2>Payments</h2>
      {payments.length === 0 ? <p>No payments in {selectedEnvironment.toUpperCase()} yet.</p> : null}
      <ul>
        {payments.map((payment) => (
          <li key={payment.id}>
            <span className={`payment-status payment-status-${payment.status}`}>{payment.status}</span>{' '}
            <span className="payment-amount">${payment.amount}</span> — created {payment.created_at}
            <button type="button" onClick={() => void onView(payment.id)}>
              View
            </button>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button type="button" onClick={() => void loadPayments(nextCursor)}>
          Load more
        </button>
      ) : null}

      {selected ? (
        <section aria-label="Payment detail">
          <h2>Payment detail</h2>
          <button type="button" onClick={() => void onRefresh()}>
            Refresh
          </button>
          <dl>
            <dt>ID</dt>
            <dd>{selected.id}</dd>
            <dt>Environment</dt>
            <dd>{selected.environment}</dd>
            <dt>Customer</dt>
            <dd>{selected.customer_id}</dd>
            <dt>Amount</dt>
            <dd>
              ${selected.amount} {selected.currency.toUpperCase()}
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`payment-status payment-status-${selected.status}`}>{selected.status}</span>
            </dd>
            <dt>Failure code</dt>
            <dd>{selected.failure_code ?? '—'}</dd>
            <dt>Description</dt>
            <dd>{selected.description ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{selected.created_at}</dd>
            <dt>Updated</dt>
            <dd>{selected.updated_at}</dd>
          </dl>
        </section>
      ) : null}
    </section>
  );
}