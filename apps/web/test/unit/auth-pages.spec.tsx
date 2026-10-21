import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from '../../app/(auth)/login/page';
import RegisterPage from '../../app/(auth)/register/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { stubAuthApi, unstubAuthApi } from './auth-test-utils';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));

describe('authentication pages (phase 3 §4.2)', () => {
  beforeEach(() => {
    replaceMock.mockReset();
  });

  afterEach(() => {
    unstubAuthApi();
  });

  it('logs in with credentials and redirects to the dashboard', async () => {
    const { fetchMock } = stubAuthApi({ refresh: 'fail', login: 'ok' });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));

    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/login'));
    expect(loginCall).toBeDefined();
    const [, init] = loginCall!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'dev@example.com',
      password: 'password-123',
    });
  });

  it('surfaces the API error when login fails and stays on the page', async () => {
    stubAuthApi({ refresh: 'fail', login: 'fail' });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /log in/i })).toBeEnabled();
  });

  it('registers an account and redirects to the dashboard on success (D4)', async () => {
    const { fetchMock } = stubAuthApi({ refresh: 'fail', register: 'ok' });
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'grace@example.com' } });
    fireEvent.change(screen.getByLabelText(/name \(optional\)/i), { target: { value: 'Grace Hopper' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));

    const registerCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/register'));
    expect(registerCall).toBeDefined();
    const [, init] = registerCall!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'grace@example.com',
      password: 'password-123',
      name: 'Grace Hopper',
    });
  });

  it('shows a conflict message when the email is already registered', async () => {
    stubAuthApi({ refresh: 'fail', register: 'fail' });
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'taken@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('email is already registered');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('redirects an already-authenticated visitor away from /login (phase 1 §11.2)', async () => {
    stubAuthApi({ refresh: 'ok' });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('redirects an already-authenticated visitor away from /register (phase 1 §11.2)', async () => {
    stubAuthApi({ refresh: 'ok' });
    render(
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
  });
});