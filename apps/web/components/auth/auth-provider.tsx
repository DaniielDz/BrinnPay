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

import { login as apiLogin, logout as apiLogout, refresh as apiRefresh, register as apiRegister, type AuthSession, type PublicUser } from '../../lib/brinnpay/client';

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