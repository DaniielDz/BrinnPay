import { ApiError } from '../common/errors/api-error';

import {
  assertDestinationAllowed,
  canonicalizeWebhookHost,
  MAX_WEBHOOK_URL_LENGTH,
  validateWebhookUrl,
} from './webhook-url';

/** Extracts the `url` field messages of a 400, so a test asserts the boundary
 *  contract rather than the error class. */
function fieldErrors(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    const details = api.details as { fields?: { field: string; errors: string[] }[] };
    return details.fields?.flatMap((entry) => entry.errors) ?? [];
  }
  throw new Error('expected validateWebhookUrl to throw');
}

describe('webhook destination URL (phase 10 §4.6, §5.7, D13)', () => {
  describe('accepted values', () => {
    it('keeps an absolute http/https URL byte-for-byte apart from the documented normalization', () => {
      expect(validateWebhookUrl('https://example.com/hooks')).toBe('https://example.com/hooks');
      expect(validateWebhookUrl('https://example.com/hooks?a=1&b=2')).toBe(
        'https://example.com/hooks?a=1&b=2',
      );
      // Path, port, and query are part of the endpoint's identity and are never
      // rewritten.
      expect(validateWebhookUrl('http://Example.COM:8080/Path/To/Hook')).toBe(
        'http://example.com:8080/Path/To/Hook',
      );
    });

    it('lowercases the scheme and host only (both case-insensitive per RFC 3986)', () => {
      expect(validateWebhookUrl('HTTPS://Example.COM/hooks')).toBe('https://example.com/hooks');
    });

    it('strips a single trailing slash from an otherwise empty path', () => {
      expect(validateWebhookUrl('https://example.com/')).toBe('https://example.com');
      // A real path is left alone: `/hooks/` and `/hooks` are different resources.
      expect(validateWebhookUrl('https://example.com/hooks/')).toBe('https://example.com/hooks/');
    });

    it('allows the sandbox destinations D13 requires: loopback, private, and tunnel hosts', () => {
      expect(validateWebhookUrl('http://localhost:3000/hook')).toBe('http://localhost:3000/hook');
      expect(validateWebhookUrl('http://127.0.0.1:9000/hook')).toBe('http://127.0.0.1:9000/hook');
      expect(validateWebhookUrl('http://receiver:8080/hook')).toBe('http://receiver:8080/hook');
      expect(validateWebhookUrl('http://10.0.0.5/hook')).toBe('http://10.0.0.5/hook');
      expect(validateWebhookUrl('https://abc123.ngrok.io/hook')).toBe('https://abc123.ngrok.io/hook');
    });

    it('accepts a URL at the length limit and trims surrounding whitespace', () => {
      const host = 'https://example.com/';
      const path = 'a'.repeat(MAX_WEBHOOK_URL_LENGTH - host.length);
      expect(validateWebhookUrl(`${host}${path}`)).toHaveLength(MAX_WEBHOOK_URL_LENGTH);
      expect(validateWebhookUrl('  https://example.com/hooks  ')).toBe('https://example.com/hooks');
    });
  });

  describe('rejected values (400 VALIDATION_ERROR on the url field)', () => {
    it('rejects a non-string, empty, or whitespace-only value', () => {
      expect(fieldErrors(() => validateWebhookUrl(42))).toEqual([
        'URL must be an http or https URL',
      ]);
      expect(fieldErrors(() => validateWebhookUrl(''))).toEqual(['URL must not be empty']);
      expect(fieldErrors(() => validateWebhookUrl('   '))).toEqual(['URL must not be empty']);
    });

    it('rejects a relative or non-HTTP scheme', () => {
      expect(fieldErrors(() => validateWebhookUrl('/hooks'))).toEqual([
        'URL must be an absolute http or https URL',
      ]);
      expect(fieldErrors(() => validateWebhookUrl('ftp://example.com/hook'))).toEqual([
        'URL must use the http or https scheme',
      ]);
      expect(fieldErrors(() => validateWebhookUrl('file:///etc/passwd'))).toEqual([
        'URL must use the http or https scheme',
      ]);
    });

    it('rejects embedded credentials — BrinnPay never forwards credentials (§5.7)', () => {
      expect(fieldErrors(() => validateWebhookUrl('https://user:pass@example.com/hook'))).toEqual([
        'URL must not embed credentials',
      ]);
      expect(fieldErrors(() => validateWebhookUrl('https://user@example.com/hook'))).toEqual([
        'URL must not embed credentials',
      ]);
    });

    it('rejects a fragment, which is never transmitted and would change the delivered URL', () => {
      expect(fieldErrors(() => validateWebhookUrl('https://example.com/hook#frag'))).toEqual([
        'URL must not contain a fragment',
      ]);
    });

    it('rejects a value over the length limit', () => {
      const long = `https://example.com/${'a'.repeat(MAX_WEBHOOK_URL_LENGTH)}`;
      expect(fieldErrors(() => validateWebhookUrl(long))).toEqual([
        `URL must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`,
      ]);
    });
  });

  describe('optional destination policy (D13)', () => {
    it('is permissive when no list is configured (the sandbox default)', () => {
      expect(() => assertDestinationAllowed('http://localhost:3000/hook', undefined)).not.toThrow();
      expect(() =>
        assertDestinationAllowed('http://localhost:3000/hook', { allowlist: [], denylist: [] }),
      ).not.toThrow();
    });

    it('rejects a host outside a configured allowlist', () => {
      const policy = { allowlist: ['hooks.example.com'] };
      expect(() => assertDestinationAllowed('https://hooks.example.com/hook', policy)).not.toThrow();
      expect(fieldErrors(() => assertDestinationAllowed('https://evil.example.com/hook', policy))).toEqual([
        'URL host is not in the configured webhook destination allowlist',
      ]);
    });

    it('rejects a host inside a configured denylist', () => {
      const policy = { denylist: ['blocked.example.com'] };
      expect(fieldErrors(() => assertDestinationAllowed('https://blocked.example.com/h', policy))).toEqual([
        'URL host is in the configured webhook destination denylist',
      ]);
      expect(() => assertDestinationAllowed('https://allowed.example.com/h', policy)).not.toThrow();
    });

    it('lets the allowlist win when both are set, and matches hosts exactly (no prefix match)', () => {
      const policy = { allowlist: ['Blocked.example.com'], denylist: ['blocked.example.com'] };
      expect(() => assertDestinationAllowed('https://blocked.example.com/h', policy)).not.toThrow();
      // `evil-blocked.example.com` is not `blocked.example.com`.
      expect(fieldErrors(() => assertDestinationAllowed('https://evil-blocked.example.com/h', policy))).toEqual([
        'URL host is not in the configured webhook destination allowlist',
      ]);
    });

    it('is applied by validateWebhookUrl, so a restricted deployment cannot register a blocked URL', () => {
      expect(fieldErrors(() => validateWebhookUrl('https://blocked.example.com/h', { denylist: ['blocked.example.com'] }))).toEqual([
        'URL host is in the configured webhook destination denylist',
      ]);
    });

    /**
     * A list that only matches the exact literal string an operator happened to
     * type is not a control: it is documentation that looks like one. WHATWG URL
     * keeps IPv6 hosts bracketed and preserves an FQDN root dot, so the canonical
     * spellings of loopback and root-domain forms missed the comparison entirely.
     * That gap was fail-closed for an allowlist and **fail-open for a denylist**,
     * which is the direction that matters.
     */
    it('denies the bracketed IPv6 form of a loopback host the denylist names bare', () => {
      // Operator writes `::1`; a URL can only spell it `[::1]`.
      expect(canonicalizeWebhookHost('::1')).toBe('::1');
      expect(fieldErrors(() => assertDestinationAllowed('http://[::1]:8080/collect', { denylist: ['::1'] }))).toEqual([
        'URL host is in the configured webhook destination denylist',
      ]);
      expect(
        fieldErrors(() => assertDestinationAllowed('http://[fe80::1]/collect', { denylist: ['[FE80::1]'] })),
      ).toEqual(['URL host is in the configured webhook destination denylist']);
    });

    it('denies the FQDN-root-dot form of a host the denylist names without one', () => {
      expect(fieldErrors(() => assertDestinationAllowed('http://localhost./hook', { denylist: ['localhost'] }))).toEqual([
        'URL host is in the configured webhook destination denylist',
      ]);
      expect(
        fieldErrors(() => assertDestinationAllowed('https://hooks.example.com./h', { denylist: ['hooks.example.com'] })),
      ).toEqual(['URL host is in the configured webhook destination denylist']);
    });

    it('normalizes both sides, so a bracketed or dotted list entry still allows its own host', () => {
      // The allowlist direction previously failed *closed*, which silently denied
      // legitimate destinations rather than allowing a denied one. Still wrong.
      expect(() => assertDestinationAllowed('http://[::1]:3000/h', { allowlist: ['[::1]'] })).not.toThrow();
      expect(() => assertDestinationAllowed('https://hooks.example.com./h', { allowlist: ['hooks.example.com.'] })).not.toThrow();
      expect(() => assertDestinationAllowed('https://hooks.example.com/h', { allowlist: ['HOOKS.EXAMPLE.COM'] })).not.toThrow();
    });

    it('still matches exactly after normalization, without becoming a suffix match', () => {
      // Normalizing must not weaken the no-prefix-match property the allowlist
      // depends on: `evil-blocked.example.com` is not `blocked.example.com`.
      expect(() =>
        assertDestinationAllowed('https://evil-blocked.example.com./h', { denylist: ['blocked.example.com'] }),
      ).not.toThrow();
      expect(fieldErrors(() => assertDestinationAllowed('https://evil.example.com/h', { allowlist: ['example.com'] }))).toEqual([
        'URL host is not in the configured webhook destination allowlist',
      ]);
    });
  });
});
