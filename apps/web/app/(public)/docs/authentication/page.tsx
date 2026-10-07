import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeBlock, CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  AUTHENTICATED_REQUEST,
  ERROR_ENVELOPE_EXAMPLE,
  LOGIN_ACCOUNT,
  REFRESH_SESSION,
  REGISTER_ACCOUNT,
} from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Authentication — BrinnPay',
  description:
    'The two BrinnPay authentication modes — API key and session — which routes accept each, how each credential is obtained, and what each failure looks like.',
};

const MODE_ROWS: { mode: string; credential: string; scope: string; usedFor: string }[] = [
  {
    mode: 'API key',
    credential: 'Authorization: Bearer sk_test_… / sk_live_…',
    scope: 'Exactly one project and one environment. No organization-management authority.',
    usedFor: 'Programmatic access from your integration.',
  },
  {
    mode: 'Session',
    credential: 'Authorization: Bearer <your-access-token> (JWT)',
    scope: "The user's organization memberships, subject to role permissions.",
    usedFor: 'The dashboard and user endpoints.',
  },
];

const AREA_ROWS: { area: string; modes: string }[] = [
  { area: 'auth/*, organizations/*, projects/*, api-keys/*, logs/*', modes: 'Session only' },
  { area: 'customers/*, payments/*, refunds/*, webhook-*', modes: 'API key or session' },
];

const FAILURE_ROWS: { status: string; code: string; meaning: string }[] = [
  {
    status: '401',
    code: 'UNAUTHENTICATED',
    meaning:
      'No credential, an unknown or revoked API key, or an expired/invalid session. Fix the credential before retrying.',
  },
  {
    status: '403',
    code: 'FORBIDDEN',
    meaning:
      'The credential is valid but its role or scope does not allow this action. Retrying unchanged will not help.',
  },
  {
    status: '404',
    code: 'NOT_FOUND',
    meaning:
      'The resource is not visible to this credential — including resources of another project or environment. Existence is never disclosed.',
  },
];

/**
 * Authentication guide (phase 15 §5.3): the two credential modes and the
 * fact that they are not equivalent, the route areas each one covers, how
 * each is obtained, and the failure modes a client must handle.
 */
export default function AuthenticationPage() {
  return (
    <Guide
      title="Authentication"
      lead="BrinnPay has two authentication modes. They are documented and enforced separately, and they are not interchangeable: one identifies a project environment, the other identifies a user inside an organization."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="auth-modes">
        <h2 id="auth-modes">The two modes</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Mode</th>
                <th scope="col">Credential</th>
                <th scope="col">Scope</th>
                <th scope="col">Used for</th>
              </tr>
            </thead>
            <tbody>
              {MODE_ROWS.map((row) => (
                <tr key={row.mode}>
                  <th scope="row">{row.mode}</th>
                  <td>
                    <code>{row.credential}</code>
                  </td>
                  <td>{row.scope}</td>
                  <td>{row.usedFor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          An API key is <strong>not</strong> a session and a session is <strong>not</strong> an
          API key: a key never carries organization-management authority (it cannot create
          projects, invite members or manage keys), and a session never acts outside the
          organizations its user belongs to.
        </p>
        <p>
          Each operation in the{' '}
          <Link href="/docs/api-reference">API reference</Link> lists the security it requires,
          so you never have to guess which credential a call needs.
        </p>
      </section>

      <section aria-labelledby="auth-areas">
        <h2 id="auth-areas">Which routes accept which mode</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Route area</th>
                <th scope="col">Accepted mode(s)</th>
              </tr>
            </thead>
            <tbody>
              {AREA_ROWS.map((row) => (
                <tr key={row.area}>
                  <th scope="row">
                    <code>{row.area}</code>
                  </th>
                  <td>{row.modes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The two modes also differ in how the <strong>environment</strong> is selected. With an
          API key the environment comes from the key, so a payload that names a different
          environment is rejected with <code>422</code>. With a session the environment must be
          stated explicitly — an <code>environment</code> field or an{' '}
          <code>environment</code> query filter.
        </p>
      </section>

      <section aria-labelledby="auth-api-key">
        <h2 id="auth-api-key">API keys</h2>
        <p>
          Keys are created in the dashboard, per project and per environment, and are shown
          exactly once at creation — only a hash is stored, so a lost key is rotated rather
          than recovered. Send the key on every request:
        </p>
        <CodeExampleList examples={[AUTHENTICATED_REQUEST]} />
        <p>
          <Link href="/docs/api-keys">API keys: format, rotation, revocation and leak response →</Link>
        </p>
      </section>

      <section aria-labelledby="auth-session">
        <h2 id="auth-session">Sessions</h2>
        <p>
          A session starts with <code>POST /auth/register</code> or <code>POST /auth/login</code>.
          The response carries a short-lived access token; the refresh session is set as an{' '}
          <code>HttpOnly</code> cookie and is <strong>never</strong> returned in the JSON body:
        </p>
        <CodeExampleList examples={[REGISTER_ACCOUNT, LOGIN_ACCOUNT]} />
        <p>
          While the session lives, <code>POST /auth/refresh</code> exchanges the cookie for a new
          access token. The refresh cookie is single-use: it is rotated on every refresh, and
          presenting a rotated cookie again fails the request and revokes the session:
        </p>
        <CodeExampleList examples={[REFRESH_SESSION]} />
        <p className="hint">
          <code>POST /auth/logout</code> revokes the session and clears the cookie; it is
          idempotent and needs only the cookie, not an access token.
        </p>
        <p>
          <Link href="/docs/environments">Declaring the environment with a session →</Link>
        </p>
      </section>

      <section aria-labelledby="auth-failures">
        <h2 id="auth-failures">What each failure looks like</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Code</th>
                <th scope="col">What it means</th>
              </tr>
            </thead>
            <tbody>
              {FAILURE_ROWS.map((row) => (
                <tr key={row.status}>
                  <th scope="row">
                    <code>{row.status}</code>
                  </th>
                  <td>
                    <code>{row.code}</code>
                  </td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Callout title="Tenant isolation" tone="important">
          <p>
            A resource that belongs to another project, environment or organization is reported
            as <code>404 NOT_FOUND</code>. Do not build logic on distinguishing “does not
            exist” from “is not yours”: the API never makes that distinction.
          </p>
        </Callout>
        <p>Every error, including these, uses the same envelope:</p>
        <CodeBlock {...ERROR_ENVELOPE_EXAMPLE} />
        <p>
          <Link href="/docs/errors">Error handling in detail →</Link>
        </p>
      </section>
    </Guide>
  );
}
