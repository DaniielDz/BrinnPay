import type { BrinnPayConfig } from '../config/configuration';

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface RefreshCookieSpec {
  name: string;
  path: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  maxAgeMilliseconds: number;
}

export function refreshCookieSpec(auth: BrinnPayConfig['auth']): RefreshCookieSpec {
  return {
    name: auth.cookieName,
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: auth.cookieSecure,
    sameSite: auth.cookieSameSite,
    maxAgeMilliseconds: auth.refreshSessionTtlDays * 24 * 60 * 60 * 1000,
  };
}

/**
 * Sets the refresh cookie on an express `Response`. `res.cookie` is available
 * because cookie-parser sits on the app (configured in `bootstrap.ts`).
 */
export function setRefreshCookie(
  res: {
    cookie: (name: string, value: string, options: Record<string, unknown>) => void;
  },
  spec: RefreshCookieSpec,
  token: string,
): void {
  res.cookie(spec.name, token, {
    httpOnly: spec.httpOnly,
    secure: spec.secure,
    sameSite: spec.sameSite,
    path: spec.path,
    maxAge: spec.maxAgeMilliseconds,
  });
}

export function clearRefreshCookie(
  res: {
    clearCookie: (name: string, options: Record<string, unknown>) => void;
  },
  spec: RefreshCookieSpec,
): void {
  res.clearCookie(spec.name, {
    httpOnly: spec.httpOnly,
    secure: spec.secure,
    sameSite: spec.sameSite,
    path: spec.path,
  });
}