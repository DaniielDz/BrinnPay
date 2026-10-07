/**
 * Documentation section registry (phase 15 §4.1).
 *
 * One declaration per public docs route: the index renders this list, the
 * section navigation renders it, and the link-integrity tests walk it. Slugs
 * are part of the specification — navigation, tests and external links depend
 * on them — so a section can only be added or removed with a specification
 * change.
 */

export interface DocsSection {
  /** Route path served by the section's page module. */
  href: string;
  /** Section heading as it appears in the index and the navigation. */
  title: string;
  /** One-line description used by the documentation index. */
  description: string;
}

/** The documentation index route. */
export const DOCS_INDEX_HREF = '/docs';

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    href: '/docs/quickstart',
    title: 'Quickstart',
    description:
      'Create an account, a project and a TEST API key, then take your first payment end to end.',
  },
  {
    href: '/docs/authentication',
    title: 'Authentication',
    description:
      'The two authentication modes — API key and session — and how each one fails.',
  },
  {
    href: '/docs/api-keys',
    title: 'API keys',
    description: 'Key format and scope, one-time display, rotation, revocation and leak response.',
  },
  {
    href: '/docs/environments',
    title: 'Environments',
    description: 'How TEST and LIVE stay separate, and where the environment comes from.',
  },
  {
    href: '/docs/payments',
    title: 'Payments',
    description: 'Creating, retrieving and listing simulated payments, and how they advance.',
  },
  {
    href: '/docs/refunds',
    title: 'Refunds',
    description: 'Full and partial refunds against a succeeded payment.',
  },
  {
    href: '/docs/idempotency',
    title: 'Idempotency',
    description: 'Safe retries with the Idempotency-Key header and its 24-hour window.',
  },
  {
    href: '/docs/webhooks',
    title: 'Webhooks',
    description: 'Endpoint registration, signature verification, retries, replay and retention.',
  },
  {
    href: '/docs/errors',
    title: 'Error handling',
    description: 'The error envelope, stable codes, status semantics and when to retry.',
  },
  {
    href: '/docs/rate-limits',
    title: 'Rate limits',
    description: 'Budget scopes, the operation-class catalog, response headers and 429 handling.',
  },
  {
    href: '/docs/logs',
    title: 'Logs',
    description: 'Request IDs, request logs and the append-only audit trail.',
  },
  {
    href: '/docs/sandbox',
    title: 'Sandbox',
    description: 'What the sandbox simulates today, and what it does not.',
  },
  {
    href: '/docs/local-development',
    title: 'Local development',
    description: 'Run BrinnPay locally and point a local integration at the sandbox.',
  },
  {
    href: '/docs/api-reference',
    title: 'API reference',
    description: 'The full API reference generated from the canonical OpenAPI contract.',
  },
];

/** Every route the documentation area owns (index + sections). */
export const DOCS_ROUTES: readonly string[] = [DOCS_INDEX_HREF, ...DOCS_SECTIONS.map((s) => s.href)];

/** Public routes a documentation page may link to. */
export const PUBLIC_ROUTES: readonly string[] = ['/', '/product', '/login', '/register'];

/** Every internal route a documentation page may link to (phase 15 §9.1). */
export const ALLOWED_DOC_LINKS: readonly string[] = [...DOCS_ROUTES, ...PUBLIC_ROUTES];
