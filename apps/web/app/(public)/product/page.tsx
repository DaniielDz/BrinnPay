import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Product — BrinnPay',
  description:
    'The BrinnPay product overview: simulated TEST and LIVE environments, payments, refunds, webhooks, logs, rate limiting, and the developer surfaces around them.',
};

const FEATURE_AREAS: { title: string; description: string }[] = [
  {
    title: 'Payments and customers',
    description:
      'Create customers and simulated payments per project and environment, and follow each payment through pending, processing, succeeded or failed.',
  },
  {
    title: 'Refunds',
    description:
      'Issue full or partial refunds against a payment, with the same status lifecycle as the payment itself.',
  },
  {
    title: 'Idempotency',
    description:
      'Idempotency keys make retries of critical writes safe: the first request wins, replays answer with the stored result.',
  },
  {
    title: 'Webhooks',
    description:
      'Endpoints subscribe to a closed event catalog, receive HMAC-SHA256-signed payloads, and retry with backoff — with manual replay when you need it.',
  },
  {
    title: 'API keys',
    description:
      'Per-project keys in TEST and LIVE, prefixed accordingly, shown once at creation and stored only as a hash.',
  },
  {
    title: 'Request and audit logs',
    description:
      'Request metadata with request IDs for debugging, and an immutable organization-scoped audit trail for accountability.',
  },
  {
    title: 'Rate limiting',
    description:
      'Every API route is budgeted; responses report the remaining budget in standard headers, and exceeding it answers with a retryable 429.',
  },
  {
    title: 'Sandbox scenarios',
    description:
      'Simulated behavior lets you exercise success and failure paths deterministically — no real money, no real card data.',
  },
];

/**
 * Product overview (phase 14 §4.1): the feature areas of the master
 * specification, the simulated TEST/LIVE environments, and the developer-facing
 * surfaces. Static server-rendered content only — no pricing (none applies),
 * no invented features (master specification).
 */
export default function ProductPage() {
  return (
    <div className="public-page product-page">
      <section className="hero">
        <h1>Product</h1>
        <p className="hero-lead">
          BrinnPay gives you a realistic payment stack to integrate against: the same shapes,
          statuses, errors and events you would meet in production, simulated end to end.
        </p>
      </section>

      <section aria-labelledby="environments-heading">
        <h2 id="environments-heading">TEST and LIVE environments</h2>
        <p>
          Every project supports two <strong>simulated</strong> environments:
        </p>
        <ul>
          <li>
            <span className="env-badge env-test">TEST</span> — develop and iterate; nothing here
            is real.
          </li>
          <li>
            <span className="env-badge env-live">LIVE</span> — exercise the same flows as your
            integration would in production. Still simulated: no real money is processed.
          </li>
        </ul>
        <p>TEST and LIVE data are always kept separate, and you can switch between them in the dashboard.</p>
      </section>

      <section aria-labelledby="features-heading">
        <h2 id="features-heading">Feature areas</h2>
        <ul className="capability-grid">
          {FEATURE_AREAS.map((area) => (
            <li key={area.title} className="capability-card">
              <h3>{area.title}</h3>
              <p>{area.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="surfaces-heading">
        <h2 id="surfaces-heading">Developer surfaces</h2>
        <ul>
          <li>
            <strong>REST API</strong> — a versioned API with consistent errors, request IDs and
            cursor pagination.
          </li>
          <li>
            <strong>OpenAPI</strong> — the contract is machine-readable, so your client can be
            generated from it.
          </li>
          <li>
            <strong>Webhooks</strong> — signed event delivery with retries and replay.
          </li>
          <li>
            <strong>Dashboard</strong> — manage organizations, projects and API keys, and inspect
            payments, refunds, webhooks and logs.
          </li>
        </ul>
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
