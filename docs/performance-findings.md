# Performance Findings — Phase 19

Findings log for Phase 19 (Performance), per the phase spec §4 rule 4 format.
Every finding carries an explicit disposition: **fixed**, **accepted-with-exit-
criteria**, or **referred to a named owner**. Nothing is dropped.

- **Date:** 2026-10-14
- **Branch / commit:** `feature/phase-19-performance`, measured from `46c2692`
  (+ phase-local harness/fix commits; see the baseline artifact for the exact run
  commit)
- **Spec:** `.ai/phases/phase-19-performance.md` (confirmed 2026-10-14, D1–D9)
- **Runs referenced:** `loadtest/results/run-20261014182659-3e88` (run A),
  `loadtest/results/run-20261014184707-68a4` (run B),
  `loadtest/results/run-20261014191233-c7b4` (run C — committed baseline)
- **Machine:** see `docs/performance-baseline.md` §1 (dev machine; not a capacity
  claim, F7/D3)

Raw result directories are local-only by design (D4): not committed, never in
CI. Only the distilled artifacts (`docs/performance-baseline.md`, this file,
ADR-0038/0039) are committed.

---

## 1. Findings register

### P-01 — Read-time catch-up cost on `GET /payments` (API plane)

- **Area:** `apps/api/src/payments/payments.service.ts` — `list()` advances
  **every** due non-terminal payment of the (project, environment) via
  `catchUpEnvironment()` before assembling the page.
