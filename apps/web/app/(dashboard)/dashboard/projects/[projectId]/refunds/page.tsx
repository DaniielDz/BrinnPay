'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../../components/auth/auth-provider';
import {
  createRefund, isEnvironment, listMembers, listPayments, listRefunds,
  retrievePayment, retrieveProject, retrieveRefund,
  type Environment, type Payment, type Project, type Refund, type Role,
} from '../../../../../../lib/brinnpay/client';

function minor(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
}

function dollars(value: bigint): string {
  return `${value / BigInt(100)}.${(value % BigInt(100)).toString().padStart(2, '0')}`;
}

export default function ProjectRefundsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const { accessToken, user } = useAuth();
  const environment: Environment = useMemo(() => {
    const value = searchParams.get('environment');
    return value !== null && isEnvironment(value) ? value : 'test';
  }, [searchParams]);
  const requestedPayment = searchParams.get('payment_id');

  const [project, setProject] = useState<Project | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsCursor, setPaymentsCursor] = useState<string | null>(null);
  const [paymentsMore, setPaymentsMore] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [refundsCursor, setRefundsCursor] = useState<string | null>(null);
  const [refundsMore, setRefundsMore] = useState(false);
  const [detail, setDetail] = useState<Refund | null>(null);
  const [loading, setLoading] = useState(true);
  const [refundLoading, setRefundLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [partial, setPartial] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const loadRefunds = useCallback(async (parentId: string, cursor?: string) => {
    if (!accessToken) return;
    setRefundLoading(true);
    setActionError(null);
    try {
      const page = await listRefunds(accessToken, parentId, { cursor });
      setRefunds((current) => cursor ? [...current, ...page.data] : page.data);
      setRefundsCursor(page.next_cursor);
      setRefundsMore(page.has_more);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load refunds');
    } finally {
      setRefundLoading(false);
    }
  }, [accessToken]);

  // Reset selection on environment/project changes. A direct link is fetched
  // only after checking it belongs to this project and selected environment.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setProject(null);
    setPayment(null);
    setRefunds([]);
    setDetail(null);
    setPayments([]);
    void (async () => {
      try {
        const loaded = await retrieveProject(accessToken, projectId);
        const [members, page] = await Promise.all([
          listMembers(accessToken, loaded.organization_id),
          listPayments(accessToken, projectId, { environment }),
        ]);
        if (cancelled) return;
        setProject(loaded);
        setRole(members.data.find((member) => member.user_id === user?.id)?.role ?? 'viewer');
        setPayments(page.data);
        setPaymentsCursor(page.next_cursor);
        setPaymentsMore(page.has_more);
        if (requestedPayment) {
          const selected = await retrievePayment(accessToken, projectId, requestedPayment);
          if (cancelled) return;
          if (selected.project_id !== projectId || selected.environment !== environment) {
            setActionError('Payment not found in this environment');
          } else {
            setPayment(selected);
            void loadRefunds(selected.id);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && /not found/i.test(err.message)) setNotFound(true);
        else setError(err instanceof Error ? err.message : 'Unable to load refunds');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, projectId, environment, requestedPayment, user?.id, loadRefunds]);

  async function loadMorePayments() {
    if (!accessToken || !paymentsCursor) return;
    try {
      const page = await listPayments(accessToken, projectId, { environment, cursor: paymentsCursor });
      setPayments((current) => [...current, ...page.data]);
      setPaymentsCursor(page.next_cursor);
      setPaymentsMore(page.has_more);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load payments');
    }
  }

  async function selectPayment(id: string) {
    if (!accessToken) return;
    setDetail(null);
    setRefunds([]);
    setPayment(null);
    setActionError(null);
    try {
      const selected = await retrievePayment(accessToken, projectId, id);
      if (selected.project_id !== projectId || selected.environment !== environment) {
        setActionError('Payment not found in this environment');
        return;
      }
      setPayment(selected);
      await loadRefunds(selected.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load payment');
    }
  }

  async function viewRefund(id: string) {
    if (!accessToken || !payment) return;
    try {
      const loaded = await retrieveRefund(accessToken, payment.id, id);
      if (loaded.project_id === projectId && loaded.environment === environment) setDetail(loaded);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load refund');
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!accessToken || !payment) return;
    setCreating(true);
    setActionError(null);
    try {
      const created = await createRefund(accessToken, payment.id, {
        ...(partial ? { amount: amount.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setAmount('');
      setReason('');
      setDetail(created);
      await loadRefunds(payment.id);
      const fresh = await retrievePayment(accessToken, projectId, payment.id);
      if (fresh.environment === environment) setPayment(fresh);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create refund');
    } finally {
      setCreating(false);
    }
  }

  const remaining = payment ? minor(payment.amount) - refunds
    .filter((item) => item.status === 'succeeded').reduce((sum, item) => sum + minor(item.amount), BigInt(0)) : BigInt(0);
  const canCreate = role === 'owner' || role === 'admin';

  if (loading) return <section><h1>Refunds</h1><p className="state state-loading">Loading refunds…</p></section>;
  if (notFound || !project) return (
    <section><h1>Project not found</h1><p>The project does not exist or you are not a member of its organization.</p></section>
  );

  return (
    <section>
      <p><Link href={`/dashboard/projects/${projectId}`}>Back to project</Link></p>
      <h1>Refunds <span className={`env-badge env-${environment}`}>{environment.toUpperCase()}</span></h1>
      <p className="owning-org">{project.name}</p>
      {error && <p role="alert">{error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      <h2>Payments</h2>
      {payments.length === 0 && <p className="state">No payments in {environment.toUpperCase()} yet.</p>}
      <ul>{payments.map((item) => (
        <li key={item.id}>
          ${item.amount} — {item.status}{' '}
          <button type="button" onClick={() => void selectPayment(item.id)}>View refunds</button>
        </li>
      ))}</ul>
      {paymentsMore && <button type="button" onClick={() => void loadMorePayments()}>Load more payments</button>}

      {payment && <section aria-label="Payment refunds">
        <h2>Refunds for payment {payment.id}</h2>
        <p>Payment: ${payment.amount} {payment.currency.toUpperCase()} — {payment.status}</p>
        <p>Remaining refundable: {refundsMore ? 'Load all refunds to calculate' : `$${dollars(remaining)}`}</p>
        <button type="button" onClick={() => void loadRefunds(payment.id)}>Refresh refunds</button>
        {refundLoading && <p className="state state-loading">Loading payment refunds…</p>}
        {!refundLoading && refunds.length === 0 && <p className="state">No refunds for this payment yet.</p>}
        <ul>{refunds.map((item) => (
          <li key={item.id}>
            ${item.amount} — {item.status}{' '}
            <button type="button" onClick={() => void viewRefund(item.id)}>View detail</button>
          </li>
        ))}</ul>
        {refundsMore && <button type="button" onClick={() => void loadRefunds(payment.id, refundsCursor ?? undefined)}>Load more refunds</button>}
        {canCreate && payment.status === 'succeeded' && (refundsMore || remaining > BigInt(0)) &&
          <form onSubmit={(event) => void onCreate(event)} aria-label="Create refund">
            <label>Refund type{' '}
              <select value={partial ? 'partial' : 'full'} onChange={(event) => setPartial(event.target.value === 'partial')}>
                <option value="full">Full remaining balance</option>
                <option value="partial">Partial amount</option>
              </select>
            </label>
            {partial && <label>Amount (USD){' '}
              <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>}
            <label>Reason{' '}
              <input maxLength={255} value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create refund'}</button>
          </form>}
      </section>}
      {detail && <section aria-label="Refund detail">
        <h2>Refund detail</h2>
        <dl>
          <dt>ID</dt><dd>{detail.id}</dd>
          <dt>Payment</dt><dd>{detail.payment_id}</dd>
          <dt>Amount</dt><dd>${detail.amount} {detail.currency.toUpperCase()}</dd>
          <dt>Status</dt><dd>{detail.status}</dd>
          <dt>Reason</dt><dd>{detail.reason ?? '—'}</dd>
          <dt>Created</dt><dd>{detail.created_at}</dd>
        </dl>
      </section>}
    </section>
  );
}
