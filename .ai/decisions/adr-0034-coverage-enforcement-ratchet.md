# ADR-0034: Coverage Enforcement Ratchet — Baseline Thresholds That Fail Only on Regression

- **Status:** Accepted
- **Date:** 2026-10-09
- **Phase:** 17
- **Scope:** How "comprehensive test coverage" is measured and enforced — what is
  collected, which numbers gate CI, and why the bar is a baseline ratchet rather than a
  target percentage (Phase 17 D2, Q3; F1).

## Context

The roadmap asks for "comprehensive test coverage", but until this phase nothing
defined or enforced it: there was no coverage collection in CI, no threshold, and no
gate (F1). A one-off manual measurement (API ≈ 72.8 % statements, 2026-10-09) was a
number, not a property. The web app had no measurement at all — its provider
(`@vitest/coverage-v8`) was not even installed (F12).

Constraints:

1. **"Comprehensive" must be enforceable**, or the roadmap wording stays aspirational
   (D2(a) confirmed).
2. **The gate must not create red-CI churn.** An arbitrary target (e.g. 80 %) would
   fail immediately on a codebase that is already tested to its current shape; the bar
   for this phase is "no regression", not an arbitrary improvement target (Q3).
3. **The ratchet must be stable across refactors** — a file rename or a move between
   directories must not silently change the measured number (§17).
4. **Only statements and branches gate** (AC10); functions and lines are reported.

## Decision

**Measure coverage for both apps in CI and enforce thresholds set at the measured
baseline rounded down — a ratchet that fails only on regression (D2(a) + Q3, confirmed
2026-10-09).**

- **API (Jest).** `apps/api/jest.config.js` owns both the unit configuration and the
  coverage policy. `collectCoverageFrom` is an explicit allowlist — `src/**/*.ts`
  minus `*.spec.ts` and `*.d.ts` — so production code counts and specs, declarations,
  generated output and config files never do (§17). Baselines measured 2026-10-09
  (unit layer only):

  | Metric | Measured baseline | Threshold (rounded down) |
  | --- | --- | --- |
  | statements | 72.8 % | 72 |
  | branches | 64.91 % | 64 |

- **Web (Vitest).** `apps/web/vitest.config.ts` enables the v8 provider with
  `include: ["app/**", "components/**", "lib/**"]` and `exclude: ["**/*.d.ts"]` —
  application source only; tests and configuration are never counted. Baselines
  measured 2026-10-09:

  | Metric | Measured baseline | Threshold (rounded down) |
  | --- | --- | --- |
  | statements | 95.92 % | 95 |
  | branches | 80.48 % | 80 |

- **Gates.** `pnpm --filter @brinnpay/api test:coverage` and
  `pnpm --filter @brinnpay/web test:coverage` (root convenience:
  `pnpm test:coverage`) run as an explicit CI step (D7(a)); a regression of either
  metric below its threshold fails the build. The measured baseline is recorded next
  to the thresholds — in this ADR and in the comment above each threshold block, the
  place a future maintainer will look before touching the number.
- **Movement rule.** Thresholds move **up** only, and only after re-measuring (`AC10`
  documents the re-measure command). Lowering a threshold requires a stated reason and
  is treated as a reviewable decision, never a routine edit. An improvement never
  silently moves the bar — the number changes because someone decided it should.

## Consequences

- "Comprehensive coverage" is now a defined, CI-enforced property: the suite can grow,
  but it cannot regress unnoticed.
- Adding well-tested code can raise the measured percentage without changing the gate;
  adding untested code to `src` lowers it and turns CI red.
- The numbers are app-specific and honest about what they include: web looks high
  because only `app/`, `components/` and `lib/` count, API looks lower because it
  counts every module of the Nest application including controllers and workers that
  are proven at the e2e layer instead.
- Re-measuring after a large refactor is an explicit, recorded act (this ADR is
  updated alongside the threshold change).

## Alternatives rejected

- **Report-only coverage (D2(b)):** zero red-CI risk, but "comprehensive" then remains
  unenforced — the very gap F1 describes.
- **No coverage metric, criteria-based acceptance criteria only (D2(c)):** rejects the
  roadmap's wording outright; the acceptance criteria in §11 remain necessary but are
  not a substitute for a regression gate.
- **A fixed target (e.g. 80 %) instead of a baseline (Q3 alternatives):** rejected —
  it fails the branch today, measures an aspiration rather than the codebase, and
  invites assertion-padding to reach the number rather than tests that encode the
  specification (rule 1).
- **Counting tests and configuration in `collectCoverageFrom`:** rejected — it makes
  the ratchet move whenever a file is renamed or a test is reorganized (§17 requires
  the opposite).
