'use client';

import { useRouter } from 'next/navigation';

import { useAuth } from './auth-provider';

/**
 * Terminates the current session and returns to the login page. Logout is
 * idempotent (D9), so a failed API call still clears the local session.
 */
export function SignOutButton() {
  const { logout } = useAuth();
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        void logout().then(() => router.replace('/login'));
      }}
    >
      Sign out
    </button>
  );
}