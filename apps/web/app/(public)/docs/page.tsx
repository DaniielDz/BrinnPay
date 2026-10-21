import type { Metadata } from 'next';
import Link from 'next/link';

import { DOCS_SECTIONS } from '../../../lib/docs/sections';

export const metadata: Metadata = {
  title: 'Documentation — BrinnPay',
  description:
    'BrinnPay documentation: quickstart, authentication, API keys, payments, refunds, idempotency, webhooks, errors, rate limits, logs, sandbox and the full API reference.',
};

/**
 * Documentation index (phase 15 §4.1, AC1): the complete section list with
 * one-line descriptions, a prominent quickstart entry and a link to the API
 * reference. Static content only — no session material, no API calls.
 */
export default function DocsPage() {
  return (
    <div className="public-page docs-page">
      <section className="hero">
        <h1>Documentation</h1>
        <p className="hero-lead">
          Everything you need to integrate against the BrinnPay sandbox: the same shapes,
          statuses, errors and events a production payment API would give you, simulated end
          to end.
        </p>
        <div className="cta-row">
          <Link href="/docs/quickstart" className="button button-primary">
            Start the quickstart
          </Link>
          <Link href="/docs/api-reference" className="button button-secondary">
            API reference
          </Link>
        </div>
        <p className="hint">
          BrinnPay is a sandbox: it processes no real money and no real card data.
        </p>
      </section>

      <section aria-labelledby="docs-index-heading">
        <h2 id="docs-index-heading">Guides</h2>
        <ul className="docs-index-entries">
          {DOCS_SECTIONS.map((section) => (
            <li key={section.href} className="docs-index-entry">
              <h3>
                <Link href={section.href}>{section.title}</Link>
              </h3>
              <p>{section.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="docs-sources-heading">
        <h2 id="docs-sources-heading">Where this documentation comes from</h2>
        <p>
          Every guide states the canonical artifact it derives from. The two sources of truth
          are the API contract and the API conventions document:
        </p>
        <ul>
          <li>
            <code>docs/openapi.yaml</code> — the canonical, machine-readable contract for every
            operation, schema and response. The <Link href="/docs/api-reference">API reference</Link>{' '}
            is generated from it at build time, so the two can never disagree.
          </li>
          <li>
            <code>docs/api-conventions.md</code> — the cross-cutting conventions: authentication
            modes, idempotency, pagination, errors, format rules and rate limiting.
          </li>
        </ul>
        <p className="hint">
          Only implemented, contracted behavior is documented here. Where a fact is not in the
          contract, it is not in these guides.
        </p>
      </section>
    </div>
  );
}
