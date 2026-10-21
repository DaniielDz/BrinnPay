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

import { ApiClientError, login as apiLogin, logout as apiLogout, me as apiMe, refresh as apiRefresh, register as apiRegister, type AuthSession, type PublicUser } from '../../lib/brinnpay/client';
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
 * The failure is the API's rejection of the session (`401`): the refresh
 * cookie is missing, expired, reused or otherwise refused (phase 3 §4.4).
 * Nothing else proves the session is gone.
 */
function isRejected(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/**
 * The failure is throttling (`429`): transient by definition and never a
 * verdict on the session — phase 14 §7.3 requires a `429` to read as retryable,
 * never as an authorization or session problem, so it must not sign anyone out.
 */
function isThrottled(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 429;
}

/**
 * Client-side session store (phase 3 §4.4). The API remains the enforcement
 * point; this provider only keeps the in-memory access token and the current
 * user. On mount it restores a session through `/auth/refresh` (the `HttpOnly`
 * cookie round-trips automatically) and then resolves the identity through
 * `GET /auth/me` — the refresh response is an `AccessTokenResponse` and never
 * carries the user (phase 3 §4.4; phase 14 §4/§5).
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

  /**
   * Cookie refresh + identity lookup as one unit: a restored session is only
   * usable together with the user it belongs to. Used by both the mount-time
   * restore and the mid-session 401 recovery, so neither path can leave
   * `user` unset (which would silently demote every role-gated control to
   * the viewer fallback).
   */
  const restoreSession = useCallback(async (): Promise<AuthSession> => {
    const payload = await apiRefresh();
    return { ...payload, user: await apiMe(payload.access_token) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((session) => {
        if (!cancelled) applySession(session);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A throttled restore (`429`) is not evidence that the session is
        // gone (phase 14 §7.3): the restore stays pending instead of being
        // cleared, so throttling can never read as a sign-out.
        if (isThrottled(error)) return;
        clearSession();
      });
    return () => {
      cancelled = true;
    };
  }, [restoreSession, applySession, clearSession]);

  // Recovery path for a mid-session `401` (phase 14 §7.3): the API client
  // hands a failed authenticated request back here once — refresh through the
  // existing session flow, or clear the session so `AuthGuard` redirects to
  // `/login`. Never shown to the user as a generic failure. Concurrent callers
  // share one refresh (see `lib/brinnpay/session.ts`), and only an actual
  // rejection of the refresh (`401`) clears the session: a `429` (retryable,
  // never a session problem), another `4xx`, a `5xx` or a transport failure is
  // not evidence that the session is gone, so none of them signs the user out.
  useEffect(() => {
    setUnauthorizedRecovery(async () => {
      try {
        const session = await restoreSession();
        applySession(session);
        return session.access_token;
      } catch (error) {
        if (isRejected(error)) clearSession();
        return null;
      }
    });
    return () => setUnauthorizedRecovery(null);
  }, [restoreSession, applySession, clearSession]);

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