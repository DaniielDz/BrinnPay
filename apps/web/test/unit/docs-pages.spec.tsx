import type { Metadata } from 'next';
import type { ComponentType } from 'react';

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DocsLayout from '../../app/(public)/docs/layout';
import ApiKeysPage, { metadata as apiKeysMetadata } from '../../app/(public)/docs/api-keys/page';
import ApiReferencePage, {
  metadata as apiReferenceMetadata,
} from '../../app/(public)/docs/api-reference/page';
import AuthenticationPage, {
  metadata as authenticationMetadata,
} from '../../app/(public)/docs/authentication/page';
import EnvironmentsPage, {
  metadata as environmentsMetadata,
} from '../../app/(public)/docs/environments/page';
import ErrorsPage, { metadata as errorsMetadata } from '../../app/(public)/docs/errors/page';
import IdempotencyPage, {
  metadata as idempotencyMetadata,
} from '../../app/(public)/docs/idempotency/page';
import LocalDevelopmentPage, {
  metadata as localDevelopmentMetadata,
} from '../../app/(public)/docs/local-development/page';
import LogsPage, { metadata as logsMetadata } from '../../app/(public)/docs/logs/page';
import DocsIndexPage, { metadata as docsIndexMetadata } from '../../app/(public)/docs/page';
import PaymentsPage, { metadata as paymentsMetadata } from '../../app/(public)/docs/payments/page';
import QuickstartPage, {
  metadata as quickstartMetadata,
} from '../../app/(public)/docs/quickstart/page';
import RateLimitsPage, {
  metadata as rateLimitsMetadata,
} from '../../app/(public)/docs/rate-limits/page';
import RefundsPage, { metadata as refundsMetadata } from '../../app/(public)/docs/refunds/page';
import SandboxPage, { metadata as sandboxMetadata } from '../../app/(public)/docs/sandbox/page';
import WebhooksPage, { metadata as webhooksMetadata } from '../../app/(public)/docs/webhooks/page';
import {
  ALLOWED_DOC_LINKS,
  DOCS_INDEX_HREF,
  DOCS_ROUTES,
  DOCS_SECTIONS,
} from '../../lib/docs/sections';

/**
 * Phase 15 §4, §9, §12 (AC1–AC3, AC11): the documentation area as a whole —
 * the index, the section navigation, per-page metadata, internal link
 * integrity, heading order and the public-area content rule (Phase 14 D9,
 * extended to every docs route). Per-guide facts live in `docs-guides.spec.tsx`.
 */

/** The current path as the section navigation sees it (starts on the index). */
const pathnameState = vi.hoisted(() => ({ current: '/docs' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.current,
}));

interface DocsPageEntry {
  href: string;
  /** The word the page's title/description must be about. */
  subject: RegExp;
  Component: ComponentType;
  metadata: Metadata;
}

/** Every route of §4.1, with the subject its metadata must carry. */
const DOCS_PAGES: readonly DocsPageEntry[] = [
  {
    href: '/docs',
    subject: /documentation/i,
    Component: DocsIndexPage,
    metadata: docsIndexMetadata,
  },
  { href: '/docs/quickstart', subject: /quickstart/i, Component: QuickstartPage, metadata: quickstartMetadata },
  {
    href: '/docs/authentication',
    subject: /authentication/i,
    Component: AuthenticationPage,
    metadata: authenticationMetadata,
  },
  { href: '/docs/api-keys', subject: /api key/i, Component: ApiKeysPage, metadata: apiKeysMetadata },
  {
    href: '/docs/environments',
    subject: /environment/i,
    Component: EnvironmentsPage,
    metadata: environmentsMetadata,
  },
  { href: '/docs/payments', subject: /payment/i, Component: PaymentsPage, metadata: paymentsMetadata },
  { href: '/docs/refunds', subject: /refund/i, Component: RefundsPage, metadata: refundsMetadata },
  {
    href: '/docs/idempotency',
    subject: /idempotenc/i,
    Component: IdempotencyPage,
    metadata: idempotencyMetadata,
  },
  { href: '/docs/webhooks', subject: /webhook/i, Component: WebhooksPage, metadata: webhooksMetadata },
  { href: '/docs/errors', subject: /error/i, Component: ErrorsPage, metadata: errorsMetadata },
  {
    href: '/docs/rate-limits',
    subject: /rate limit/i,
    Component: RateLimitsPage,
    metadata: rateLimitsMetadata,
  },
  { href: '/docs/logs', subject: /log/i, Component: LogsPage, metadata: logsMetadata },
  { href: '/docs/sandbox', subject: /sandbox/i, Component: SandboxPage, metadata: sandboxMetadata },
  {
    href: '/docs/local-development',
    subject: /local development/i,
    Component: LocalDevelopmentPage,
    metadata: localDevelopmentMetadata,
  },
  {
    href: '/docs/api-reference',
    subject: /api reference/i,
    Component: ApiReferencePage,
    metadata: apiReferenceMetadata,
  },
];

