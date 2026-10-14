# ADR-0038: Load-Test Harness and Baseline Procedure (Phase 19 D1/D3/D4)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Phase:** 19
- **Scope:** How BrinnPay is load-tested, where the baseline lives, what the
  standing performance guardrail is, and who re-baselines it — so Phases 22/24
  (deployment environments) and Phase 26 (regression re-runs) inherit the
  procedure instead of re-deriving it.

## Context

Phase 19 opened with no load-testing capability at all (F1): no scripts, no
scenarios, no numbers, no targets (F6 — Q1 waived, D3(a) invoked), and no
measurement environment beyond local compose (F7). "Performance" was an
unmeasured claim. The phase had to produce a reproducible baseline without
inventing business requirements (AGENTS.md), without touching CI (D4), and
without turning a developer machine into a capacity claim (F7).

Constraints:

1. **No invented SLOs** (F6/D3): absolute targets like "p95 < 200 ms" would be
   business requirements the product never specified.
2. **Local-only by design** (D4): load runs are manual; nothing here may run in
   CI or gate merges.
3. **Reproducibility with honest variance** (AC11): a dev machine (shared, old
   CPU) produces honest p50s but volatile tails for backlog-coupled work.
4. **Security posture intact** (F8/§8): the harness is an ordinary API
   consumer; it may configure rate limits via documented env overrides only.

## Decision

### 1. Tool and home (D1)

**k6 (grafana/k6:2.3.0) runs the catalog from `loadtest/`** — TypeScript
scenarios (`loadtest/scenarios/`), shared libs (`loadtest/lib/`), a Node seed
and runner (`loadtest/scripts/`), and a disposable local webhook receiver.
k6 was chosen over autocannon/artillery for its threshold model, scenarios API,
and containerized execution. The harness is a workspace package
(`@brinnpay/loadtest`): linted, typechecked, unit-tested (node:test), and
validated per run with `k6 inspect` on every scenario.

### 2. One documented command sequence

`pnpm loadtest` (root; `node loadtest/scripts/run.mjs`) is the runbook entry
point: it resets a dedicated compose project (`brinnpay-loadtest`, isolated
ports/network), migrates, starts workers, seeds per D9, runs S1–S8 in order,
samples API/worker/DB state every 5 s **in-scenario** (async runner — a
`sampler-starvation` bug in earlier runs is regression-tested by design notes),
and tears down. Results land in gitignored `loadtest/results/<run-id>/`; the
seeded credentials live only in gitignored `loadtest/.state/`.

### 3. Baseline artifact (D3)

**`docs/performance-baseline.md` is the committed baseline** (Phase 18 D3
precedent: distilled evidence in `docs/`, raw runs local-only). It records the
environment (machine, versions, commit, date), the per-scenario numbers (S1–S8:
throughput, p50/p95 per key operation, error rates), worker-plane counters,
the variance band, and the guardrail wording. The paired findings register is
`docs/performance-findings.md` (§4 rule 4 format).

### 4. Standing guardrail — baseline-then-record (D3(a))

**The guardrail is: no regression beyond the recorded variance band + a
near-zero contract-level error rate** on the same machine class, same procedure.
There are no absolute SLOs. Tails of backlog-coupled operations (e.g. list
during catch-up windows, P-01) are informational on this machine class; p50 and
throughput are the comparable series. If absolute targets ever emerge, they are
a specification amendment replacing this guardrail.

### 5. Re-baseline obligations

- **Phases 22/24** re-baseline on deployment-class hardware and become the
  capacity numbers; this artifact remains the local regression-relative
  baseline until then.
- **Phase 26** regression re-runs follow this procedure and compare against the
  band, explaining deviations in the rerun record.

### 6. Local-only targeting rule (D4)

Load scenarios raise rate limits via documented env overrides on the load
compose project (F4/AC7) so the limiter does not distort measurements; the
class catalog, algorithm, and **defaults are untouched**. Nothing in
`loadtest/` is imported by CI workflows, and no merge gate depends on it.

## Consequences

- Performance claims in this repository are always relative to a recorded,
  dated, committed baseline — never absolute.
- Re-baselining is a documented procedure, not folklore.
- The two accepted-risk dispositions that came out of the measurement (D5
  fairness/pending-bound, D6 amplification, D7 search index) are bound in
  **ADR-0039**; this ADR owns only the procedure.
- Local raw runs stay local (no artifact bloat, no PII/secret leakage into git).

## Alternatives considered

- **Absolute SLOs now (D3(b)):** rejected — invents business requirements.
- **Measure with no committed baseline (D3(c)):** rejected — "optimize
  bottlenecks" and Phase 26 regressions need a recorded bar.
- **Wire load tests into CI (D4 alternative):** rejected — dev-machine numbers
  are not merge-grade; cost and flakiness outweigh value.
- **Functional-harness reuse (Phase 17):** rejected — the Phase 17 harness is a
  correctness tool (§3 F11); volume seeding deliberately follows D9 instead.
