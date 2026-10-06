'use client';

import { useSyncExternalStore } from 'react';

import {
  formatDelay,
  getRateLimitState,
  subscribeRateLimitStore,
} from '../../lib/brinnpay/rate-limit';

/**
 * Compact rate-limit budget indicator (phase 14 §7.4, D8; phase 13 §7).
 *
 * Renders the reported bucket's remaining budget after API responses that
 * carry `RateLimit-*` headers and stays **silent** — never an error — when no
 * response has reported one (older proxy, excluded route, failed preflight).
 * Only budget numbers are shown: no rate-limit class, scope, discriminator or
 * key may ever appear in the UI (phase 13 §4.4 point 5).
 */
export function RateLimitIndicator() {
  const state = useSyncExternalStore(
    subscribeRateLimitStore,
    getRateLimitState,
    getRateLimitState,
  );
  const budget = state.budget;

  if (!budget) return null;

  return (
    <span className="rate-limit-indicator" title="API requests left in the current window">
      <span className="rate-limit-remaining">{budget.remaining}</span>
      <span> / {budget.limit} left</span>
      {budget.resetSeconds !== null ? (
        <span className="rate-limit-reset"> · resets in {formatDelay(budget.resetSeconds)}</span>
      ) : null}
    </span>
  );
}
