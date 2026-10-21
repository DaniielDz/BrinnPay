import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  CREATE_REFUND_CURL,
  CREATE_REFUND_FULL,
  CREATE_REFUND_JS,
  CREATE_REFUND_PY,
} from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Refunds — BrinnPay',
  description:
    'Create full and partial refunds against a succeeded BrinnPay payment: synchronous completion, remaining-balance rules, idempotency and authorization.',
};

const REFUND_PATH = '/payments/{payment_id}/refunds';

/** Refunds guide (phase 15 §5.7): refunds against a succeeded payment. */
export default function RefundsPage() {
  return (
    <Guide
      title="Refunds"
      lead="A refund returns money from a succeeded payment. Full and partial refunds share one endpoint, complete synchronously, and never alter the payment they came from."
      sources={['docs/openapi.yaml', 'docs/api-conventions.md']}
    >
      <Callout title="Simulated refunds" tone="warning">
        <p>
          Refunds move simulated money only. BrinnPay processes no real money in any
          environment.
        </p>
      </Callout>

      <section aria-labelledby="refunds-basics">
        <h2 id="refunds-basics">How a refund behaves</h2>
        <ul>
          <li>
            A refund is created <strong>against a succeeded payment</strong>. Pending,
            processing or failed payments are not refundable.
          </li>
          <li>
            Refunds <strong>complete synchronously</strong>: the create call answers{' '}
            <code>201</code> with <code>status: &quot;succeeded&quot;</code>. There is no
            pending-refund lifecycle to poll.
          </li>
          <li>
            The payment&rsquo;s own status <strong>does not change</strong>: a refunded payment
            stays <code>succeeded</code>.
          </li>
          <li>
            Refunds are nested under their payment — <code>{REFUND_PATH}</code> — so listing
            always returns one payment&rsquo;s refunds.
          </li>
        </ul>
      </section>

      <section aria-labelledby="refunds-amount">
        <h2 id="refunds-amount">Full and partial refunds</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <code>amount</code> omitted
                </th>
                <td>
                  The <strong>full remaining balance</strong> is refunded — including whatever
                  is left after earlier partial refunds.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <code>amount</code> present
                </th>
                <td>
                  A partial refund. The value must be a positive decimal string that does not
                  exceed the remaining balance.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeExampleList examples={[CREATE_REFUND_CURL, CREATE_REFUND_FULL]} />
        <p className="hint">
          <code>currency</code> defaults to <code>usd</code> when omitted (USD is the only
          currency in the MVP). <code>reason</code> is optional, trimmed, nonempty after
          trimming, and at most 255 characters — omit it rather than passing an empty value.
        </p>
      </section>

      <section aria-labelledby="refunds-errors">
        <h2 id="refunds-errors">When a refund is rejected</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Situation</th>
                <th scope="col">Response</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Amount exceeds what remains, the balance is exhausted, or the payment is not
                  refundable.
                </td>
                <td>
                  <code>422 BUSINESS_RULE_VIOLATION</code>
                </td>
              </tr>
              <tr>
                <td>
                  The same <code>Idempotency-Key</code> was already used against a{' '}
                  <em>different</em> payment.
                </td>
                <td>
                  <code>409 CONFLICT</code> — a generic conflict that reveals nothing about the
                  other refund.
                </td>
              </tr>
              <tr>
                <td>The payment does not exist in your scope.</td>
                <td>
                  <code>404 NOT_FOUND</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          The contract documents <code>PAYMENT_ALREADY_REFUNDED</code> as the representative
          domain code for an already-refunded payment. Domain codes are stable strings, so
          match on <code>error.code</code> rather than on the message text — and retry only
          after changing the request.
        </p>
        <p>
          <Link href="/docs/errors">Error handling →</Link>
        </p>
      </section>

      <section aria-labelledby="refunds-idempotency">
        <h2 id="refunds-idempotency">Retrying a refund safely</h2>
        <p>
          Send an <code>Idempotency-Key</code> header on the create. Its operation scope is{' '}
          <code>refunds.create</code>, kept separate from <code>payments.create</code>, and the
          first successful response is stored for <strong>24 hours</strong>: any retry with the
          same key replays that stored <code>201</code> without creating a second refund.
        </p>
        <CodeExampleList examples={[CREATE_REFUND_JS, CREATE_REFUND_PY]} />
        <p>
          If the key was already used against another payment, the answer is the generic{' '}
          <code>409</code> above rather than a replay — a key never bridges two refund targets.{' '}
          <Link href="/docs/idempotency">Idempotency in detail →</Link>
        </p>
      </section>

      <section aria-labelledby="refunds-authorization">
        <h2 id="refunds-authorization">Reading and creating</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Caller</th>
                <th scope="col">Reading refunds</th>
                <th scope="col">Creating refunds</th>
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
                  Scoped to the key&rsquo;s project and environment; roles are not evaluated in
                  API-key mode.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          List a payment&rsquo;s refunds with the same cursor pagination as every other list:{' '}
          <code>limit</code>, <code>cursor</code>, <code>next_cursor</code>,{' '}
          <code>has_more</code>. Retrieve one refund by id from the same nested path.
        </p>
        <p>
          <Link href="/docs/payments">Payments →</Link> ·{' '}
          <Link href="/docs/api-reference">API reference →</Link>
        </p>
      </section>
    </Guide>
  );
}
