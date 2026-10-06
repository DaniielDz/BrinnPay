import type { NextConfig } from 'next';

/**
 * Security headers on web responses (phase 14 §7.5, D7; phase 2 §4.2 handover;
 * `docs/security-baseline.md`).
 *
 * Static configuration in `next.config.ts` — one rule set for every route,
 * testable without booting the app. The directive set is validated against the
 * running application (no CSP violations, styles/scripts intact, cross-origin
 * API calls with readable rate-limit headers still work — phase 13 Q3).
 *
 * HSTS and `Permissions-Policy` hardening follow the API's `COOKIE_SECURE`
 * precedent: secure by default in production, overridable for a plain-HTTP
 * production-style run (`WEB_SECURE=false`). HSTS is never sent in development
 * (§7.5: never forced on plain-HTTP local development).
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

export interface SecurityHeaderOptions {
  /** Send HSTS (secure/production transport). */
  secure: boolean;
  /** Development relaxations: eval and the dev-server websocket. */
  development?: boolean;
  /** API origin the browser calls (`connect-src`); `null` keeps `'self'`. */
  apiOrigin?: string | null;
}

/** Parses the secure-transport flag: explicit value wins, else production. */
export function resolveSecureTransport(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return nodeEnv === 'production';
}

/** The configured API origin for `connect-src`, or `null` when not absolute. */
export function apiOriginFromEnv(apiBaseUrl: string | undefined): string | null {
  const value = apiBaseUrl ?? 'http://localhost:3000/api/v1';
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy.
 *
 * - `default-src 'self'`; `object-src 'none'` and `base-uri 'self'` close the
 *   classic gadget vectors; `frame-ancestors 'none'` is the clickjacking
 *   restriction (mirrored by `X-Frame-Options` for older agents).
 * - `connect-src` covers the configured API origin so credentialed,
 *   cross-origin API calls — including readable `RateLimit-*` headers — work.
 * - `'unsafe-inline'` for scripts/styles is required by the framework's
 *   bootstrap; **`'unsafe-eval'` is never allowed in production** (§7.5).
 * - `form-action 'self'` keeps posted credentials on this origin.
 */
export function buildContentSecurityPolicy(options: SecurityHeaderOptions): string {
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `style-src 'self' 'unsafe-inline'`,
    `script-src 'self' 'unsafe-inline'${options.development ? " 'unsafe-eval'" : ''}`,
    `connect-src 'self'${options.apiOrigin ? ` ${options.apiOrigin}` : ''}${
      options.development ? ' ws: wss:' : ''
    }`,
  ];
  return directives.join('; ');
}

/** The full header set for one configuration. */
export function securityHeaders(options: SecurityHeaderOptions): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ];

  if (options.secure) {
    headers.push({
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    });
  }

  return headers;
}

const isDevelopment = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders({
          secure: resolveSecureTransport(process.env.WEB_SECURE, process.env.NODE_ENV),
          development: isDevelopment,
          apiOrigin: apiOriginFromEnv(process.env.NEXT_PUBLIC_API_BASE_URL),
        }),
      },
    ];
  },
};

export default nextConfig;
