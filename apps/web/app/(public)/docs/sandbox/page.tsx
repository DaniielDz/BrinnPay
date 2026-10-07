import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  CREATE_PAYMENT_DECLINE_CURL,
  CREATE_PAYMENT_TIMEOUT_CURL,
  REGISTER_WEBHOOK_MARKER_CURL,
  RETRIEVE_PAYMENT,
} from '../../../../lib/docs/examples';
import { PAYMENT_FAILURE_CODES, PAYMENT_SCENARIOS, WEBHOOK_SIMULATION_ACTIONS } from '../../../../lib/docs/facts';

export const metadata: Metadata = {
  title: 'Sandbox — BrinnPay',
  description:
    'What the BrinnPay sandbox simulates: no real money and no real card data, the payment scenario catalog (success, decline, timeout), webhook destination markers, and exactly which behaviors exist today.',
};

/** Sandbox guide (phase 15 §5.12 D6, extended by phase 16 §6.2 D9). */
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
                <td>
                  Create, retrieve and list; the pending → processing → succeeded progression,
                  plus an opt-in <code>scenario</code> that produces a decline or a timeout.
                </td>
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
                  receivers on localhost — and sandbox destination markers that force failures.
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
        <h2 id="sandbox-success">The default scenario: success</h2>
        <p>
          Omit <code>scenario</code> — or send <code>scenario: &quot;succeed&quot;</code> — and
          the payment follows <code>pending → processing → succeeded</code>. Progression is
          derived from the payment&rsquo;s creation time rather than from an in-memory timer, so
          it is reproducible and survives restarts.
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

      <section aria-labelledby="sandbox-scenarios">
        <h2 id="sandbox-scenarios">Failure scenarios</h2>
        <p>
          Passing <code>scenario</code> on payment creation selects an outcome from a closed
          catalog of{' '}
          {PAYMENT_SCENARIOS.map((scenario, index) => (
            <span key={scenario}>
              {index > 0 ? (index === PAYMENT_SCENARIOS.length - 1 ? ' or ' : ', ') : null}
              <code>{scenario}</code>
            </span>
          ))}
          . The outcome is <strong>not disclosed in the create response</strong> — it arrives
          the same way it would in production, by observing the payment and the webhook events
          it emits.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <code>scenario</code>
                </th>
                <th scope="col">What the sandbox does</th>
                <th scope="col">Final status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <code>succeed</code>
                </th>
                <td>
                  The default. Omitting <code>scenario</code> behaves exactly like this value.
                </td>
                <td>
                  <code>succeeded</code>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <code>decline</code>
                </th>
                <td>
                  Settles <code>failed</code> at the processing edge and emits{' '}
                  <code>payment.failed</code> with the chosen <code>failure_code</code>.
                </td>
                <td>
                  <code>failed</code>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <code>timeout</code>
                </th>
                <td>
                  Moves <code>pending → processing</code> and stops there: no terminal event is
                  ever emitted, and a refund answers <code>422</code>.
                </td>
                <td>
                  <code>processing</code> (never settles)
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          A timed-out payment never completes: <code>retrieve</code> and{' '}
          <code>list</code> keep returning <code>processing</code>,{' '}
          <code>failure_code</code> stays <code>null</code>, and no terminal event is ever
          emitted. Treat a prolonged non-terminal state as <strong>not yet resolved</strong> —
          keep polling or wait for the webhook rather than assuming the payment failed.
        </p>
        <p>
          A decline additionally selects <code>failure_code</code> — valid{' '}
          <strong>only</strong> with <code>scenario: &quot;decline&quot;</code> — from the closed
          catalog:
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <code>failure_code</code>
                </th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <code>{PAYMENT_FAILURE_CODES[0]}</code> (default)
                </th>
                <td>The simulated authorization was declined.</td>
              </tr>
              <tr>
                <th scope="row">
                  <code>{PAYMENT_FAILURE_CODES[1]}</code>
                </th>
                <td>The simulated funding source had insufficient funds.</td>
              </tr>
              <tr>
                <th scope="row">
                  <code>{PAYMENT_FAILURE_CODES[2]}</code>
                </th>
                <td>
                  The simulated authorization attempt timed out and the payment failed. This is
                  a <em>decline</em> code — it is unrelated to the separate{' '}
                  <code>timeout</code> scenario, which never settles at all.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>A minimal correct request for each non-default outcome:</p>
        <CodeExampleList
          examples={[CREATE_PAYMENT_DECLINE_CURL, CREATE_PAYMENT_TIMEOUT_CURL]}
        />
        <Callout title="Validation happens before anything is committed" tone="note">
          <p>
            An unknown <code>scenario</code> or <code>failure_code</code>, a{' '}
            <code>failure_code</code> sent without <code>scenario: &quot;decline&quot;</code>,
            or an explicit <code>null</code> are <code>400 VALIDATION_ERROR</code>s. The
            rejection happens before the idempotency key is claimed, so the same{' '}
            <code>Idempotency-Key</code> stays usable after you fix the request.
          </p>
        </Callout>
        <p>
          <Link href="/docs/payments">Payments →</Link>
        </p>
      </section>

      <section aria-labelledby="sandbox-webhook-marker">
        <h2 id="sandbox-webhook-marker">Webhook destination markers</h2>
        <p>
          A webhook endpoint URL whose path contains the exact consecutive segments{' '}
          <code>sandbox/&lt;action&gt;</code> is classified as a simulated destination — nothing
          special happens at registration, only when a delivery is attempted.{' '}
          <code>action</code> is one of{' '}
          {WEBHOOK_SIMULATION_ACTIONS.map((action, index) => (
            <span key={action}>
              {index > 0
                ? index === WEBHOOK_SIMULATION_ACTIONS.length - 1
                  ? ' or '
                  : ', '
                : null}
              <code>{action}</code>
            </span>
          ))}
          .
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <code>sandbox/&lt;action&gt;</code>
                </th>
                <th scope="col">How the attempt is classified</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <code>sandbox/fail</code>
                </th>
                <td>
                  A retryable failure (<code>500</code>-class): the delivery is retried inside
                  the usual 5-attempt ladder, then ends <code>failed</code>.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <code>sandbox/timeout</code>
                </th>
                <td>
                  A retryable timeout — same ladder, no response status recorded.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <code>sandbox/reject</code>
                </th>
                <td>
                  A terminal failure (<code>4xx</code>-class): the delivery fails immediately
                  and is never retried.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeExampleList examples={[REGISTER_WEBHOOK_MARKER_CURL]} />
        <p className="hint">
          The match is on whole path segments, so <code>/sandbox/webhooks</code> (a{' '}
          <code>sandbox</code> segment without an action) and <code>/failure-handler</code> are
          ordinary destinations. The marker replaces the HTTP attempt only: it never bypasses
          endpoint <code>enabled</code> gating, subscriptions, retention, rate limits or the
          destination policy. No outbound request is made, so no{' '}
          <code>BrinnPay-Signature</code> is sent — signing stays “HMAC over exactly the bytes
          sent”. Everything else — attempt counting, classification, backoff and replay — runs
          through the same bookkeeping as a real attempt.
        </p>
        <p>
          <Link href="/docs/webhooks">Webhooks →</Link>
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
            <strong>No test cards or card data.</strong> There is no card field anywhere: the
            scenario catalog is the only input that changes an outcome.
          </li>
          <li>
            <strong>No chargebacks, disputes or issuer rules.</strong> They are outside the
            modeled surface.
          </li>
          <li>
            <strong>No mid-flight forcing.</strong> A scenario is fixed at creation; you cannot
            move an already-created payment between outcomes, and terminal states remain
            absorbing.
          </li>
          <li>
            <strong>No project-wide default scenario.</strong> <code>scenario</code> is
            per-request only — there is no setting that changes the outcome of unflagged
            payments.
          </li>
          <li>
            <strong>No forced rate limits or arbitrary error injection.</strong> 429s come from
            the published operation budgets; there is no switch that fabricates a specific
            HTTP error for an endpoint.
          </li>
          <li>
            <strong>No refund or dispute scenarios.</strong> Refunds complete synchronously
            against a succeeded payment; nothing makes a refund fail or time out.
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
