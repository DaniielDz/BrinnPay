'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { GuestGuard } from '../../../components/auth/guest-guard';
import { useAuth } from '../../../components/auth/auth-provider';

/**
 * Login form (phase 3 §4.2). On success the session is applied through
 * `useAuth` and the user lands on the dashboard. The API is the enforcement
 * point; this component only surfaces errors from it. Authenticated visitors
 * are redirected to `/dashboard` (phase 1 §11.2).
 */
export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to log in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <GuestGuard>
      <section>
        <h1>Log in</h1>
        <form onSubmit={onSubmit}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        <p>
          <Link href="/register">Create an account</Link>
        </p>
      </section>
    </GuestGuard>
  );
}