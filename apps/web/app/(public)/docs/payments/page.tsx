import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  CREATE_PAYMENT_CURL,
  CREATE_PAYMENT_JS,
  CREATE_PAYMENT_PY,
  LIST_PAYMENTS,
  PAYMENT_RESPONSE_EXAMPLE,
  RETRIEVE_PAYMENT,
} from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Payments — BrinnPay',
  description:
    'Create, retrieve and list simulated BrinnPay payments: required fields, money format, the pending → processing → succeeded simulation, idempotency and authorization.',
};

const CREATE_FIELDS: { field: string; required: string; note: string }[] = [
  { field: 'environment', required: 'yes', note: 'test or live; must match the key if you use one.' },
  { field: 'customer_id', required: 'yes', note: 'A customer of this project (and environment).' },
  { field: 'amount', required: 'yes', note: 'Decimal string, e.g. "10.00". Strictly positive.' },
  { field: 'currency', required: 'yes', note: 'usd — the only currency in the MVP.' },
  { field: 'description', required: 'no', note: 'Your own note, returned on the payment.' },
];

/** Resource paths, exactly as the contract declares them. */
const CUSTOMERS_PATH = '/projects/{project_id}/customers';
const CREATE_PAYMENT_PATH = '/projects/{project_id}/payments';
const LIST_PAYMENTS_PATH = '/projects/{project_id}/payments';
const RETRIEVE_PAYMENT_PATH = '/projects/{project_id}/payments/{payment_id}';

/**
 * Payments guide (phase 15 §5.6): create/retrieve/list with cursor
 * pagination, the required create body and money format, the simulated state
 * machine, environment scoping, idempotency and the roles that may create a
 * payment.
 */
