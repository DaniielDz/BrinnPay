import type { Metadata } from 'next';
import Link from 'next/link';

import { Guide } from '../../../../components/docs/guide';
import { REQUEST_LOG_RETENTION_DAYS } from '../../../../lib/docs/facts';

export const metadata: Metadata = {
  title: 'Logs — BrinnPay',
  description:
    'Request ids, request logs and the append-only audit trail: what is recorded, what is never recorded, how long it is kept, and how to report an issue.',
};

const REQUEST_LOG_FIELDS: { field: string; note: string }[] = [
  { field: 'request_id', note: 'Always present — the same value as the X-Request-Id header.' },
  { field: 'method / path', note: 'The path only: query strings are never persisted.' },
  { field: 'status_code / duration_ms', note: 'Outcome and timing of the request.' },
  {
    field: 'project / organization / user / api_key',
    note: 'Optional scope — present when the request belonged to one.',
  },
  { field: 'environment', note: 'test or live when the request carried one, otherwise null.' },
  { field: 'created_at', note: 'UTC timestamp, ascending order in listings.' },
];

/** Logs guide (phase 15 §5.11, Q2): request ids, request logs, audit logs. */
export default function LogsPage() {
  return (
    <Guide
      title="Logs"
      lead="Two record types answer the two questions you will actually have: what happened to this request, and who did what."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="logs-request-ids">
        <h2 id="logs-request-ids">Request ids</h2>
        <p>
          Every request is assigned a <code>req_…</code> identifier at ingress, before any
          handler runs. It travels with the request everywhere it can be useful:
        </p>
        <ul>
          <li>
            The <code>X-Request-Id</code> header on <strong>every</strong> response.
          </li>
          <li>
            <code>error.request_id</code> inside every error envelope.
          </li>
          <li>The request log entry for that request.</li>
          <li>Outbound webhook delivery records, so a delivery points back at its cause.</li>
        </ul>
        <p>
          Copy it into your own logs before you report a problem: quoting the request id is what
          lets someone find the exact call, without you pasting payloads or credentials.{' '}
          <Link href="/docs/errors">Error handling →</Link>
        </p>
      </section>

      <section aria-labelledby="logs-request-logs">
        <h2 id="logs-request-logs">Request logs</h2>
        <p>
          A structured record of an API request and its response. It is an API-wide capability:
          public, session-authenticated and key-authenticated requests are all representable,
          so the scope columns are optional.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {REQUEST_LOG_FIELDS.map((row) => (
                <tr key={row.field}>
                  <th scope="row">
                    <code>{row.field}</code>
                  </th>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Query strings, request headers and request or response bodies are{' '}
          <strong>never</strong> persisted — the record is metadata, so it cannot become a copy
          of your data.
        </p>
        <p>
          <strong>Retention:</strong> request logs are kept for{' '}
          <strong>{REQUEST_LOG_RETENTION_DAYS} days</strong> by default and are then removed.
        </p>
        <p>
          <strong>Where:</strong> the API exposes them per project —{' '}
          <code>GET /projects/{'{'}project_id{'}'}/logs/requests</code> — with cursor
          pagination, an optional exact <code>request_id</code> lookup, and an optional{' '}
          <code>environment</code> filter. The endpoint is <strong>session-only</strong>: an
          API key gets <code>401</code>, and any organization role can read them (they are
          metadata, not data).
        </p>
        <p className="hint">
          The dashboard shows the same list on a project&rsquo;s{' '}
          <strong>Request logs</strong> page, filtered by the selected environment.
        </p>
      </section>

      <section aria-labelledby="logs-audit">
        <h2 id="logs-audit">Audit logs</h2>
        <p>
          The audit trail records security- and business-relevant events for an organization:
          registrations and sign-ins, membership and invitation changes, key creation and
          revocation, customer changes, and payment and refund activity.
        </p>
        <ul>
          <li>
            <strong>Append-only.</strong> Entries are never updated and never deleted. The only
            deletion path is the cascade that removes an organization together with its
            entries.
          </li>
          <li>
            <strong>Organization-wide.</strong> Every entry belongs to exactly one organization;
            there is no platform-global entry.
          </li>
          <li>
            <strong>Closed catalogs.</strong> An entry carries an action identifier such as{' '}
            <code>user.logged_in</code> or <code>payment.created</code> and a resource type,
            both from closed catalogs — so entries stay machine-readable and comparable.
          </li>
          <li>
            <strong>Session-only.</strong> Reading the trail requires a session; an API key gets{' '}
            <code>401</code>.
          </li>
        </ul>
        <p>
          <strong>Where:</strong> <code>GET /organizations/{'{'}organization_id{'}'}/logs/audit</code>,
          with cursor pagination; the dashboard shows it on a project&rsquo;s{' '}
          <strong>Audit logs</strong> page.
        </p>
        <p className="hint">
          Audit entries record that an action happened and which resource it touched — they are
          not a copy of the data itself.
        </p>
      </section>

      <section aria-labelledby="logs-reporting">
        <h2 id="logs-reporting">Reporting an issue</h2>
        <ol>
          <li>Capture the <code>X-Request-Id</code> from the failed response.</li>
          <li>Find it in your own logs and in the request log entry.</li>
          <li>
            Quote the request id — plus the operation and approximate time — when reporting.
            Do not paste credentials, signing secrets or full payloads.
          </li>
        </ol>
        <p>
          <Link href="/docs/errors">Error handling →</Link> ·{' '}
          <Link href="/docs/authentication">Authentication →</Link>
        </p>
      </section>
    </Guide>
  );
}
