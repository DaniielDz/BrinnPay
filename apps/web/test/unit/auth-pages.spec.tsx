import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LoginPage from '../../app/(auth)/login/page';
import RegisterPage from '../../app/(auth)/register/page';

describe('authentication placeholder pages (phase 2 §5.2)', () => {
  it('renders the login placeholder without login behavior', () => {
    render(<LoginPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log in/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('renders the register placeholder without registration behavior', () => {
    render(<RegisterPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Register' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument();
  });
});