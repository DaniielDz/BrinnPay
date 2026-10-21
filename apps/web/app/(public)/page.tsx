import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'BrinnPay — payment infrastructure sandbox for developers',
  description:
    'BrinnPay simulates payment infrastructure — payments, refunds, webhooks, API keys, logs and rate limiting — without processing real money.',
};

const CAPABILITIES: { title: string; description: string }[] = [
  {
    title: 'Payments and refunds',
    description:
      'Create simulated payments, watch them advance through their lifecycle, and issue refunds against them.',
  },
  {
    title: 'Idempotency',
    description:
      'Retry critical writes safely with idempotency keys, exactly as a production integration would.',
  },
  {
    title: 'Webhooks and retries',
    description:
      'Register endpoints, receive signed events, and inspect delivery attempts, retries and replay.',
  },
  {
    title: 'API keys',
    description:
      'Issue TEST and LIVE API keys per project, shown once at creation and stored hashed only.',
  },
  {
    title: 'Request and audit logs',
    description:
      'Inspect request metadata and an immutable audit trail of who did what, scoped to your organization.',
  },
  {
    title: 'Errors and rate limiting',
    description:
      'A consistent error envelope with request IDs, plus rate limits with budget headers you can handle.',
  },
  {
    title: 'Sandbox scenarios',
    description:
      'Exercise success and failure paths through simulated behavior instead of real money movement.',
  },
];

/**
 * Public home (phase 14 §4.1): a static, server-rendered statement of what
 * BrinnPay is for a developer evaluating it. It performs no API calls and
 * renders no authenticated material (phase 1 §11.1).
 */
export default function HomePage() {
  return (
    <div className="public-page home-page">
      <section className="hero">
        <h1>BrinnPay</h1>
        <p className="hero-lead">
          Payment infrastructure sandbox for developers — realistic payment flows without
          processing real money.
        </p>
        <div className="cta-row">
          <Link href="/register" className="button button-primary">
            Get started
          </Link>
          <Link href="/docs" className="button button-secondary">
            Read the docs
          </Link>
        </div>
      </section>

      <section aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading">Everything an integration needs</h2>
        <ul className="capability-grid">
          {CAPABILITIES.map((capability) => (
            <li key={capability.title} className="capability-card">
              <h3>{capability.title}</h3>
              <p>{capability.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-it-works-heading">
        <h2 id="how-it-works-heading">Integration at a glance</h2>
        <ol className="steps">
          <li>
            <strong>Create an API key.</strong> Sign up, create a project, and issue a TEST key
            from the dashboard.
          </li>
          <li>
            <strong>Call the API.</strong> Send requests against the versioned REST API with
            idempotency keys and predictable error envelopes.
          </li>
          <li>
            <strong>Receive the webhook.</strong> Subscribe an endpoint and get signed events
            with automatic retries and replay.
          </li>
        </ol>
        <p>
          Then inspect everything that happened in the request logs, the audit log, and the
          payments view.
        </p>
      </section>

      <section aria-labelledby="cta-heading" className="cta-section">
        <h2 id="cta-heading">Start building</h2>
        <p>Create an account to open the dashboard, or read the documentation first.</p>
        <div className="cta-row">
          <Link href="/register" className="button button-primary">
            Get started
          </Link>
          <Link href="/docs" className="button button-secondary">
            Read the docs
          </Link>
        </div>
      </section>
    </div>
  );
}