- **Evidence:** S3/S5/S8 list latency tracks the due-payment backlog. All
  three runs show list maxima of **50.3 s / 54.0 s / 59.5 s** in S3 — a
  lock-wait convoy between catch-up CAS updates and the queue-driven sweep
  advancing the same rows (run C: S2 exits with 1 341 open payments; S3's 10
  VUs each run env-wide catch-up over that set while the sweep drains ≈ 18/s).
  Run C was unlucky enough that the convoy consumed VU time wholesale: 38
  requests in 60 s, list med 58.8 s / p95 59.4 s. Steady-state reads are
  unaffected (S3 get med 10–50 ms; S7 read med ≈ 11 ms). The env-wide
  advancement is pinned by `payments.service.spec.ts:292` ("advances every due
  non-terminal payment before assembling the page (D2)") — Phase 7 D2,
  tested and spec-intended: the sweep is the primary driver, read-time
  catch-up the backstop.
- **Disposition:** **accepted-with-exit-criteria + escalation proposal.**
  The tail is proportional to the backlog and to concurrent list requests —
  structurally unbounded, but contract-correct relative to D2. Bounding or
  page-scoping the per-request catch-up (or `SKIP LOCKED` batch semantics)
  would change Phase 7 D2 observable behavior — a specification amendment, not
  a P4 fix — and is therefore **referred to the product authority** with the
  options recorded in ADR-0039; §4 rule 2 forbids applying it silently.
- **Exit criteria:** S3 (list-under-backlog) median > 1 s or p95 > 10 s at
  sandbox volumes on the then-current baseline machine — escalate the
  page-scoped/capped catch-up proposal immediately; otherwise revisit at the
  Phase 22/24 re-baseline.

### P-02 — Request-log write amplification on unmatched-path 404s (D6 / F3)

- **Area:** Phase 11 request logging: any `POST/GET /api/v1/**` path matching no
  route returns 404 without consuming rate-limit budget yet still writes one
  request-log row, post-response, best-effort.
- **Evidence (S6, run C):** a single VU scanned nonexistent paths for 61 s at
  ≈ 171 req/s with a **0% contract-level error rate** (404s are the designed
  answer) and no rate-limit headers on unmatched 404s (10 267/10 267);
  request_logs grew by **10 251 rows / 3.7 MB** during the scenario
  (≈ 6.0 kB/s). Extrapolated sustained scan: ≈ 8.9 M rows/day, ≈ 5.2 GB/day —
  bounded in practice by 30-day retention and by the fact that scans are not
  sustained sandbox traffic. The write is off the response path and does no
  handler work.
- **Disposition:** **accepted-with-exit-criteria + referred proposal** (D6(a)).
  A pre-routing limiter stage or a logging exclusion would change enforcement or
  the Phase 11 completeness control — both are specification changes and are
  forbidden under §4 rule 3 without an explicit product decision. The proposal
  is referred to Phase 20 (delivery of metrics that would make the rate
  observable) and the product authority.
- **Exit criteria:** Phase 20 metrics show anomalous log-write rates in normal
  operation; or any non-sandbox deployment where scan cost becomes material
  relative to infrastructure (Phase 22/24 checkpoint).

### P-03 — Customer substring search: sequential scan by design (D7 / F5)

- **Area:** `apps/api/src/customers/customers.service.ts` — `searchWhere()`
  (`ILIKE '%term%'` over `email`/`name`).
- **Evidence (S4 + `EXPLAIN ANALYZE`):** at the 3 100-row corpus, a common term
  resolves in ≈ 0.24 ms (PK-index early exit) and the worst case (no match →
  full sequential scan) ≈ 8.9 ms; S4 search p95 stayed within the run's band
  (≈ 102 ms including HTTP + auth + request logging). Scaling is linear:
  ≈ 90 ms full-scan at ≈ 31 k rows/env.
- **Disposition:** **accepted, no index** (D7(a) not triggered). Substring
  search is a sequential scan by design below the exit-criteria scale; adding
  `pg_trgm`/GIN speculatively would contradict Phase 6's recorded deferral.
- **Exit criteria:** measured worst-case search p95 exceeding the baseline band
  ×2, or ≈ 30 k customers per environment — whichever comes first; the remedy
  then follows ADR-0011 (owning-phase migration).

### P-04 — Pending-delivery pileup under fail-path endpoints (D5 / F2b)

- **Area:** webhook delivery worker — every seeded project carries one
  fail-path endpoint (`/webhooks/fail/…` → receiver answers 500); deliveries to
  it retry on the Phase 13 attempt ladder (5 attempts, backoff) and end
  `failed`.
- **Evidence (S5, run C):** at run end the queue held ≈ 6 500 pending
  (≈ 7.8 k delayed in BullMQ), oldest pending age ≈ 618 s — consistent with
  the backoff ladder, not with stalled work; `settle-after-s5` took 58.3 s to
  reach quiet (0.9–58.3 s across A/B/C — backlog-dependent); drained
  deliveries ≈ 14 1 k, terminal `failed` ≈ 793 (one terminal failure per
  fail-endpoint delivery after the ladder; receiver saw 38 662 deliveries,
  24 594 of them fail-path retries). The pileup is **self-clearing**: the
  bound already exists per delivery (attempt count), so no delivery retries
  forever. Mechanism (P-11): the webhook consumer is a single BullMQ worker at
  the default concurrency of 1, so deliveries drain serially behind
  advancement work during bursts.
- **Disposition:** **accepted-with-exit-criteria.** A per-endpoint pending
  *bound* (concurrency/queue cap) was Phase 13 D11's referral; it is new
  delivery-model behavior (D5(b) rejected it as unmeasured invention) and
  measurement shows the existing ladder already bounds the work. Referred to the
  delivery-model owner with the escalation options in ADR-0039.
- **Exit criteria:** pending deliveries persisting beyond the ladder horizon at
  steady state (queue not draining), or Phase 20 delivery-health metrics showing
  consumer harm; then the bound is specified, not improvised.

### P-05 — Cross-project sweep fairness (D5 / F2a)

- **Area:** advancement sweep + `requeueDueDeliveries` (global scans).
- **Evidence (S5, run C in-scenario series — the fixed sampler):** S5
  deliberately floods primary 4:1 over secondary (4 VUs vs 1); each project has
  exactly one healthy and one fail-path endpoint, so raw pending-count
  asymmetry (≈ 8 473 vs ≈ 887 at S5 end) is the designed traffic split plus
  fail-path retries — **not starvation**. The starvation signal is per-project
  *oldest-pending-age* parity: throughout S5 the two projects track within
  15–25 s of each other (primary 375→430 s, secondary 355→410 s), i.e. the
  trickle project's deliveries ride the same ladder as the flood project's.
  Run B's end-of-run probe (primary ≈ 892 s vs secondary ≈ 877 s) agrees.
- **Disposition:** **not demonstrated at sandbox volumes → accepted-with-exit-
  criteria** (D5(a)'s explicit path). No sweep/requeue ordering change is made;
  a speculative fairness rewrite without demonstrated starvation was rejected
  (D5(b)).
- **Exit criteria:** secondary (or any) project's oldest-pending age persistently
  exceeding the flood project's ladder horizon at Phase 22 volumes, or any
  project's advancement/delivery latency materially inflated by foreign backlog;
  reopen with Phase 20 metrics before changing selection semantics.

### P-06 — Per-organization members fan-out on web pages (§6 P5 static review)

- **Area:** `apps/web` organizations/home/projects pages call `listMembers` once
  per organization (parallel, bounded by the org count).
- **Evidence:** static review (§3); S7 exercised the session-mode pattern
  (≈ 8.6 req/s dashboard traffic, p95 ≈ 26 ms) without rate-limit interaction
  beyond budget accounting.
- **Disposition:** **accepted.** The fan-out is bounded (single-digit orgs in
  the sandbox), read-only, and parallel; an org-scoped "my role" aggregate would
  be an API surface change (out of this phase's scope — recommendation only).

### P-07 — Background poll collapses "Load more" pages (§6 P5 static review) — **FIXED**

- **Area:** `apps/web/…/payments/page.tsx` — the 3 s poll (active while any
  visible payment is non-terminal) called `loadPayments(null)`, replacing the
  whole list with page 1 and silently discarding rows the user had appended.
- **Disposition:** **fixed in-phase** (small, focused web-side fix per §6 P5 /
  AC5): an `appendedPages` flag makes the poll stand down once the user pages
  deeper; manual **Refresh**, environment change, and create reset it. Covered by
  a new unit test ("stands the background poll down after Load more …") in
  `payments-pages.spec.tsx`; the existing poll-behavior test (D2) is unchanged
  and green (11/11). No API, configuration, or contract semantics changed.

### P-08 — Redundant `retrievePayment` after list refresh (§6 P5 static review)

- **Area:** payments page `onRefresh()` — after `loadPayments(null)` it
  re-reads the open detail row.
- **Disposition:** **accepted.** The detail may not be in the re-fetched page
  window; a single-row authoritative read is deliberate freshness, not a storm
  (one request per user action).

### P-09 — Argon2 password hashing dominates auth latency (S1)

- **Evidence:** register/login p50 ≈ 470 ms, p95 ≈ 0.9–1.1 s on the reference
  dev CPU; AR-3 per-account lockout surfaced as designed (429s after repeated
  failures, ADR-0037 AR-3 — not a finding).
- **Disposition:** **accepted.** Cost of password hashing under the Phase 3
  parameters; not tunable without a security decision. Re-measured at Phase
  22/24 re-baselining on deployment-class hardware.

### P-10 — Harness methodology defects (fixed before the baseline run)

- Receiver `pathKey` returned the path string instead of the counter object →
  every second delivery to a path crashed the process (run 1, all deliveries
  failed). Fixed + pinned by `loadtest/test/receiver.test.mjs` (regression
  test).
- The runner's `spawnSync` of k6 blocked the event loop for each scenario's
  whole duration → the 5 s worker/DB sampler recorded **zero in-scenario
  samples** in runs A/B (S5 fairness evidence was settle-only). Fixed via
  async spawn; run C carries in-scenario samples.
- k6's summary export displays `http_req_failed` *fails* counts that overstate
  failures (rate = 0 is authoritative; process exit codes were 0). Recorded as a
  methodology note in the baseline artifact: **error rate + exit code are the
  pass/fail authority, not the summary fails column.**

### P-11 — Observability and delivery lag under write bursts (new finding, run C)

- **Area:** (a) request-log ingestion — `RequestLogStoreService.write` is a
  post-response, in-process Prisma insert; (b) webhook delivery consumption —
  a single BullMQ worker at the default concurrency of 1
  (`@Processor(WEBHOOK_QUEUE_NAME)` with no explicit concurrency).
- **Evidence (run C):** request_logs stayed frozen at 4 981 rows for the **entire
  60 s S3 window** (the inserts stalled behind the same DB lock/pool convoy
  that stalled the catch-up lists, then flushed in S4: 5 090 → 5 865 within
  10 s); deliveries pending *grew* 6 276 → 8 368 during S3 while the serial
  consumer worked through advancement-dominated queues.
- **Disposition:** **accepted-with-exit-criteria + referred.** Completeness is
  preserved (rows landed; deliveries drain; Phase 11 best-effort durability
  contract holds) — this is latency of observability data, not loss. The
  remedies (raising worker concurrency, separating queue consumers) are Phase
  10 topology/configuration decisions, not silent Phase 19 tuning: they would
  change the just-measured baseline and touch ordering assumptions that belong
  to the delivery model's owner. Referred to Phase 20 (metrics for queue lag
  and log-ingestion delay) and the Phase 10/13 owner, with ADR-0039 binding.
- **Exit criteria:** log-ingestion lag or delivery drain times observably
  harming operators or dashboards at Phase 22 volumes; or Phase 20 metrics
  showing sustained queue lag.

---

## 2. Answers to the §6 P3 questions (explicit, evidence-backed)

1. **Worker fairness / starvation (F2a):** not demonstrated at sandbox volumes
   — per-project oldest-pending ages track the same retry ladder under a
   deliberate 4:1 flood (P-05). Accepted with exit criteria; no code change.
2. **Request-log amplification materiality (F3):** measured and material in
   absolute scan rates (≈ 10.3 k rows / 3.7 MB per minute sustained while
   scanning, extrapolated ≈ 8.9 M rows/day) but bounded by best-effort
   post-response writes and 30-day retention; the contract-level error rate of
   the scan is 0 by design (P-02). Accepted with exit criteria and a referred
   proposal; no code change.
3. **Customer search degradation (F5):** not demonstrated at corpus volumes
   (P-03); linear projection and a numeric exit criterion are recorded. No index.

## 3. S7 dashboard-usage review record (AC5)

- **Load evidence:** S7 (10 VUs × 90 s, session-mode read/write mix mirroring
  dashboard behavior) — numbers in `docs/performance-baseline.md`.
- **Static review of `apps/web` fetch patterns** (all findings dispositioned in
  §1): P-06 (org members fan-out), P-07 (**fixed**), P-08 (detail re-read);
  positives recorded — 300 ms debounced customer search, sequential
  `retrieveProject → listMembers` (data-dependent, not an N+1), single list
  reload on environment re-scope, poll self-stopping when nothing is
  non-terminal, no request storms.
- **Fix verification:** web unit suites (`payments-pages.spec.tsx` 11/11 green,
  incl. the new regression test and the untouched D2 poll test).

## 4. Inbound finding dispositions (§3 F1–F11, AC6)

| # | Finding | Disposition |
| --- | --- | --- |
| F1 | No load-testing capability | **Fixed** — k6 harness (D1), scenario catalog S1–S8 (D2), baseline artifact (D3), runbook entry; see ADR-0038. |
| F2a | Sweep fairness referral (ADR-0037) | **Not demonstrated → accepted-with-exit-criteria** (P-05). |
| F2b | Pending-delivery bound referral (ADR-0037) | **Accepted-with-exit-criteria; bound referred** (P-04, ADR-0039). |
| F3 | Request-log amplification mandate | **Measured; accepted-with-exit-criteria + referred proposal** (P-02, ADR-0039). |
| F4 | Rate-limit interaction | **Handled** — every scenario uses documented env overrides (compose/API env: raised `RATE_LIMIT_*`/`AUTH_RATE_LIMIT_*` for the load stack); catalog and algorithm untouched; defaults unchanged. |
| F5 | Customer search index handover | **Measured; accepted, no index** (P-03). |
| F6 | No performance targets (Q1) | **Waived; D3(a) invoked** — baseline-then-record, no invented SLOs (ADR-0038). |
| F7 | No measurement environment | **Framed** — dev-machine baseline is regression-relative only; environment documented; re-baseline obligation for Phases 22/24 recorded (ADR-0038). |
| F8 | Phase 18 control baseline survives | **Verified** (§5 below, AC8). |
| F9 | Dashboard usage pattern | **Reviewed** — S7 ran; static review recorded (§3). |
| F10 | Two-plane system | **Observed** — S5 samples both planes (API + worker counters every 5 s in-scenario since run C); baseline reports both. |
| F11 | Volume seeding discipline | **D9** — bulk SQL seeder (direct `COPY`/insert into the compose DB, API-scaffolded users/projects/keys/endpoints), local-only, credentials in gitignored state files only; the Phase 17 API-fixture rule is explicitly not weakened (load fixtures are not functional-test fixtures). |

## 5. Security posture check (§8, AC8)

Verified intact after this phase — no control disabled, bypassed, or relaxed:

- **Rate limiting:** scenarios raise limits only via documented env overrides on
  the dedicated load compose project; the limiter code path, class catalog, and
  defaults are untouched; AR-3 lockout behavior was *exercised*, not weakened.
- **Request logging:** completeness retained (S6's finding is about volume, not
  about removing rows; no exclusion was implemented).
- **HMAC signing / authorization / tenancy:** untouched by the harness (it acts
  as a normal API consumer with seeded credentials) and by the only product fix
  (web poll, no server change).
- **ADR-0037 register (AR-1/AR-2/AR-3):** unchanged; S1's 429s are AR-3 working
  as accepted.
- **Secrets/PII:** seeds and state files contain credentials only in gitignored
  local files (`loadtest/.state/`, `loadtest/results/`); no secrets in scripts,
  artifacts, or these documents; receiver never logs or echoes payloads.
