import { describe, expect, it } from 'vitest';

import nextConfig, {
  apiOriginFromEnv,
  buildContentSecurityPolicy,
  resolveSecureTransport,
  securityHeaders,
} from '../../next.config';

function headerValue(headers: { key: string; value: string }[], key: string): string | undefined {
  return headers.find((header) => header.key === key)?.value;
}

/**
 * Phase 14 §7.5 (D7): the web application's response headers are static
 * configuration in `next.config.ts` — one rule set for every route, asserted
 * here without booting the app. Phase 2 §4.2 / `docs/security-baseline.md`
 * handover; picked up by the Phase 18 security review.
 */
describe('web security headers (phase 14 §7.5, D7)', () => {
  it('declares CSP, nosniff, clickjacking, referrer and permissions policy', () => {
    const headers = securityHeaders({
      secure: false,
      development: false,
      apiOrigin: 'http://localhost:3000',
    });

    const csp = headerValue(headers, 'Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    // The dashboard calls a cross-origin API with credentials; the rate-limit
    // headers must stay readable (phase 13 Q3).
    expect(csp).toContain("connect-src 'self' http://localhost:3000");

    expect(headerValue(headers, 'X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue(headers, 'X-Frame-Options')).toBe('DENY');
    expect(headerValue(headers, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue(headers, 'Permissions-Policy')).toMatch(/payment=\(\)/);
  });

  it('never allows unsafe-eval in production CSP', () => {
    const production = buildContentSecurityPolicy({
      secure: true,
      development: false,
      apiOrigin: 'https://api.example.test',
    });
    expect(production).not.toContain('unsafe-eval');
    expect(production).toContain("script-src 'self' 'unsafe-inline'");

    // Development may use eval for the framework toolchain — never production.
    const development = buildContentSecurityPolicy({
      secure: false,
      development: true,
      apiOrigin: null,
    });
    expect(development).toContain('unsafe-eval');
    expect(development).toContain('ws:');
  });

  it('sends HSTS only on a secure transport (production/secure)', () => {
    const insecure = securityHeaders({ secure: false, development: false, apiOrigin: null });
    expect(headerValue(insecure, 'Strict-Transport-Security')).toBeUndefined();

    const secure = securityHeaders({ secure: true, development: false, apiOrigin: null });
    expect(headerValue(secure, 'Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('resolves the secure-transport flag like the API cookie flag', () => {
    expect(resolveSecureTransport('true', 'development')).toBe(true);
    expect(resolveSecureTransport('false', 'production')).toBe(false);
    expect(resolveSecureTransport(undefined, 'production')).toBe(true);
    expect(resolveSecureTransport(undefined, 'development')).toBe(false);
  });

  it('derives the connect-src origin from the configured API base URL', () => {
    expect(apiOriginFromEnv('http://localhost:3000/api/v1')).toBe('http://localhost:3000');
    expect(apiOriginFromEnv('https://api.example.test/v1')).toBe('https://api.example.test');
    // Not an absolute URL → falls back to `'self'` only, never a broken policy.
    expect(apiOriginFromEnv('/api/v1')).toBeNull();
  });

  it('applies one header set to every route through next.config', async () => {
    const routes = await nextConfig.headers?.();
    expect(routes).toHaveLength(1);
    expect(routes?.[0].source).toBe('/(.*)');
    const keys = (routes?.[0].headers ?? []).map((header) => header.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Content-Security-Policy',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
        'Permissions-Policy',
      ]),
    );
    // Local development must never be forced onto HTTPS (§7.5).
    const isProduction = process.env.NODE_ENV === 'production';
    expect(keys.includes('Strict-Transport-Security')).toBe(isProduction);
  });
});
