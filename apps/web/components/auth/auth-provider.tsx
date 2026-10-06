'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiClientError, login as apiLogin, logout as apiLogout, refresh as apiRefresh, register as apiRegister, type AuthSession, type PublicUser } from '../../lib/brinnpay/client';
import { resetRateLimitStore } from '../../lib/brinnpay/rate-limit';
import { setUnauthorizedRecovery } from '../../lib/brinnpay/session';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface RegisterFormInput {
  email: string;
  password: string;
  name?: string;
}

export interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  accessToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterFormInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Client-side session store (phase 3 §4.4). The API remains the enforcement
 * point; this provider only keeps the in-memory access token and the current
 * user. On mount it restores a session through `/auth/refresh`, which uses the
 * `HttpOnly` cookie automatically.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const applySession = useCallback((session: AuthSession) => {
    setUser(session.user);
    setAccessToken(session.access_token);
    setStatus('authenticated');
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setAccessToken(null);
    setStatus('unauthenticated');
    // Rate-limit budget and throttle state are per-session presentation data:
    // dropping them here keeps user A's state from bleeding into user B's
    // session in the same tab (phase 14 §7.4).
    resetRateLimitStore();
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRefresh()
      .then((session) => {
        if (!cancelled) applySession(session);
      })
      .catch(() => {
        if (!cancelled) clearSession();
      });
    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession]);

  // Recovery path for a mid-session `401` (phase 14 §7.3): the API client
  // hands a failed authenticated request back here once — refresh through the
  // existing session flow, or clear the session so `AuthGuard` redirects to
  // `/login`. Never shown to the user as a generic failure. Concurrent callers
  // share one refresh (see `lib/brinnpay/session.ts`), and only an actual
  // rejection of the refresh clears the session: a transport failure or a 5xx
  // is not evidence that the session is gone, so it never signs the user out.
  useEffect(() => {
    setUnauthorizedRecovery(async () => {
      try {
        const session = await apiRefresh();
        applySession(session);
        return session.access_token;
      } catch (error) {
        const rejected =
          error instanceof ApiClientError && error.status >= 400 && error.status < 500;
        if (rejected) clearSession();
        return null;
      }
    });
    return () => setUnauthorizedRecovery(null);
  }, [applySession, clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      applySession(await apiLogin(email, password));
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterFormInput) => {
      applySession(await apiRegister(input));
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo(
    () => ({ status, user, accessToken, login, register, logout }),
    [status, user, accessToken, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}