import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  CREATE_CUSTOMER,
  CREATE_PAYMENT_CURL,
  CREATE_PAYMENT_JS,
  CREATE_PAYMENT_PY,
  CREATE_PROJECT,
  LIST_DELIVERIES,
  REGISTER_ACCOUNT,
  REGISTER_WEBHOOK_ENDPOINT,
  RETRIEVE_PAYMENT,
  SHELL_SETUP,
} from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Quickstart — BrinnPay',
  description:
    'The BrinnPay quickstart: take a payment from a new account to a succeeded payment and a verified webhook delivery, using only the TEST environment.',
};

/**
 * Quickstart (phase 15 §5.2, D4): one sequential path through existing
 * behavior only — account → project → TEST key → customer → payment →
 * observed success → webhook endpoint and verified delivery. Every step names
 * where it happens, shows the exact action or call, states the expected
 * result and links to the full guide.
 */
export default function QuickstartPage() {
  return (
    <Guide
      title="Quickstart"
      lead="From an empty account to a succeeded payment and a verified webhook delivery. Eight steps, all against the TEST environment, all using behavior that exists today."
      sources={['docs/openapi.yaml', 'docs/api-conventions.md']}
    >
      <Callout title="Sandbox" tone="warning">
        <p>
          BrinnPay simulates payment infrastructure: it processes no real money and no real
          card data. Every example below uses placeholder values — replace them with yours.
        </p>
      </Callout>

      <section aria-labelledby="quickstart-account">
        <h2 id="quickstart-account">1. Create an account</h2>
        <p>
          <strong>Where:</strong> the dashboard, or the API.
        </p>
        <p>
          Open <Link href="/register">Get started</Link> and register. A default personal
          organization is created for you at the same time and you become its{' '}
          <strong>owner</strong> — there is no separate organization setup step. Registering
          also establishes your session, so the dashboard is immediately usable.
        </p>
        <p>The same action through the API:</p>
        <CodeExampleList examples={[REGISTER_ACCOUNT]} />
        <p>
          <strong>Expected:</strong> a <code>201</code> with your user profile, and an{' '}
          <code>HttpOnly</code> refresh cookie — the refresh token is never in the JSON body.{' '}
          <Link href="/docs/authentication">How authentication works →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-project">
        <h2 id="quickstart-project">2. Create a project</h2>
        <p>
          <strong>Where:</strong> the dashboard (Projects), or the API with your session.
        </p>
        <p>
          In the dashboard open <strong>Projects</strong> and use the{' '}
          <strong>Create project</strong> form. A project owns everything you will create
          next, and it supports both simulated environments from the start.
        </p>
        <p>The same action through the API (session authentication only):</p>
        <CodeExampleList examples={[CREATE_PROJECT]} />
        <p>
          <strong>Expected:</strong> a <code>201</code> with a project id. Keep it — it is the{' '}
          <code>project_id</code> in every call below.{' '}
          <Link href="/docs/environments">How environments work →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-key">
        <h2 id="quickstart-key">3. Create a TEST API key</h2>
        <p>
          <strong>Where:</strong> the dashboard (API keys).
        </p>
        <p>
          Open the project, then <strong>API keys</strong>. Choose the <code>test</code>{' '}
          environment and use <strong>Create key</strong>. The plaintext key (<code>sk_test_…</code>)
          is revealed once, with a copy button; store it now — only a hash is kept, so it can
          never be shown again.
        </p>
        <p>
          <strong>Expected:</strong> a key scoped to exactly this project and the{' '}
          <code>test</code> environment. It carries no organization authority.{' '}
          <Link href="/docs/api-keys">API keys in detail →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-shell">
        <h2 id="quickstart-shell">4. Configure your shell</h2>
        <p>
          Every cURL example in the documentation starts from these three values. Set them in
          the shell you will use for the next steps:
        </p>
        <CodeExampleList examples={[SHELL_SETUP]} />
        <p className="hint">
          <code>BRINNPAY</code> is your API origin plus <code>/api/v1</code>. For a local
          checkout that is <code>http://localhost:3000/api/v1</code>.{' '}
          <Link href="/docs/local-development">Local development →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-customer">
        <h2 id="quickstart-customer">5. Create a customer</h2>
        <p>
          <strong>Where:</strong> the API with your TEST key (the dashboard has the same form
          under <strong>Customers</strong>).
        </p>
        <p>A payment needs a customer first:</p>
        <CodeExampleList examples={[CREATE_CUSTOMER]} />
        <p>
          <strong>Expected:</strong> a <code>201</code> with a customer id — copy it into the
          next step as <code>&lt;your_customer_id&gt;</code>. Emails are normalized to
          lowercase and are not unique; the id is what identifies the customer.
        </p>
      </section>

      <section aria-labelledby="quickstart-payment">
        <h2 id="quickstart-payment">6. Create a payment</h2>
        <p>
          <strong>Where:</strong> the API with your TEST key.
        </p>
        <p>
          Money is a decimal string and the currency is lowercase <code>usd</code> (USD is the
          only currency in the MVP). The <code>Idempotency-Key</code> header makes a retry of
          this call safe: send the same value whenever you retry.
        </p>
        <CodeExampleList
          examples={[CREATE_PAYMENT_CURL, CREATE_PAYMENT_JS, CREATE_PAYMENT_PY]}
        />
        <p>
          <strong>Expected:</strong> a <code>201</code> with <code>status: "pending"</code>.{' '}
          <Link href="/docs/payments">Payments in detail →</Link>{' '}
          <Link href="/docs/idempotency">Idempotency in detail →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-success">
        <h2 id="quickstart-success">7. Watch the payment succeed</h2>
        <p>
          <strong>Where:</strong> the API (or the dashboard <strong>Payments</strong> page,
          which polls while a payment is still moving).
        </p>
        <p>
          The sandbox advances payments automatically from their creation time:{' '}
          <code>pending → processing → succeeded</code>. Retrieve the payment until it is
          terminal:
        </p>
        <CodeExampleList examples={[RETRIEVE_PAYMENT]} />
        <p>
          <strong>Expected:</strong> <code>status: "succeeded"</code>. This is the
          default-success simulation — every payment in the sandbox follows it today.{' '}
          <Link href="/docs/sandbox">What the sandbox simulates →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-webhook">
        <h2 id="quickstart-webhook">8. Register a webhook endpoint and verify a delivery</h2>
        <p>
          <strong>Where:</strong> the API with your TEST key (the dashboard has the same form
          under <strong>Webhooks</strong>).
        </p>
        <p>
          Point BrinnPay at a destination that accepts <code>POST</code> requests. The
          signing secret is returned only in this response:
        </p>
        <CodeExampleList examples={[REGISTER_WEBHOOK_ENDPOINT]} />
        <p>
          Because step 7 reached <code>succeeded</code>, a <code>payment.succeeded</code> event
          is already on its way to your endpoint. List the deliveries of the endpoint you just
          created (use the endpoint id from its <code>201</code> response) to see the attempts:
        </p>
        <CodeExampleList examples={[LIST_DELIVERIES]} />
        <p>
          <strong>Expected:</strong> a delivery row with <code>attempts: 1</code> and{' '}
          <code>response_status</code> set to the status your endpoint answered — <code>202</code>{' '}
          or <code>200</code> once it accepts the request. Verify the{' '}
          <code>BrinnPay-Signature</code> header of the received request against the secret you
          copied.{' '}
          <Link href="/docs/webhooks">Webhooks in detail →</Link>
        </p>
      </section>

      <section aria-labelledby="quickstart-next">
        <h2 id="quickstart-next">Next steps</h2>
        <ul>
          <li>
            <Link href="/docs/authentication">Authentication</Link> — the two credential modes
            and how each one fails.
          </li>
          <li>
            <Link href="/docs/payments">Payments</Link> and{' '}
            <Link href="/docs/refunds">Refunds</Link> — the resource flows you just exercised.
          </li>
          <li>
            <Link href="/docs/errors">Error handling</Link> and{' '}
            <Link href="/docs/rate-limits">Rate limits</Link> — what to do when a call fails or
            is throttled.
          </li>
          <li>
            <Link href="/docs/logs">Logs</Link> — request ids, request logs and the audit trail
            when you need to trace something.
          </li>
          <li>
            <Link href="/docs/api-reference">API reference</Link> — every operation generated
            from the contract.
          </li>
        </ul>
      </section>
    </Guide>
  );
}
