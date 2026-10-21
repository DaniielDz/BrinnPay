# ADR-0039: Phase 19 Disposition Register — Availability, Amplification, and Search-Index Posture

- **Status:** Accepted
- **Date:** 2026-10-14
- **Phase:** 19
- **Scope:** The measured dispositions of the three inbound obligations Phase 19
  owned (ADR-0037 F2 referrals, Phase 13 F12 mandate, Phase 6 §4.5 handover):
  sweep fairness, pending-delivery bounding, request-log amplification, and
  customer-search indexing. Mirrors the ADR-0037 accepted-risk register pattern
  at phase scope so **Phase 20** (metrics) and **Phases 22/24** (deployment)
  inherit the posture deliberately.

## Context

Phase 19 §3 required resolving — not silently inheriting — F1–F11. Three of
them were conditional dispositions that measurement had to settle (D5, D6, D7):
fixing them speculatively would have invented product behavior (per-delivery
delivery-model changes, enforcement stages, index migrations) that the
specification never approved; dropping them would have left named-owner
referrals unanswered. The full evidence is in `docs/performance-findings.md`
(P-02…P-05, P-03); this ADR binds the decisions.

Constraints:

1. §4 rule 3: no control weakened to close a finding; acceptance carries
   rationale, blast radius, and exit criteria.
2. D5/D6/D7 all required measurement first; fixes without measurement were
   explicitly rejected (D5(b), D6(b), D7(b)).
3. Any remedy that changes observable behavior is a specification amendment
   (product authority), never a silent in-phase act.

## Decision

### Accepted posture (with exit criteria)

| Id | Obligation | Disposition | Exit criteria (reopen trigger) |
| --- | --- | --- | --- |
| PR-1 | Sweep/requeue cross-project fairness (F2a; ADR-0037) | **Not demonstrated at sandbox volumes — accepted.** Under the deliberate 4:1 flood, per-project oldest-pending ages track the same retry ladder (findings P-05). No ordering/selection change made. | Any project's oldest-pending age or advancement/delivery latency persistently inflated by foreign backlog at Phase 22 volumes, or visible in Phase 20 delivery metrics. Remedy then = explicit selection-semantics change (ordering/bounding) with L2 tests. |
| PR-2 | Per-endpoint pending-delivery bound (F2b; ADR-0037) | **Accepted as bounded-by-attempt-ladder; the *bound* itself referred.** Measurement showed self-clearing pileups (5-attempt ladder → `failed`, findings P-04); an added concurrency/queue cap is new delivery-model behavior and stays referred to the delivery-model owner. | Pending deliveries persisting beyond the ladder horizon at steady state, or Phase 20 metrics showing consumer harm; then the bound is specified with the delivery model (Phase 13 D11's classification), not improvised here. |
| PR-3 | Request-log write amplification on unmatched 404s (F3; Phase 13 D12/§16, ADR-0024) | **Measured and accepted-with-exit-criteria** (findings P-02): ≈ 24 k rows / 11 MB per minute of sustained scanning at ≈ 179 req/s, zero rate-limit spend, post-response best-effort writes, 30-day retention bounds growth. Any remedy (pre-routing limiter stage, logging exclusion) is a specification change — referred with proposal, never applied silently (D6(a)/(c), §4 rule 3). | Phase 20 metrics show anomalous log-write rates in normal operation; or a non-sandbox deployment where scan cost is material relative to infrastructure (Phase 22/24 checkpoint). Referred owner: Phase 20 metrics + product authority. |
| PR-4 | Customer substring search index (F5; Phase 6 §4.5) | **Accepted, no index** (findings P-03): sequential scan by design below the exit-criteria scale (worst-case ≈ 8.9 ms at 3 100 rows; common-term ≈ 0.24 ms via early exit). | Worst-case search p95 exceeding the baseline variance band ×2, or ≈ 30 k customers per environment. Remedy then = `pg_trgm` GIN index via owning-phase migration (ADR-0011), justified by the recorded numbers. |
| PR-5 | Read-time catch-up cost on list (new, P-01) + observability/delivery lag (new, P-11) | **Accepted as Phase 7 D2 / Phase 10 topology behavior; proposals referred.** S3 list shows a lock-wait convoy (max 50.3–59.5 s across all three runs; run C p95 ≈ 59 s) between env-wide catch-up and the sweep; request-log inserts and deliveries lag behind the same bursts (frozen log counter for a full scenario window; serial single-concurrency webhook consumer). Contract correctness is unaffected (checks 1.0, completeness preserved). | S3 list median > 1 s or p95 > 10 s at sandbox volumes (catch-up); log-ingestion lag or delivery drain observably harming operators (P-11); or Phase 20 metrics showing sustained queue lag. Referred owners: product authority (catch-up amendment), Phase 10/13 owner + Phase 20 (worker topology/metrics). |

### Also bound

- **The one in-phase optimization** (findings P-07): the dashboard payments
  poll stands down after "Load more" so it cannot collapse appended pages.
  Small, web-side, no API/config semantics, covered by the web unit suites
  (AC5); needs no ADR of its own (Phase 18 no-ADR precedent for semantics-
  preserving changes) and is recorded in the baseline/findings artifacts.
- **P-01 (read-time catch-up cost)** and **P-11 (observability/delivery lag)**
  are accepted as Phase 7 D2 / Phase 10 topology behavior with exit criteria in
  the findings register; their remedies (page-scoped/capped catch-up; worker
  concurrency/consumer separation) are referred — the first to the product
  authority as a possible future spec amendment (it is pinned by
  `payments.service.spec.ts` and is not a P4 fix), the second to the Phase
  10/13 owner with Phase 20 metrics as the trigger. See PR-5.

## Consequences

- Phase 20 inherits four named, criteria-backed reopen triggers and can attach
  metrics to each (delivery health, log-write rate, fairness ages, search
  latency).
- Phases 22/24 inherit the same triggers plus the re-baseline obligation
  (ADR-0038); nothing here forbids fixing any of PR-1…PR-4 when its criteria
  fire — it forbids *silent* fixing without them.
- The Phase 11 logging-completeness control and the Phase 13 delivery model are
  unchanged; their open questions have a single owner each instead of being
  re-derived.

## Alternatives considered

- **Fix fairness/bound now (D5(b)):** rejected — unmeasured invention against
  Phase 13's explicit classification and the no-silent-scope rule.
- **Bound amplification via pre-routing stage or log exclusion (D6(b)/(c)):**
  rejected — enforcement/completeness changes require an explicit product
  decision; D6(c) outright forbidden under §4 rule 3.
- **Add `pg_trgm` unconditionally (D7(b)):** rejected — speculative optimization
  against Phase 6's recorded deferral.
- **Measure-only, refer everything (D5(c)):** rejected — would leave named-owner
  referrals without the disposition this phase exists to make.
