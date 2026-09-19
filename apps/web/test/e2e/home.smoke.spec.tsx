import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from '../../app/(public)/page';

/**
 * Phase 2 e2e: minimal smoke test (D2). Playwright/browser tooling is a
 * Phase 17 concern; this smoke verifies the public surface renders without
 * leaking authenticated content.
 */
describe('public home smoke test (phase 2 §11.2)', () => {
  it('renders the home page without authenticated content', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'BrinnPay' })).toBeInTheDocument();

    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/api keys/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payments/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk_live_/i)).not.toBeInTheDocument();
  });
});