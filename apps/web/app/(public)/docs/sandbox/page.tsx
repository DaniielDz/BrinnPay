import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import { RETRIEVE_PAYMENT } from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Sandbox — BrinnPay',
  description:
    'What the BrinnPay sandbox simulates: no real money and no real card data, the default-success payment simulation, and exactly which behaviors exist today.',
};

/** Sandbox guide (phase 15 §5.12, D6: implemented behavior only). */
export default function SandboxPage() {
  return (
    <Guide
      title="Sandbox"
      lead="BrinnPay is a sandbox: a simulated payment system with the interface a real integration would use, and none of the money."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="sandbox-meaning">
        <h2 id="sandbox-meaning">What “sandbox” means here</h2>
        <Callout title="No real money, no real card data" tone="warning">
          <p>
            BrinnPay processes no real money in any environment and collects no card data at
            all. There is no payment processor behind it — payments, refunds and their
            lifecycles are simulated inside the application.
          </p>
        </Callout>
        <ul>
          <li>
            Both environments are simulated. <code>live</code> is not “connected to production”;
            it is a second, separate simulated data set with identical behavior.
          </li>
          <li>
            The <strong>model surface is the same</strong> a real integration would use:
            identical resources, fields, statuses, errors, pagination, idempotency and
            webhooks. Code you write against the sandbox exercises the same paths a real
            integration would.
          </li>
          <li>
            Everything is deterministic and repeatable — the same request produces the same
            outcome, so tests stay stable.
          </li>
        </ul>
        <p>
          <Link href="/docs/environments">TEST and LIVE →</Link>
        </p>
      </section>

      <section aria-labelledby="sandbox-simulated">
        <h2 id="sandbox-simulated">What is simulated</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Simulated behavior available today</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Payments</th>
                <td>Create, retrieve and list; the pending → processing → succeeded progression.</td>
              </tr>
              <tr>
                <th scope="row">Refunds</th>
                <td>Full and partial refunds against a succeeded payment, completed synchronously.</td>
              </tr>
              <tr>
                <th scope="row">Idempotency</th>
                <td>Replay of stored responses for payment and refund creates, 24-hour window.</td>
              </tr>
              <tr>
                <th scope="row">Webhooks</th>
                <td>
                  Signed delivery, retries with backoff, replay, delivery inspection — including
                  receivers on localhost.
                </td>
              </tr>
              <tr>
                <th scope="row">Logs</th>
                <td>Request ids, request logs and the organization audit trail.</td>
              </tr>
              <tr>
                <th scope="row">Rate limiting</th>
                <td>The published operation-class budgets, response headers and retryable 429.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <Link href="/docs">All guides →</Link>
        </p>
      </section>

      <section aria-labelledby="sandbox-success">
        <h2 id="sandbox-success">The default-success simulation</h2>
        <p>
          Every payment follows the same path: <code>pending → processing → succeeded</code>.
          Progression is derived from the payment&rsquo;s creation time rather than from an
          in-memory timer, so it is reproducible and survives restarts.
        </p>
        <p>Observe it by polling — or watch it happen on the dashboard payments page:</p>
        <CodeExampleList examples={[RETRIEVE_PAYMENT]} />
        <p>
          Terminal states are absorbing: once a payment is <code>succeeded</code> it never
          moves again, which is what makes an assertion on the final status safe.
        </p>
        <p>
          <Link href="/docs/payments">Payments →</Link>
        </p>
      </section>

      <section aria-labelledby="sandbox-limits">
        <h2 id="sandbox-limits">What is not simulated today</h2>
        <Callout title="Only implemented behavior" tone="note">
          <p>
            This guide describes what exists now. In particular, the following are{' '}
            <strong>not</strong> available in this version — do not build against them:
          </p>
        </Callout>
        <ul>
          <li>
            <strong>No declines or failures.</strong> There is no way to make a payment fail:
            the <code>failed</code> status exists in the model, but nothing exposes a trigger
            for it, and <code>failure_code</code> is always <code>null</code>.
          </li>
          <li>
            <strong>No timeouts or slow paths.</strong> The simulation always advances on its
            schedule.
          </li>
          <li>
            <strong>No webhook failure scenarios.</strong> Deliveries are made to whatever your
            endpoint answers; there is no switch that produces destination errors — although a
            destination you control can answer any way you like, which is enough to exercise
            your own retry handling.
          </li>
          <li>
            <strong>No scenario triggers.</strong> There are no test cards, trigger phrases or
            special amounts that change an outcome.
          </li>
        </ul>
        <p className="hint">
          Failures in your integration are far more likely to come from your own code, an error
          response, or a rate limit — all of which you can exercise today.{' '}
          <Link href="/docs/errors">Error handling →</Link> ·{' '}
          <Link href="/docs/rate-limits">Rate limits →</Link>
        </p>
      </section>
    </Guide>
  );
}
