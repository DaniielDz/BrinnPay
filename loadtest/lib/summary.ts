/**
 * k6 glue for `handleSummary` (D1).
 *
 * Each scenario exports:
 *
 * ```ts
 * export function handleSummary(data: unknown): Record<string, string> {
 *   return writeSummary({ scenario: 's1-...', profile: {...} }, data);
 * }
 * ```
 *
 * Keeping the projection in `summary-format.mjs` (pure ESM, no k6 imports)
 * is what lets `loadtest/test/summary-format.test.mjs` unit-test the exact
 * bytes that end up in `docs/performance-baseline.md`. This wrapper is the
 * only k6-aware part: it resolves `K6_RESULTS_DIR` (set by the runner to a
 * per-run directory) and hands it to the pure formatter.
 */

import { buildSummaryFiles } from './summary-format.mjs';

export interface SummaryMeta {
  scenario: string;
  profile: Record<string, unknown>;
  notes?: string;
}

export type HandleSummary = (data: unknown) => Record<string, string>;

export function writeSummary(meta: SummaryMeta, data: unknown): Record<string, string> {
  const resultsDir = __ENV.K6_RESULTS_DIR ?? '/results';
  return buildSummaryFiles({ ...meta, resultsDir }, data);
}
