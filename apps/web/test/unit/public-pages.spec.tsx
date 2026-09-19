import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from '../../app/(public)/page';
import ProductPage from '../../app/(public)/product/page';
import DocsPage from '../../app/(public)/docs/page';

describe('public placeholder pages (phase 2 §5.2)', () => {
  it('renders the home page with public copy only', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeInTheDocument();
    expect(screen.getByText(/payment infrastructure sandbox/i)).toBeInTheDocument();
  });

  it('renders the product page', () => {
    render(<ProductPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Product' })).toBeInTheDocument();
  });

  it('renders the docs page', () => {
    render(<DocsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Documentation' })).toBeInTheDocument();
  });

  it('exposes no authenticated content on the public home page', () => {
    render(<HomePage />);

    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/register/i)).not.toBeInTheDocument();
  });
});