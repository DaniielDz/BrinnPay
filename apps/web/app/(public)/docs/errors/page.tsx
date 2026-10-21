import type { Metadata } from 'next';
import Link from 'next/link';

import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  ERROR_DEMO_CURL,
  ERROR_ENVELOPE_EXAMPLE,
  VALIDATION_ERROR_EXAMPLE,
} from '../../../../lib/docs/examples';
import { BASE_ERROR_CODES } from '../../../../lib/docs/facts';

export const metadata: Metadata = {
  title: 'Error handling — BrinnPay',
  description:
    'The BrinnPay error envelope, the stable base error codes, the status-code table, and exactly which responses are safe to retry.',
};

const STATUS_ROWS: {
  status: string;
  meaning: string;
  retry: string;
}[] = [
  { status: '400', meaning: 'Validation failure — the request itself is wrong.', retry: 'No. Fix the request.' },
  {
    status: '401',
    meaning: 'Missing, unknown or revoked credential; expired or invalid session.',
    retry: 'No. Fix the credential.',
  },
  {
    status: '403',
    meaning: 'Valid credential without the required permission or scope.',
    retry: 'No. The action is not allowed for this caller.',
  },
  {
    status: '404',
    meaning: 'Not visible to this credential — including other tenants’ resources.',
    retry: 'No.',
  },
  {
    status: '409',
    meaning: 'Conflict — the request collides with current state.',
    retry: 'No. Re-read state, then decide.',
  },
  {
    status: '422',
    meaning: 'Well-formed and authenticated, but a business rule rejects it.',
    retry: 'No. The rule will not change on its own.',
  },
  {
    status: '429',
    meaning: 'Rate limited. Nothing ran and nothing changed.',
    retry: 'Yes — after Retry-After (or RateLimit-Reset) seconds.',
  },
  {
    status: '5xx',
    meaning: 'Transient server failure.',
    retry: 'Yes, with backoff — and only if the operation is safe to repeat.',
  },
];

/** Error handling guide (phase 15 §5.10). */
export default function ErrorsPage() {
  return (
    <Guide
      title="Error handling"
      lead="Every failing response has the same shape, a stable machine-readable code, and the request id you need to report it."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="errors-envelope">
        <h2 id="errors-envelope">The envelope</h2>
        <CodeExampleList examples={[ERROR_ENVELOPE_EXAMPLE]} />
        <ul>
          <li>
            <code>error.code</code> — a stable, machine-readable string. Branch on this, never
            on the message.
          </li>
          <li>
            <code>error.message</code> — human-readable text; safe to show to a developer, not
            a contract.
          </li>
          <li>
            <code>error.request_id</code> — the same value as the <code>X-Request-Id</code>{' '}
            header of this response.
          </li>
          <li>
            <code>error.details</code> — optional structured context (validation field errors,
            rate-limit budget numbers). Present only when it adds something.
          </li>
        </ul>
        <CodeExampleList examples={[ERROR_DEMO_CURL]} />
      </section>

      <section aria-labelledby="errors-codes">
        <h2 id="errors-codes">Codes</h2>
        <p>The base codes are shared infrastructure and appear across the API:</p>
        <ul>
          {BASE_ERROR_CODES.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <p>
          Feature areas add their own domain codes alongside them — for example{' '}
          <code>PAYMENT_ALREADY_REFUNDED</code>, the representative domain code the contract
          documents for an already-refunded payment. Domain codes stay stable strings, but only
          the base codes are guaranteed to appear on every endpoint.
        </p>
        <p>
          <Link href="/docs/refunds">How refunds report business rules →</Link>
        </p>
      </section>

      <section aria-labelledby="errors-statuses">
        <h2 id="errors-statuses">Status codes and what to do</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Meaning</th>
                <th scope="col">Client action</th>
              </tr>
            </thead>
            <tbody>
              {STATUS_ROWS.map((row) => (
                <tr key={row.status}>
                  <th scope="row">
                    <code>{row.status}</code>
                  </th>
                  <td>{row.meaning}</td>
                  <td>{row.retry}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Retry rule:</strong> retry <strong>only</strong> <code>429</code> and transient <code>5xx</code> — with{' '}
          <code>Retry-After</code> when it is present — and only when the operation is safe to
          repeat (or carries an <code>Idempotency-Key</code>). Never blindly retry a{' '}
          <code>4xx</code>: the request will fail the same way.{' '}
          <Link href="/docs/idempotency">Idempotency →</Link>
        </p>
      </section>

      <section aria-labelledby="errors-request-id">
        <h2 id="errors-request-id">Request ids</h2>
        <p>
          Every response carries <code>X-Request-Id</code>, and every error repeats it in{' '}
          <code>error.request_id</code>. Keep it when a call fails: it is what ties your log
          line to the API&rsquo;s own request log, and it is the fastest way to get an answer
          about a specific call.
        </p>
        <p className="hint">
          Request ids follow the <code>req_…</code> scheme and are safe to log — they contain no
          credential or tenant data.
        </p>
        <p>
          <Link href="/docs/logs">Request logs →</Link>
        </p>
      </section>

      <section aria-labelledby="errors-validation">
        <h2 id="errors-validation">Validation details</h2>
        <CodeExampleList examples={[VALIDATION_ERROR_EXAMPLE]} />
        <p className="hint">
          <code>details</code> is structured — for validation it names the offending fields —
          so a form can map errors back onto inputs without parsing sentences.
        </p>
      </section>

      <section aria-labelledby="errors-guarantees">
        <h2 id="errors-guarantees">What an error never contains</h2>
        <ul>
          <li>No stack traces, SQL, framework internals or file paths.</li>
          <li>No secrets, credentials, tokens or signing secrets.</li>
          <li>
            No information about whether a resource exists in another project, environment or
            organization — that is always a plain <code>404</code>.
          </li>
          <li>
            No identity, scope or internal name on a rate-limit response — only budget numbers.
          </li>
        </ul>
        <p>
          <Link href="/docs/rate-limits">Rate limits →</Link> ·{' '}
          <Link href="/docs/api-reference">API reference →</Link>
        </p>
      </section>
    </Guide>
  );
}
