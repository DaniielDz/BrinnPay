import type { ComponentType } from 'react';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PublicLayout from '../../app/(public)/layout';
import DocsLayout from '../../app/(public)/docs/layout';
import ApiReferencePage from '../../app/(public)/docs/api-reference/page';
import DocsIndexPage from '../../app/(public)/docs/page';
import QuickstartPage from '../../app/(public)/docs/quickstart/page';
import WebhooksPage from '../../app/(public)/docs/webhooks/page';
import HomePage from '../../app/(public)/page';

/** The pathname the section navigation sees; reset per step. */
const { pathnameState } = vi.hoisted(() => ({ pathnameState: { current: '/docs' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.current,
}));

/**
 * Phase 15 §13.1 e2e smoke — the established jsdom pattern (Playwright is a
 * Phase 17 concern).
 *
 * 1. The public flow home → docs index → quickstart → a technical guide → the
 *    API reference renders statically, with the shell and section navigation
 *    intact and no authenticated content.
 * 2. The whole flow renders with `fetch` instrumented to fail the test, which
 *    proves the docs area has no runtime API dependency (§4.2, §9.3, §10).
 */

/** The Phase 14 D9 intent for docs: no credential that would work, no dashboard. */
function expectNoSessionMaterial(container: HTMLElement): void {
  const text = container.textContent ?? '';
  expect(text).not.toMatch(/\b(sk|pk)_(test|live)_[A-Za-z0-9]{4,}/);
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  expect(text).not.toMatch(/test-access-token|brinnpay_refresh/i);
  expect(text).not.toMatch(/(postgres|postgresql|redis):\/\/\S+/i);
  expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument();
  expect(container.querySelectorAll('a[href^="/dashboard"]')).toHaveLength(0);
}

/** Renders one page of the flow inside the public shell (and the docs shell). */
function renderStep(pathname: string, Page: ComponentType) {
  pathnameState.current = pathname;
  return render(
    <PublicLayout>
      <DocsLayout>
        <Page />
      </DocsLayout>
    </PublicLayout>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('docs public flow smoke (phase 15 §13.1)', () => {
  it('walks home → index → quickstart → guide → API reference, statically', () => {
    // 1. Home, with the public shell.
    const home = render(
      <PublicLayout>
        <HomePage />
      </PublicLayout>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Public' })).toBeInTheDocument();
    const docsLinks = within(home.container).getAllByRole('link', { name: /docs/i });
    expect(docsLinks.length).toBeGreaterThan(0);
    expect(docsLinks[0]).toHaveAttribute('href', '/docs');
    expectNoSessionMaterial(home.container);
    home.unmount();

    // 2. The documentation index lists the guides and the entry points.
    const index = renderStep('/docs', () => <DocsIndexPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();
    expect(within(index.container).getByRole('link', { name: /start the quickstart/i })).toHaveAttribute(
      'href',
      '/docs/quickstart',
    );
    expect(index.container.querySelectorAll('.docs-index-entry').length).toBeGreaterThan(10);
    expectNoSessionMaterial(index.container);
    index.unmount();

    // 3. The quickstart, reached from the index, with the section navigation.
    const quickstart = renderStep('/docs/quickstart', () => <QuickstartPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: /quickstart/i }),
    ).toBeInTheDocument();
    const quickstartNav = screen.getByRole('navigation', { name: /documentation/i });
    expect(within(quickstartNav).getByRole('link', { name: 'API reference' })).toHaveAttribute(
      'href',
      '/docs/api-reference',
    );
    expect(
      within(quickstartNav).getByRole('link', { current: 'page' }),
    ).toHaveAttribute('href', '/docs/quickstart');
    expectNoSessionMaterial(quickstart.container);
    quickstart.unmount();

    // 4. A technical guide: same shell, canonical sources, back to the index.
    const guide = renderStep('/docs/webhooks', () => <WebhooksPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeInTheDocument();
    expect(guide.container.textContent).toContain('docs/openapi.yaml');
    expect(within(guide.container).getByRole('link', { name: /documentation index/i })).toHaveAttribute(
      'href',
      '/docs',
    );
    expectNoSessionMaterial(guide.container);
    guide.unmount();

    // 5. The API reference, presented from the contract.
    const reference = renderStep('/docs/api-reference', () => <ApiReferencePage />);
    expect(
      screen.getByRole('heading', { level: 1, name: /api reference/i }),
    ).toBeInTheDocument();
    expect(reference.container.querySelectorAll('article.docs-op').length).toBeGreaterThan(10);
    expect(reference.container.textContent).toContain('docs/openapi.yaml');
    expectNoSessionMaterial(reference.container);
    reference.unmount();
  }, 30_000);
});

describe('docs area has no runtime API dependency (phase 15 §9.3, §10)', () => {
  it('renders the flow without a single request', () => {
    const forbidden = vi.fn((...args: unknown[]) => {
      throw new Error(`the docs area must not fetch: ${String(args[0])}`);
    });
    vi.stubGlobal('fetch', forbidden);

    for (const [pathname, Page] of [
      ['/docs', DocsIndexPage],
      ['/docs/quickstart', QuickstartPage],
      ['/docs/webhooks', WebhooksPage],
      ['/docs/api-reference', ApiReferencePage],
    ] as const) {
      const step = renderStep(pathname, Page);
      expect(step.container.textContent.length).toBeGreaterThan(0);
      step.unmount();
    }

    expect(forbidden).not.toHaveBeenCalled();
  }, 30_000);
});
