'use client';

import Link from 'next/link';

import { useAuth } from '../../../../components/auth/auth-provider';
import { SignOutButton } from '../../../../components/auth/sign-out-button';
import { getApiBaseUrl } from '../../../../lib/brinnpay/client';

/** Deterministic, timezone-explicit timestamp for display (UTC). */
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * Account settings (phase 14 §6.3, D3 — **read-only**): the account identity
 * from the session, the session controls, public configuration, and pointers to
 * the docs and product pages. There is no profile editing, password change or
 * account deletion: no API exists for them (Phase 3 out of scope; Q2), and
 * inventing one here would be a contract change, not a UI decision.
 */
export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <section className="page settings-page">
      <h1>Settings</h1>
      <p className="page-subtitle">Read-only account surface.</p>

      <section aria-labelledby="settings-account-heading">
        <h2 id="settings-account-heading">Account</h2>
        {user ? (
          <dl className="definition-list">
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{user.name?.trim() ? user.name : '—'}</dd>
            </div>
            <div>
              <dt>User ID</dt>
              <dd className="mono">{user.id}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatTimestamp(user.created_at)}</dd>
            </div>
          </dl>
        ) : (
          <p className="state state-loading">Loading account…</p>
        )}
      </section>

      <section aria-labelledby="settings-session-heading">
        <h2 id="settings-session-heading">Session</h2>
        <p>Signing out revokes this session and returns you to the login page.</p>
        <SignOutButton />
      </section>

      <section aria-labelledby="settings-configuration-heading">
        <h2 id="settings-configuration-heading">Configuration</h2>
        <dl className="definition-list">
          <div>
            <dt>API base URL</dt>
            <dd className="mono">{getApiBaseUrl()}</dd>
          </div>
        </dl>
        <p className="hint">
          Public configuration only — API keys, webhook secrets and tokens are never shown here.
        </p>
      </section>

      <section aria-labelledby="settings-resources-heading">
        <h2 id="settings-resources-heading">Resources</h2>
        <ul>
          <li>
            <Link href="/docs">Docs</Link>
          </li>
          <li>
            <Link href="/product">Product</Link>
          </li>
        </ul>
      </section>
    </section>
  );
}
