import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimitIndicator } from '../../components/dashboard/rate-limit-indicator';
import { ApiClientError, listProjects } from '../../lib/brinnpay/client';
import {
  captureRateLimit,
  formatDelay,
  getRateLimitState,
  resetRateLimitStore,
  retryAfterSecondsFor,
} from '../../lib/brinnpay/rate-limit';

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRateLimitStore();
});

/**
 * Phase 14 §7.4 (D8): the budget indicator renders reported numbers and stays
 * silent when nothing is reported; the throttle record keeps the dashboard a
 * well-mannered client (phase 13 §9). Only budget numbers may ever appear
 * (phase 13 §4.4 point 5).
 */
describe('rate-limit budget surfacing (phase 14 §7.4, AC11)', () => {
  it('records the reported bucket and renders only budget numbers', () => {
    captureRateLimit(
      '/projects',
      headers({
        'RateLimit-Limit': '60',
        'RateLimit-Remaining': '42',
        'RateLimit-Reset': '10',
      }),
      { status: 200 },
    );

    expect(getRateLimitState().budget).toEqual({
      limit: 60,
      remaining: 42,
      resetSeconds: 10,
    });

    const { container } = render(<RateLimitIndicator />);
    expect(container).toHaveTextContent('42 / 60 left');
    expect(container).toHaveTextContent('resets in 10 seconds');

    // Budget numbers only — never a class name, scope, key or bucket.
    const text = container.textContent ?? '';
    expect(text).toMatch(/^\s*\d+\s*\/\s*\d+\s*left/);
    expect(text).not.toMatch(/read|write|account|class|scope|bucket|redis/i);
  });

  it('stays silent when the response carries no rate-limit headers', () => {
    captureRateLimit('/projects', headers({}), { status: 200 });
    expect(getRateLimitState().budget).toBeNull();

    const { container } = render(<RateLimitIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps reporting later responses while leaving the store untouched otherwise', () => {
    captureRateLimit(
      '/projects',
      headers({ 'RateLimit-Limit': '60', 'RateLimit-Remaining': '42' }),
      { status: 200 },
    );
    // A response without headers must not clear a previously reported budget.
    captureRateLimit('/organizations', headers({}), { status: 200 });

    expect(getRateLimitState().budget?.remaining).toBe(42);
    expect(getRateLimitState().budget?.resetSeconds).toBeNull();
  });

  it('gates a throttled path for the indicated delay instead of hammering the limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    captureRateLimit('/projects', headers({ 'Retry-After': '42' }), { status: 429 });
    expect(retryAfterSecondsFor('/projects')).toBeGreaterThan(0);
    expect(retryAfterSecondsFor('/projects?environment=live')).toBeGreaterThan(0);

    // Fail fast: no request is issued while the delay runs.
    const err = await listProjects('test-access-token').then(
      () => null,
      (e: unknown) => e as ApiClientError,
    );
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err?.status).toBe(429);
    expect(err?.message).toMatch(/too many requests/i);
    expect(err?.message).toMatch(/try again in \d+ second/i);
    expect(fetchMock).not.toHaveBeenCalled();

    // Session routes are never gated: the refresh flow must always run.
    expect(retryAfterSecondsFor('/auth/refresh')).toBeNull();
  });

  it('arms the throttle only from a 429 (review L-1)', () => {
    // A non-429 response may carry `Retry-After` (e.g. a proxy's 503); arming
    // the path from it would mask the real error behind "too many requests".
    captureRateLimit('/projects', headers({ 'Retry-After': '42' }), { status: 503 });
    expect(retryAfterSecondsFor('/projects')).toBeNull();
    expect(getRateLimitState().throttledUntil).toEqual({});

    captureRateLimit('/projects', headers({ 'Retry-After': '42' }), { status: 429 });
    expect(retryAfterSecondsFor('/projects')).toBeGreaterThan(0);
  });

  it('keys the throttle by method so a throttled write does not block a read', () => {
    captureRateLimit('/projects/abc/customers', headers({ 'Retry-After': '42' }), {
      status: 429,
      method: 'POST',
    });

    expect(retryAfterSecondsFor('/projects/abc/customers', { method: 'POST' })).toBeGreaterThan(0);
    expect(retryAfterSecondsFor('/projects/abc/customers', { method: 'GET' })).toBeNull();
  });

  it('clamps an absurd Retry-After instead of locking the path for the tab lifetime', () => {
    captureRateLimit('/projects', headers({ 'Retry-After': '2147483647' }), { status: 429 });
    const remaining = retryAfterSecondsFor('/projects');
    expect(remaining).not.toBeNull();
    expect(remaining ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(86_400);
  });

  it('stops gating once the indicated delay has elapsed', () => {
    captureRateLimit('/projects', headers({ 'Retry-After': '30' }), { status: 429 });
    const future = Date.now() + 31_000;
    expect(retryAfterSecondsFor('/projects', { now: future })).toBeNull();
    expect(getRateLimitState().throttledUntil).not.toHaveProperty('GET /projects');
  });

  it('formats delays for people without exposing raw internals', () => {
    expect(formatDelay(1)).toBe('1 second');
    expect(formatDelay(42)).toBe('42 seconds');
    expect(formatDelay(90)).toBe('2 minutes');
    expect(formatDelay(7200)).toBe('2 hours');
  });
});