/**
 * The Phase 14 D9 intent, applied to the documentation area (§11.1): no
 * session material, no dashboard surface, no credential that would actually
 * work. The documented *placeholder* patterns (`sk_test_...`, `<your-access-token>`)
 * are required content (§7) and are therefore not what this checks — a real
 * credential, a JWT or a connection string is.
 */
function expectNoSessionMaterial(container: HTMLElement): void {
  const text = container.textContent ?? '';

  // Credential material: only the placeholder ellipsis forms may appear.
  expect(text).not.toMatch(/\b(sk|pk)_(test|live)_[A-Za-z0-9]{4,}/);
  // JWT-shaped strings (access or refresh tokens).
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  // Cookie/session artifact names and dev tokens.
  expect(text).not.toMatch(/test-access-token|brinnpay_refresh/i);
  // Connection strings (database, cache) and their credentials.
  expect(text).not.toMatch(/(postgres|postgresql|redis):\/\/\S+/i);

  // No authenticated/dashboard surface anywhere in the public docs area.
  expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  expect(container.querySelectorAll('a[href^="/dashboard"]')).toHaveLength(0);
}

/** Heading levels in document order, as integers (h1 → 1). */
function headingLevels(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((heading) =>
    Number(heading.tagName.slice(1)),
  );
}

/** §4.2 / §7.6: headings never skip a level. */
function expectNoSkippedHeadingLevels(container: HTMLElement): void {
  const levels = headingLevels(container);
  expect(levels[0]).toBe(1);
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index]).toBeLessThanOrEqual(levels[index - 1] + 1);
  }
}

/** Every internal `href` the page emits must resolve to a known route (§9.1). */
function expectLinkIntegrity(container: HTMLElement): void {
  const links = Array.from(container.querySelectorAll('a[href]')).map((anchor) =>
    anchor.getAttribute('href') ?? '',
  );

  for (const href of links) {
    if (href.startsWith('#')) continue;
    if (/^https?:\/\//.test(href)) {
      // §11.7: external links carry `noopener noreferrer`.
      expect(anchorRel(container, href)).toMatch(/noopener/);
      continue;
    }
    expect(ALLOWED_DOC_LINKS).toContain(href.split('#')[0]);
  }
}

/** `rel` of the anchor pointing at `href`. */
function anchorRel(container: HTMLElement, href: string): string {
  const anchor = Array.from(container.querySelectorAll('a[href]')).find(
    (element) => element.getAttribute('href') === href,
  );
  return anchor?.getAttribute('rel') ?? '';
}

beforeEach(() => {
  pathnameState.current = DOCS_INDEX_HREF;
});

