import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PublicLayout from '../../app/(public)/layout';
import DocsPage from '../../app/(public)/docs/page';
import HomePage from '../../app/(public)/page';
import ProductPage from '../../app/(public)/product/page';

/**
 * Phase 2 e2e, extended in phase 14 §11.1 (D9): the established jsdom smoke
 * pattern — Playwright/browser tooling is a Phase 17 concern. The public flow
 * (home → product → docs) renders with navigation and CTAs, and carries no
 * authenticated content: no session material, tokens, key material, or
 * dashboard content. Marketing vocabulary ("log in", "payments", "api keys")
 * is deliberately allowed.
 */
function expectPublicSurfaceOnly(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(/access_token|refresh_token|bearer\s+\S/i);
  expect(container.textContent).not.toMatch(/\b(sk|pk)_(test|live)_\S+/i);
  expect(container.textContent).not.toMatch(/test-access-token|brinnpay_refresh/i);
  expect(screen.queryByRole('navigation', { name: 'Dashboard' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  expect(container.querySelectorAll('a[href^="/dashboard"]')).toHaveLength(0);
}

describe('public home smoke test (phase 2 §11.2, phase 14 §11.1)', () => {
  it('renders home, product and docs with navigation and CTAs only', () => {
    const { container: home } = render(
      <PublicLayout>
        <HomePage />
      </PublicLayout>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Public' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Get started' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Log in' }).length).toBeGreaterThan(0);
    expectPublicSurfaceOnly(home);

    const { container: product } = render(
      <PublicLayout>
        <ProductPage />
      </PublicLayout>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Product' })).toBeInTheDocument();
    expectPublicSurfaceOnly(product);

    const { container: docs } = render(
      <PublicLayout>
        <DocsPage />
      </PublicLayout>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();
    expectPublicSurfaceOnly(docs);
  });
});
