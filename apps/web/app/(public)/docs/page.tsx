import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Documentation — BrinnPay',
  description: 'BrinnPay documentation: integration guides arrive with the developer experience area.',
};

/**
 * Documentation entry point (phase 14 §4.1): intentionally a stub — the
 * documentation content itself is Phase 15 and must not grow here.
 */
export default function DocsPage() {
  return (
    <div className="public-page docs-page">
      <section className="hero">
        <h1>Documentation</h1>
        <p className="hero-lead">
          BrinnPay documentation arrives with the developer experience area (Phase 15).
        </p>
        <div className="cta-row">
          <Link href="/product" className="button button-secondary">
            Product overview
          </Link>
          <Link href="/" className="button button-secondary">
            Back to home
          </Link>
        </div>
      </section>
    </div>
  );
}