describe('documentation index (phase 15 §4.1, AC1)', () => {
  it('lists every section with its link target and a description', () => {
    const { container } = render(<DocsIndexPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();

    // Every section appears exactly once, with its own link target and copy.
    const entries = Array.from(container.querySelectorAll('.docs-index-entry'));
    expect(entries).toHaveLength(DOCS_SECTIONS.length);

    DOCS_SECTIONS.forEach((section, index) => {
      const entry = entries[index] as HTMLElement;
      const link = within(entry).getByRole('link', { name: section.title });
      expect(link).toHaveAttribute('href', section.href);
      expect(entry.textContent).toContain(section.description);
    });
  });

  it('offers the quickstart and the API reference as entry points', () => {
    render(<DocsIndexPage />);

    expect(screen.getByRole('link', { name: /start the quickstart/i })).toHaveAttribute(
      'href',
      '/docs/quickstart',
    );

    // The quickstart button, the section entry and the prose link all land on
    // the embedded reference (§6: discoverable from `/docs`).
    const referenceLinks = screen.getAllByRole('link', { name: /api reference/i });
    expect(referenceLinks.length).toBeGreaterThan(1);
    for (const link of referenceLinks) {
      expect(link).toHaveAttribute('href', '/docs/api-reference');
    }

    expect(screen.getByRole('heading', { level: 2, name: /guides/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /where this documentation comes from/i }),
    ).toBeInTheDocument();
  });

  it('states its subject in the exported metadata (AC1)', () => {
    expect(docsIndexMetadata.title).toMatch(/documentation/i);
    expect(docsIndexMetadata.description).toMatch(/quickstart/i);
  });

  it('carries no session material, tokens or dashboard content (D9)', () => {
    const { container } = render(<DocsIndexPage />);
    expectNoSessionMaterial(container);
  });
});

describe('section navigation (phase 15 §4.2, AC3)', () => {
  it('exposes every section and marks the current page', () => {
    pathnameState.current = '/docs/webhooks';
    const { container } = render(
      <DocsLayout>
        <WebhooksPage />
      </DocsLayout>,
    );

    const nav = screen.getByRole('navigation', { name: 'Documentation' });
    expect(within(nav).getByRole('link', { name: 'All documentation' })).toHaveAttribute(
      'href',
      DOCS_INDEX_HREF,
    );
    for (const section of DOCS_SECTIONS) {
      expect(within(nav).getByRole('link', { name: section.title })).toHaveAttribute(
        'href',
        section.href,
      );
    }

    // Exactly one current location, and it is the page on screen (§4.2).
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/docs/webhooks');
    expect(current[0]).toHaveTextContent('Webhooks');
    expect(container.querySelector('.docs-nav-current')).not.toBeNull();
  });

  it('marks the index itself when the reader is on it', () => {
    pathnameState.current = DOCS_INDEX_HREF;
    render(
      <DocsLayout>
        <DocsIndexPage />
      </DocsLayout>,
    );

    const nav = screen.getByRole('navigation', { name: 'Documentation' });
    expect(within(nav).getByRole('link', { name: 'All documentation' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('every documentation route (phase 15 §4, §12 AC2/AC11)', () => {
  /**
   * The reference route renders every operation and schema, so this suite's
   * per-route tests get room on a loaded runner instead of the 5 s default.
   */
  const itRoute = (name: string, fn: () => void): void => {
    it(name, fn, 30_000);
  };

  for (const entry of DOCS_PAGES) {
    describe(entry.href, () => {
      itRoute('renders statically with one h1, a source note and a way back', () => {
        pathnameState.current = entry.href;
        const { container } = render(
          <DocsLayout>
            <entry.Component />
          </DocsLayout>,
        );

        expect(container.querySelectorAll('h1')).toHaveLength(1);
        expectNoSkippedHeadingLevels(container);
        expect(container.textContent?.length ?? 0).toBeGreaterThan(400);

        // §5.1 rule 2: the canonical artifact(s) are visible on every guide.
        const source = container.querySelector('.docs-source');
        if (entry.href !== DOCS_INDEX_HREF) {
          expect(source).not.toBeNull();
          expect(source?.textContent).toMatch(/docs\/(openapi\.yaml|api-conventions\.md)/);
          expect(
            within(container).getByRole('link', { name: /back to the documentation index/i }),
          ).toHaveAttribute('href', DOCS_INDEX_HREF);
        }
      });

      it('carries a title and description about its subject (AC2)', () => {
        expect(entry.metadata.title).toMatch(entry.subject);
        expect(entry.metadata.title).toMatch(/BrinnPay/i);
        expect(entry.metadata.description).toBeTruthy();
        expect(entry.metadata.description?.length ?? 0).toBeGreaterThanOrEqual(60);
        expect(entry.metadata.description).toMatch(entry.subject);
      });

      itRoute('links only to routes that exist (AC2, §9.1)', () => {
        pathnameState.current = entry.href;
        const { container } = render(
          <DocsLayout>
            <entry.Component />
          </DocsLayout>,
        );
        expectLinkIntegrity(container);
      });

      itRoute('exposes no session material or dashboard content (AC11, D9)', () => {
        pathnameState.current = entry.href;
        const { container } = render(
          <DocsLayout>
            <entry.Component />
          </DocsLayout>,
        );
        expectNoSessionMaterial(container);
      });

      // Phase 16 §10 AC11: the phase 15 claim that no failure trigger exists is
      // obsolete, and no page may restate it in any wording.
      itRoute('claims no absence of a failure trigger (phase 16 AC11)', () => {
        pathnameState.current = entry.href;
        const { container } = render(
          <DocsLayout>
            <entry.Component />
          </DocsLayout>,
        );
        expect(container.textContent ?? '').not.toMatch(
          /no public trigger for failure|no way to make a payment fail|no scenario triggers|failure scenarios are planned work|no declines or failures/i,
        );
      });
    });
  }

  it('registers exactly the routes of the specification §4.1 table', () => {
    expect(DOCS_PAGES.map((page) => page.href)).toEqual([...DOCS_ROUTES]);
    expect(DOCS_ROUTES).toHaveLength(15);
  });
});
