import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PublicLayout from '../../app/(public)/layout';
import DocsPage, { metadata as docsMetadata } from '../../app/(public)/docs/page';
import HomePage, { metadata as homeMetadata } from '../../app/(public)/page';
import ProductPage, { metadata as productMetadata } from '../../app/(public)/product/page';

/**
 * Phase 14 §4 / §11.1 (D9): the negative assertions are re-scoped from banning
 * marketing vocabulary ("log in", "payments", "api keys") to banning what must
 * never appear on a public route — session material, tokens, key material,
 * authenticated/dashboard content or data. A marketing home page is allowed to
 * name the product and to link to login.
 */
function expectNoAuthenticatedContent(container: HTMLElement): void {
  // No session material, tokens, or key material of any kind.
  expect(container.textContent).not.toMatch(/access_token|refresh_token|bearer\s+\S/i);
  expect(container.textContent).not.toMatch(/\b(sk|pk)_(test|live)_\S+/i);
  expect(container.textContent).not.toMatch(/test-access-token|brinnpay_refresh/i);

  // No dashboard navigation, dashboard links, or session controls.
  expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  expect(container.querySelectorAll('a[href^="/dashboard"]')).toHaveLength(0);
}

describe('public pages (phase 2 §5.2, phase 14 §4)', () => {
  it('renders the home page with the required sections and CTAs', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeInTheDocument();
    expect(screen.getByText(/payment infrastructure sandbox/i)).toBeInTheDocument();
    // Per-page metadata (§4.1) is exported from the page module.
    expect(homeMetadata.title).toMatch(/BrinnPay/i);
    expect(homeMetadata.description).toBeTruthy();

    // Capability overview and calls to action: register + docs (AC1).
    expect(screen.getAllByRole('link', { name: 'Get started' }).length).toBeGreaterThan(0);
    const docsLinks = screen.getAllByRole('link', { name: /docs/i });
    expect(docsLinks.length).toBeGreaterThan(0);
    expect(docsLinks[0]).toHaveAttribute('href', '/docs');
    expect(screen.getAllByRole('link', { name: 'Get started' })[0]).toHaveAttribute(
      'href',
      '/register',
    );
  });

  it('renders the product overview without invented pricing', () => {
    const { container } = render(<ProductPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Product' })).toBeInTheDocument();
    // The simulated environments and the developer surfaces are described.
    expect(screen.getAllByText('TEST').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/webhook/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0);
    // No pricing claims: none applies (§4.1, §12).
    expect(productMetadata.title).toMatch(/product/i);
    expect(container.textContent).not.toMatch(/pricing|\$\d/i);
  });

  it('keeps /docs as the phase 15 entry point', () => {
    render(<DocsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();
    expect(screen.getByText(/phase 15/i)).toBeInTheDocument();
    expect(docsMetadata.title).toMatch(/documentation/i);
    // It stays an entry point — no guide content grows here (§4.1).
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('exposes no authenticated content on the public home page (D9)', () => {
    const { container } = render(<HomePage />);

    expectNoAuthenticatedContent(container);
  });

  it('exposes no authenticated content on product and docs (D9)', () => {
    const { container: product } = render(<ProductPage />);
    expectNoAuthenticatedContent(product);

    const { container: docs } = render(<DocsPage />);
    expectNoAuthenticatedContent(docs);
  });

  it('renders the public navigation and footer with the documented link targets (§4.2)', () => {
    render(
      <PublicLayout>
        <HomePage />
      </PublicLayout>,
    );

    const nav = screen.getByRole('navigation', { name: 'Public' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/product');
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    expect(within(nav).getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(within(nav).getByRole('link', { name: 'Get started' })).toHaveAttribute(
      'href',
      '/register',
    );

    const footer = screen.getByRole('contentinfo');
    const footerNav = within(footer).getByRole('navigation', { name: 'Footer' });
    expect(within(footerNav).getByRole('link', { name: 'Product' })).toHaveAttribute(
      'href',
      '/product',
    );
    expect(within(footerNav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    expect(within(footerNav).getByRole('link', { name: 'Login' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(within(footer).getByText(/sandbox.*no real money/i)).toBeInTheDocument();

    expectNoAuthenticatedContent(document.body);
  });
});
