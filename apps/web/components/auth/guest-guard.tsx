'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from './auth-provider';

/**
 * Client-side guard for the authentication area (phase 3 §5.1, phase 1
 * §11.2/§11.4). Always renders its children, but an authenticated visitor is
 * redirected to `/dashboard` so the auth pages never show a form for an
 * already-authenticated user. As with `AuthGuard`, the API remains the
 * enforcement point; this only shapes the routing experience.
 */
export function GuestGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/dashboard');
    }
  }, [status, router]);

  return <>{children}</>;
}