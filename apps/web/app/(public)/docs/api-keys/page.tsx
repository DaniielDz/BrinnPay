import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import { CREATE_API_KEY } from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'API keys — BrinnPay',
  description:
    'BrinnPay API key format and scope, one-time display, rotation, revocation, leak response, and how keys interact with rate limits.',
};

/**
 * API key guide (phase 15 §5.4): format and prefixes, the exact scope of a
 * key, one-time display and hashed storage, create-then-revoke rotation,
 * immediate revocation, leak response, and the `401` a revoked key gets.
 */
export default function ApiKeysPage() {
  return (
    <Guide
      title="API keys"
      lead="An API key identifies exactly one project and one environment. It is shown once, stored only as a hash, and can be revoked at any time."
      sources={['docs/openapi.yaml', 'docs/api-conventions.md']}
    >
      <section aria-labelledby="api-keys-format">
        <h2 id="api-keys-format">Format and prefixes</h2>
        <p>
          Keys are prefixed with the environment they belong to, so the wrong environment is
          visible at a glance:
        </p>
        <ul>
          <li>
            <code>sk_test_…</code> — the project&rsquo;s <code>test</code> environment.
          </li>
          <li>
            <code>sk_live_…</code> — the project&rsquo;s <code>live</code> environment.
          </li>
        </ul>
        <p>
          The prefix is part of the credential, and both environments are simulated: no key,
          in either environment, can move real money. Treat the rest of the string as a
          secret — the examples in these guides always write it as <code>sk_test_…</code>.
        </p>
        <Callout title="Placeholder values" tone="warning">
          <p>
            Never commit a real key, paste one into a ticket, or log one. Everything in these
            guides is a placeholder.
          </p>
        </Callout>
      </section>

      <section aria-labelledby="api-keys-scope">
        <h2 id="api-keys-scope">Scope</h2>
        <ul>
          <li>
            A key belongs to <strong>exactly one project and one environment</strong>. It can
            only act on resources of that project in that environment.
          </li>
          <li>
            A key carries <strong>no organization-management authority</strong>. It cannot
            create or read organizations, projects, members, invitations or other keys — those
            endpoints are session-only and answer <code>401</code> to a key.
          </li>
          <li>
            Keys are <strong>project-wide across both environments only in the listing</strong>:
            the list of keys belongs to the project, while each individual key is bound to one
            environment.
          </li>
          <li>
            Revoked keys stay in the project list with a <code>revoked_at</code> timestamp, so
            history remains auditable.
          </li>
        </ul>
        <p>
          <Link href="/docs/environments">How environments relate to keys →</Link>
        </p>
      </section>

      <section aria-labelledby="api-keys-create">
        <h2 id="api-keys-create">Creating a key</h2>
        <p>
          <strong>Where:</strong> the dashboard — open a project, then <strong>API keys</strong>{' '}
          and use the <strong>Create key</strong> form with the environment you need. The same
          operation exists on the API, but it is session-only (an administrative role is
          required to manage keys):
        </p>
        <CodeExampleList examples={[CREATE_API_KEY]} />
        <p>
          <strong>Shown once.</strong> The plaintext key is returned only by the creation
          response (and revealed once in the dashboard). Only a hash is stored, so the key can
          never be displayed again, read back or “recovered” — if you lose it, you rotate.
        </p>
        <p className="hint">
          Key metadata (id, project, environment, creation and revocation times) stays visible
          in the list; the credential itself does not.
        </p>
      </section>

      <section aria-labelledby="api-keys-rotate">
        <h2 id="api-keys-rotate">Rotating a key</h2>
        <p>
          Rotation is <strong>create, then revoke</strong> — there is no in-place re-issue:
        </p>
        <ol>
          <li>Create a new key for the same project and environment.</li>
          <li>Deploy the new key to your integration.</li>
          <li>Revoke the old key.</li>
        </ol>
        <p>
          The dashboard <strong>Rotate</strong> action does exactly this and reveals the
          replacement once. Because the old key is revoked only after the replacement exists,
          both are valid for a short window — that overlap is intentional, and it is why the
          order matters: revoking first would break live traffic, while deploying second would
          leave you with no working key.
        </p>
      </section>

      <section aria-labelledby="api-keys-revoke">
        <h2 id="api-keys-revoke">Revoking a key</h2>
        <p>
          Revocation is immediate: from that moment the key fails API-key authentication with{' '}
          <code>401 UNAUTHENTICATED</code>, on every endpoint, without a propagation delay.
          Revoking an already-revoked key is a no-op (<code>204</code>).
        </p>
        <p>
          Unknown keys and revoked keys produce the <strong>same</strong> <code>401</code> as a
          missing credential — the response never reveals whether a key ever existed.
        </p>
      </section>

      <section aria-labelledby="api-keys-leak">
        <h2 id="api-keys-leak">If you suspect a leak</h2>
        <Callout title="Act on the key, not on the log" tone="important">
          <p>
            Revoke or rotate the exposed key first, then investigate. Since the plaintext is
            never stored, rotating is enough to invalidate the exposed value.
          </p>
        </Callout>
        <ol>
          <li>
            <strong>Revoke</strong> the key (dashboard, or the revoke endpoint with a session)
            if it is compromised and you do not need it any more.
          </li>
          <li>
            <strong>Rotate</strong> if your integration is live: create the replacement,
            deploy it, revoke the old one.
          </li>
          <li>
            Check the request logs for calls made with that key — the key&rsquo;s identifier,
            never its plaintext, is recorded on each request.
          </li>
        </ol>
        <p>
          <Link href="/docs/logs">Request logs and audit logs →</Link>
        </p>
      </section>

      <section aria-labelledby="api-keys-limits">
        <h2 id="api-keys-limits">Keys and rate limits</h2>
        <p>
          An API-key-authenticated request spends <strong>two</strong> budgets: the caller&rsquo;s{' '}
          <code>ip</code> budget and the key&rsquo;s <code>api_key</code> budget. Budgets are
          isolated per key, so one exhausted key never throttles another key, another project,
          or session traffic from the same address.
        </p>
        <p>
          <Link href="/docs/rate-limits">Rate limits in detail →</Link>
        </p>
      </section>
    </Guide>
  );
}