export default function PaymentsPage() {
  return (
    <Guide
      title="Payments"
      lead="Payments are simulated end to end: create one, watch it advance from pending to succeeded, list it with cursor pagination, and refund it afterwards."
      sources={['docs/openapi.yaml', 'docs/api-conventions.md']}
    >
      <Callout title="Simulated payments" tone="warning">
        <p>
          BrinnPay processes no real money and collects no card data. A payment here is a
          record in a simulated payment system with the shapes and statuses a real integration
          would use.
        </p>
      </Callout>

      <section aria-labelledby="payments-before">
        <h2 id="payments-before">Before you create a payment</h2>
        <p>
          A payment needs an existing <strong>customer</strong> of the same project (and, when
          you use an API key, the same environment). Create one first if you have not:
        </p>
        <ul>
          <li>
            <code>{CUSTOMERS_PATH}</code> — required:{' '}
            <code>environment</code>, <code>email</code>.
          </li>
        </ul>
        <p>Money follows two conventions everywhere in the API:</p>
        <ul>
          <li>
            <strong>Amounts are decimal strings</strong>, not numbers: <code>&quot;10.00&quot;</code>.
            Zero and negative values are rejected.
          </li>
          <li>
            <strong>Currency is lowercase</strong> and must be <code>usd</code> — USD is the
            only currency in the MVP, and the field exists for forward compatibility.
          </li>
        </ul>
        <p>
          <Link href="/docs/environments">Environments →</Link>
        </p>
      </section>

      <section aria-labelledby="payments-create">
        <h2 id="payments-create">Create a payment</h2>
        <p>
          <code>{CREATE_PAYMENT_PATH}</code> with{' '}
          <code>Idempotency-Key</code> on the header (recommended for every create):
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Body field</th>
                <th scope="col">Required</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {CREATE_FIELDS.map((row) => (
                <tr key={row.field}>
                  <th scope="row">
                    <code>{row.field}</code>
                  </th>
                  <td>{row.required}</td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CodeExampleList
          examples={[CREATE_PAYMENT_CURL, CREATE_PAYMENT_JS, CREATE_PAYMENT_PY]}
        />
        <p>The response is the payment itself:</p>
        <CodeExampleList examples={[PAYMENT_RESPONSE_EXAMPLE]} />
        <p>
          <strong>Expected:</strong> <code>201</code> and <code>status: &quot;pending&quot;</code>.
          Retrying the same call with the same <code>Idempotency-Key</code> replays this stored
          response instead of creating a second payment.{' '}
          <Link href="/docs/idempotency">Idempotency →</Link>
        </p>
      </section>

      <section aria-labelledby="payments-read">
        <h2 id="payments-read">Retrieve and list</h2>
        <p>
          <code>{RETRIEVE_PAYMENT_PATH}</code> returns one payment;{' '}
          <code>{LIST_PAYMENTS_PATH}</code> lists the
          environment&rsquo;s payments with cursor pagination:
        </p>
        <CodeExampleList examples={[LIST_PAYMENTS]} />
        <p>
          Pagination is cursor-based: <code>limit</code> (1–100, default 20) and an opaque{' '}
          <code>cursor</code> taken from the previous response&rsquo;s <code>next_cursor</code>,
          with <code>has_more</code> telling you whether another page exists. Cursors are
          opaque strings — do not decode them or reuse them for a different list.
        </p>
        <CodeExampleList examples={[RETRIEVE_PAYMENT]} />
        <p className="hint">
          Listing can advance payments for you: a <code>pending</code> or{' '}
          <code>processing</code> payment whose simulated schedule has elapsed is advanced when
          it is read, so a page may already show the terminal state.
        </p>
      </section>

      <section aria-labelledby="payments-state-machine">
        <h2 id="payments-state-machine">The simulated state machine</h2>
        <ul className="docs-stat-list">
          <li className="docs-stat">
            <strong>pending</strong>
            <span>Created, waiting for the simulation.</span>
          </li>
          <li className="docs-stat">
            <strong>processing</strong>
            <span>Mid-flight; still moving.</span>
          </li>
          <li className="docs-stat">
            <strong>succeeded</strong>
            <span>Terminal — the default outcome.</span>
          </li>
          <li className="docs-stat">
            <strong>failed</strong>
            <span>Terminal — defined, not triggered today.</span>
          </li>
        </ul>
        <p>
          The simulation advances <code>pending → processing</code> and then{' '}
          <code>processing → succeeded</code>. Progression is derived from the payment&rsquo;s
          creation time rather than from an in-memory timer, so it survives restarts and is
          reproducible. Terminal states are absorbing: a payment never leaves{' '}
          <code>succeeded</code> or <code>failed</code>.
        </p>
        <Callout title="Current behavior" tone="note">
          <p>
            Every simulated payment follows the default-success path today. The{' '}
            <code>failed</code> status and its transition exist in the model, but{' '}
            <strong>no public trigger for failure is exposed in this version</strong>: there is
            no decline, timeout or failure switch to flip. Failure scenarios are planned work,
            not current behavior.
          </p>
        </Callout>
        <p>
          Observe the progression by polling — the dashboard payments page does exactly this
          while a payment is still moving:
        </p>
        <CodeExampleList examples={[RETRIEVE_PAYMENT]} />
        <p>
          <Link href="/docs/sandbox">What the sandbox simulates →</Link>
        </p>
      </section>

      <section aria-labelledby="payments-authorization">
        <h2 id="payments-authorization">Authorization and environment scoping</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Caller</th>
                <th scope="col">Reading payments</th>
                <th scope="col">Creating payments</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Session (any role)</th>
                <td>Allowed for every role, including viewer.</td>
                <td>
                  <strong>owner</strong> and <strong>admin</strong> only; member and viewer get{' '}
                  <code>403</code>.
                </td>
              </tr>
              <tr>
                <th scope="row">API key</th>
                <td colSpan={2}>
                  Allowed within the key&rsquo;s project and environment only — roles are not
                  evaluated in API-key mode; the key <em>is</em> the scope.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The environment is derived from the key in API-key mode, and must be stated
          explicitly in session mode. A customer from the other environment, or from another
          project, is reported as <code>404</code> — existence is never disclosed.
        </p>
        <p>
          <Link href="/docs/errors">Error handling →</Link> ·{' '}
          <Link href="/docs/refunds">Refunds →</Link>
        </p>
      </section>
    </Guide>
  );
}
