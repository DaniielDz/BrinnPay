# Phase 19 — Performance

| | |
| --- | --- |
| Phase | 19 — Performance |
| Status | **Implemented (2026-10-14).** D1–D9 confirmed by the product authority (2026-10-14); Q1 waived — D3(a) baseline-then-record invoked. Harness, S1–S8 catalog, baseline (`docs/performance-baseline.md`), findings register (`docs/performance-findings.md`), ADR-0038/ADR-0039 shipped; required checks green. Pending: PR review/merge. |
| Depends on | Phase 1 (API conventions, pagination, error envelope), Phase 2 (compose stack, health/readiness endpoints, structured logging), Phases 3–13 (the surface under test — auth/sessions, RBAC/tenancy, projects/API keys, customers, payments + simulation, idempotency, refunds, webhooks + worker topology, request/audit logs, and rate limiting including its explicit Phase 19 coordination obligations), Phase 14 (the dashboard whose API usage pattern §6 P5 reviews), Phase 15 (local-development guide — the runbook's documentation home), Phase 16 (sandbox scenarios, scenario-aware sweep filter), Phase 17 (test harness, data-setup patterns, required checks — load tests reuse the patterns, not the harness), Phase 18 (the verified control baseline this phase must not weaken; ADR-0037 accepted-risk register), ADR-0001…ADR-0037 |
| Blocks | Phase 20 (bottleneck findings inform which metrics matter first; the F12 amplification disposition is shared), Phase 22/24 (re-baselining obligation on real environments; any deployment-relevant tuning facts recorded here become deployment inputs), Phase 26 (release QA may re-run the regression scenarios as a pre-release sanity gate) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 19 |
| Branch | `feature/phase-19-performance` |

## 1. Objective

**Validate BrinnPay's performance under load and optimize demonstrated bottlenecks.**
Establish the project's first measured performance baseline, identify bottlenecks with
evidence, apply behavior-preserving optimizations where the evidence justifies them,
and discharge every performance-related handover prior phases filed into this one
(§3 F2–F5).

Like Phases 17–18, this is a *verification* phase: it adds load-test tooling, scenario
definitions, a baseline artifact, findings, focused fixes, and documentation — not
product features. Where a finding's remedy would require **new product behavior**, a
contract change, or the weakening of a verified control, the escalation rules in §4
apply: escalate with options, do not invent.

### Roadmap traceability

| Roadmap Phase 19 checkbox | Where |
| --- | --- |
| k6 load testing scripts | §6 P1, D1, AC1 |
| Load test scenarios | §6 P2, D2, AC2 |
| Bottleneck identification | §6 P3, D3, AC3 |
| Performance optimization | §6 P4, AC4 |
| Review API performance under dashboard usage | §6 P5, D8, AC5 |

## 2. Scope

In scope:

- **The k6 load-testing harness** (D1): committed scripts, one documented command to
  run the full catalog against the local compose stack, and a runbook entry in the
  Phase 15 local-development guide style.
- **The scenario catalog** (D2, §6 P2): a bounded, named set of scenarios covering the
  API's critical read/write paths, the webhook worker plane, the request-log
  amplification case, and the dashboard-usage emulation.
- **A measured baseline artifact** (D3): per-scenario latency distribution, throughput,
  and error rate on a documented reference environment, committed to the repository,
  with the environment, date, and commit recorded.
- **Bottleneck identification** (§6 P3): a findings log where every claim carries
  recorded numbers from a committed scenario — the Phase 18 evidence discipline
  applied to performance.
- **Behavior-preserving optimizations** (§6 P4) for findings above the disposition bar,
  each with before/after evidence and a green Phase 17 suite.
- **Discharge of every explicit Phase 19 handover** (§3 F2–F5): the F13 availability
  referrals (per-project sweep fairness, pending-delivery bound) via measurement and
  conditional disposition (D5); the F12 request-log write-amplification measurement
  (D6); the Phase 6 customer-search indexing question (D7); the Phase 13 rate-limit
  load-test configuration obligation (§6 P2, AC7).
- **The dashboard-usage API review** (§6 P5, D8): an API-level scenario emulating the
  dashboard's actual request pattern plus a static review of `apps/web` fetch patterns
  for defective usage (accidental N+1, over-fetching).

Explicitly **not** in scope (§12): product features, contract changes, observability
infrastructure (Phase 20), production capacity planning and AWS sizing (Phase 24),
CI scheduling of load tests beyond what D4 confirms, frontend rendering performance,
rate-limit algorithm changes (sliding window etc.), speculative caching, re-baselining
on staging/production (Phases 22/24), release QA (Phase 26), and ROADMAP.md
bookkeeping beyond this phase's own checkboxes (report-only; `chore/*` at merge —
Phase 16 Q2 / Phase 18 F14 precedent).

## 3. Context and current-state findings

**What exists today** (Phases 0–18; branch `feature/phase-19-performance`):

- **API:** NestJS modular monolith — auth, organizations/RBAC, projects/API keys,
  customers, payments (deterministic simulation, CAS advancement, scenario-aware
  sweep filter), idempotency, refunds, webhooks (in-transaction event persistence,
  BullMQ delivery, HMAC signing, retry ladder, replay), request logging
  (post-response best-effort writes on `finish`), audit logging, rate limiting (two-
  stage, fixed-window Redis counter, closed class catalog). Single API process plus a
  dedicated worker process (ADR-0018) running the advancement sweep
  (`advanceDuePayments`, bounded batch 100, partial-index ordered), reconciliation
  (batch 200), requeue (`requeueDueDeliveries`, batch 200, ordered by `createdAt`
  across all projects), and retention passes.
- **Web:** single Next.js app; dashboard is a session-authenticated client of the
  same API, pagination-heavy (cursor lists for payments, customers, refunds, webhook
  events/deliveries, request logs, audit logs) with an environment selector.
- **Infra:** local docker compose (`docker/compose.yml`): postgres:17, redis:7, api,
  worker, web. Health/readiness endpoints exist and are excluded from rate limiting.
- **Tooling:** no load-testing tool, script, or performance artifact exists anywhere
  in the repository (verified by search). The Phase 17 harness (L1–L8) is
  functional-correctness tooling, not a load harness.
- **Baseline controls that load tests must respect:** rate-limit classes with env-
  configurable numbers (`RATE_LIMIT_*`, `AUTH_RATE_LIMIT_*`); request-log write per
  request under `/api/v1` including unmatched-path 404s; in-transaction webhook
  event/delivery fan-out on payment create; per-account login lockout (ADR-0037 AR-3).

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | No load-testing capability exists: no scripts, no scenarios, no baseline, no performance numbers anywhere in the repo or specs. "Performance" is currently an unmeasured claim. | §6 P1–P3, D1–D3. |
| F2 | **F13 referrals (ADR-0037 re-ownership):** Phase 13 D11 referred onward two availability defects with this phase as the named owner — a **pending-delivery bound per webhook endpoint** and **per-project fairness in the worker sweeps** (the advancement sweep and `requeueDueDeliveries` are global scans; one project's backlog can starve another's). Phase 10 classified the fairness defect as availability, not abuse prevention. | D5 — measure under S5; conditional disposition. |
| F3 | **F12 measurement mandate (Phase 13 §16, ADR-0024):** request-log write amplification must be measured. One case is reachable today: a request under `/api/v1` matching no route returns 404 **without consuming rate-limit budget** yet is still request-logged — a scan of nonexistent paths writes a row per request while spending no budget and doing no handler work. Bounding it needs a pre-routing limiter stage or a logging exclusion; both were beyond Phase 13's approved scope. | D6 — measure under S6; disposition recorded. |
| F4 | **Rate-limit interaction (Phase 13 §6.2/§16):** load-test scenarios must set their own limits (raise via env) so the limiter does not distort measurements; conversely, default limit numbers may be revisited **only if measurement justifies it** (config change, never code); any change to the class catalog or algorithm is a specification amendment, not a tuning act. | §6 P2, AC7; §12. |
| F5 | **Customer search indexing (Phase 6 §4.5 handover):** substring search on `email`/`name` deliberately has no dedicated index ("datasets are small — performance is Phase 19"). The question of whether search-at-scale needs a `pg_trgm`/GIN index (owning-phase migration per ADR-0011) or stays a sequential scan by design lands here. | D7 — measure under S4; conditional index migration. |
| F6 | **No performance targets exist** in the master specification or any phase spec: no SLOs, no target scale (customers/payments per project, requests per second), no reference hardware. This phase must not invent business requirements (AGENTS.md). | Q1 requested; D3 defines the baseline-then-record fallback. |
| F7 | **No measurement environment exists** beyond local compose; Phases 22/24 create the real ones. A baseline recorded on a developer machine is not a capacity claim. | D3 — baseline framed as regression-relative, environment documented, re-baseline obligation recorded for Phases 22/24. |
| F8 | **Phase 18's verified control baseline (ADR-0037)** must survive this phase: request logging, rate limiting, HMAC signing, authorization, tenancy — optimizations must not disable, bypass, or relax any of them, in scenarios or after fixes; AR-1/AR-2/AR-3 accepted risks are not to be "improved" by silent scope creep. | §4 rule 3, §8. |
| F9 | **Dashboard usage pattern** (the last checkbox's target) is session-mode, pagination-heavy list reads plus the request/audit log viewers, an environment selector that re-scopes lists, and dashboard-driven writes (payment create form). It is an API-usage pattern, not a rendering question. | §6 P5, D8, AC5. |
| F10 | **Two-plane system:** payment creates (API plane) translate into sweep work and deliveries (worker plane) via Redis/BullMQ (ADR-0018). API-only load numbers would miss worker-plane bottlenecks (sweep backlog, delivery lag), and worker fixes must not be inferred from API latency alone. | §6 S5 observes both planes. |
| F11 | Load-test volume fixtures need thousands of corpus rows; the Phase 17 API-driven-fixture rule binds functional suites and is impractical for volume. A deliberate, bounded seeding decision is needed rather than an accidental violation of the established data discipline. | D9. |

## 4. Domain rules (normative)

1. **The contract is canonical (ADR-0012) and behavior-preserving is the bar.**
   Every optimization must keep statuses, error codes, headers, pagination semantics,
   event/audit/log coverage, and security behavior exactly as published; the Phase 17
   suite staying green is the regression net, and any semantic change is a defect fix
   citing the specification that made the old behavior wrong — or an escalation.
2. **Escalation over invention (Phase 18 rule 2).** A finding whose remedy requires
   new product behavior (e.g. a new pending-delivery bound state), a contract change,
   or a specification amendment (e.g. a rate-limit catalog change) is escalated to the
   product authority with options — never silently implemented, never closed by
   weakening a test or a control.
3. **No control may be weakened for a number (Phase 18 rule 3).** Security controls
   (request logging, rate limiting, HMAC, authorization, tenancy) stay enabled in
   every scenario and after every fix. If a control is itself the bottleneck, that is
   a finding to disposition explicitly — not something to switch off, sample away, or
   "temporarily" bypass in the committed scripts.
4. **Evidence over anecdote.** A bottleneck is a finding only when a committed
   scenario's recorded numbers demonstrate it on the documented reference environment
   (D3). "Felt slow", profiler screenshots with no artifact, and numbers from an
   undocumented setup do not count. Findings carry: scenario id, metric, measured
   value, disposition (fix / accept with exit criteria / refer to named owner).
5. **Optimize only what is measured, and prove the fix.** Each optimization ships
   with before/after numbers from the same scenario and a green full Phase 17 suite;
   speculative hardening or restructuring "for performance" without a finding is out
   of scope.
6. **Load tests run against the local stack only.** Never against a shared, staging,
   or production deployment (Phase 18 §8 rule 5 pattern). The scripts must not carry
   targets other than the documented local endpoints.
7. **Handovers are discharged or re-owned, never dropped.** Every §3 finding (F1–F11)
   and every inbound coordination obligation ends the phase with an explicit
   disposition: fixed, accepted-with-exit-criteria, or referred to a named owner.
8. **The phase's own work obeys the checks it reports on.** Scripts, fixes, and
   artifacts pass `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`,
   `pnpm test:e2e`, `pnpm build` (AGENTS.md); no secrets, credentials, or PII in
   scripts, fixtures, results, or documents.

## 5. API behavior

**No API surface changes are planned.** No new endpoints, no contract schema changes,
no rate-limit class catalog changes, no pagination or error-envelope changes.

What the phase may change, narrowly:

- **Internal, behavior-preserving optimizations** justified by §6 P3 findings
  (query shape, index additions per D7, N+1 removal, bounded-work adjustments) —
  the observable contract is unchanged and the Phase 17 suite proves it.
- **Worker-internal changes** (sweep selection strategy per D5) that change no
  contract, no event catalog entry, and no domain rule — again proven by the existing
  suites plus targeted new tests.
- **Configuration defaults** (e.g. rate-limit numbers per §6 P2/AC7) — configuration
  only, documented in compose/`.env.example`, never a code-path change; default-value
  changes are recorded in the baseline artifact with rationale.

Everything published in `docs/openapi.yaml` — statuses, error codes, auth modes,
capabilities, headers — stays exactly as is.

## 6. Performance work catalog (normative)

Each area (P1–P5) maps to a roadmap checkbox. P1/P2 build the instrument; P3/P4 use
it; P5 is the dashboard-specific review.

### P1 — k6 load-testing scripts (D1)

- Committed k6 scripts with a single documented entry point runnable from the
  repository root against the local compose stack (stack up, seed, run, collect
  results, tear down/reset per the documented procedure).
- Scripts authenticate like real clients: API keys created through the API
  (API-key mode) and session tokens obtained through the auth endpoints (session
  mode) — no fixture backdoors, no bypass of authentication or authorization (§8
  rule 3).
- Results (summary metrics per scenario) are produced in a machine-readable form the
  baseline artifact (D3) can cite, plus a human-readable summary.

### P2 — Load test scenarios (D2)

A bounded, named catalog (the D2-confirmed set below). Every scenario
documents: purpose, endpoints and auth mode, data volume, VU/duration profile
(fixed and committed — not ad hoc), rate-limit posture (own env limits per F4/AC7),
the metric(s) it exists to observe, and the findings it was built to test (if any).

| # | Scenario | Plane | Exists to observe |
| --- | --- | --- | --- |
| S1 | Auth & session | API | Registration/login latency and behavior under multi-account load; expected `429`s under the per-account scope (AR-3) are documented, not "fixed". |
| S2 | Payments write | API | Payment create at volume (mixed plain and `Idempotency-Key` retries); write-class limiter interaction; in-transaction event/delivery fan-out cost as endpoint count grows. |
| S3 | Payments read | API | Retrieve and cursor list at corpus volume, including read-time catch-up interplay with the sweep. |
| S4 | Customers list & search | API | Cursor pagination and substring search at corpus volume — the F5/D7 evidence. |
| S5 | Webhook plane throughput | Worker | Payment creates with registered endpoints → delivery to a local receiver; queue depth, sweep/requeue lag, cross-project starvation (F2/D5 evidence), pending-delivery pileup (F2/D5 evidence). Multi-project by design. |
| S6 | Unmatched-path scan | API | Unauthenticated scan of nonexistent `/api/v1` paths: request-log row-per-request amplification with zero budget consumed (F3/D6 evidence). |
| S7 | Dashboard-usage emulation | API (session mode) | The dashboard's actual request mix (F9): session-authenticated list/retrieve pagination, environment re-scoping, log viewers — the F9/P5 evidence. |
| S8 | Mixed steady-state | API + Worker | A representative read/write mix with endpoints registered — the standing regression scenario for D3 baselines and Phase 26 re-runs. |

Sandbox `decline`/`timeout` scenarios (Phase 16) are exercised only where a scenario
needs their effects (e.g. S5 failure/retry paths); they are not re-simulated for
their own sake.

### P3 — Bottleneck identification

- Run the catalog, record the baseline (D3), and produce a findings log (§4 rule 4
  format) covering both planes (F10): API latency/throughput/error rate, and worker
  indicators (queue depth, sweep pass duration, delivery lag) observable from the
  local stack without a metrics stack (Phase 20 owns durable metrics).
- Classify each finding: **fix in this phase** (small, behavior-preserving),
  **accept with exit criteria** (sandbox-scale acceptable; criteria name the scale
  or environment that reopens it), or **refer** (named owner: Phase 20/22/24/26 or
  backlog).
- Specific questions the findings must answer: does cross-project starvation occur
  under S5 at sandbox-realistic volumes (F2)? Is the request-log amplification of S6
  material against the local Postgres at scan rates an unauthenticated actor can
  realistically reach (F3)? Does customer search degrade acceptably at the corpus
  volumes S4 uses (F5)?

### P4 — Performance optimization

- Only for findings dispositioned **fix**. Each fix: minimal, riding the existing
  architecture (modular monolith, Prisma, BullMQ, Redis — no new frameworks, no
  microservices, no caching layer introduced speculatively), with before/after
  numbers from the same scenario and a green Phase 17 suite (AC4).
- If a fix would change observable behavior or the contract, it is not a P4 fix —
  it is escalated per §4 rule 2.
- If a finding's fix is an index (D7 path), it follows ADR-0011: the owning phase
  (this one) ships the committed migration, and the before/after query evidence is
  recorded.

### P5 — API performance under dashboard usage (D8)

- **API-level emulation** (S7) built from the dashboard's real request pattern:
  inventory the endpoints `apps/web` actually calls and with what pagination/
  refresh/environment-switch cadence, then encode that mix as the scenario.
  Browser-level load testing is explicitly not the mechanism (D8(b) rejected).
- **Static review of `apps/web` fetch patterns** for defective API usage (accidental
  N+1 loops, refetch storms on re-render, unbounded client-side polling). Findings
  follow the same evidence discipline; small web-side fixes for defective patterns
  are in scope, rendering performance (Web Vitals, bundle size) is not (§12).
- The review's outcome is recorded in the findings log with dispositions.

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **None planned.** An index migration ships only if D7's measurement triggers it (ADR-0011 owning-phase workflow); any other schema change is an escalation (§4 rule 2). |
| Volume fixtures | Per D9: identity/capability scaffold (user, org, project, keys, endpoints) is API-driven (Phase 17 pattern); bulk corpus rows (customers, payments) may be seeded directly with contract-valid values only — never to fabricate behavior under test, only corpus. Runs target a dedicated compose project/instance with a documented reset (`down -v`) procedure; never shared dev data. |
| Baseline artifact | Committed document (D3, location per D3) containing per-scenario p50/p95/p99 latency, throughput, error rate, the environment description, date, commit sha, and the env overrides used (limits, delays). Written as if public; no hostnames beyond localhost, no credentials. |
| Findings log | Committed artifact (may live beside the baseline): id, scenario, metric, measured value, disposition, evidence reference — the Phase 18 findings discipline applied. |
| Configuration | Any new variable (e.g. a seed size, a base URL for k6) is non-secret, documented (`.env.example`-style), explicitly declared; rate-limit overrides for load stacks are ordinary documented config, not test switches that relax production controls. |
| Script dependencies | k6 tooling is obtained per the D1 runbook (documented install or containerized image); its version is pinned in the runbook so results stay comparable. |

## 8. Security requirements (for this phase's own work)

1. **No control bypass, ever.** Scenarios and seeds authenticate and authorize
   through the public surface; the phase introduces no unguarded bypass of
   authentication, authorization, validation, rate limiting, or tenant isolation —
   including "temporary" harness hooks. Rate-limit raising is configuration of the
   local stack, not a code switch (and never a production default change without
   recorded rationale — AC7).
2. **No weakening of verified controls to improve numbers** (§4 rule 3). Request
   logging stays on in S6 — the scenario exists to *measure* the amplification, not
   to argue for silently deleting rows; any disposition that touches a Phase 11/18
   control follows escalation and is recorded (D6).
3. **No secrets, no PII.** Scripts, seeds, results, and documents carry generated
   identifiers and placeholder values only; API keys are created through the API and
   never committed; the ADR-0037 register (AR-1/AR-2/AR-3) is read, not modified, by
   this phase.
4. **Local-only targeting** (§4 rule 6). Scripts default to the documented local
   endpoints; running them elsewhere requires consciously overriding the documented
   target and is not the supported path.
5. **Fixes touching authorization, tenant isolation, cryptographic handling, or
   secret exposure** receive the explicit security review in the PR (AGENTS.md) —
   a performance-motivated change is not exempt.
6. **Results hygiene:** baseline and findings artifacts are checked for leakage
   (tokens, cookies, internal hostnames) before commit, same as Phase 17 artifact
   rules.

## 9. CI and tooling requirements

- The existing pipeline order and root scripts stay unchanged: `pnpm lint`,
  `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.
- New entry points (D1/D4) are explicit scripts with explicit names, runnable from
  the repository root against the documented local stack; per D4 they are **not** PR-
  gate steps for the MVP (load tests are timing-sensitive and CI runners are noisy);
  local reproducibility is the requirement, CI scheduling is Phase 23's question.
- Load testing is a **separate harness** from the Phase 17 L1–L8 layers: it adds no
  new functional test layer, and the functional suites must not absorb load
  dependencies (no k6 invocation inside `pnpm test`).
- Every new dependency (k6 distribution method, any helper package) is declared,
  pinned, and justified; nothing the phase adds may slow or destabilize the existing
  pipeline.

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — Scripts exist and run.** The k6 harness (D1) is committed; one documented
   command sequence brings up the stack, seeds per D9, runs the catalog, and
   collects results; the runbook entry is accurate from a clean checkout.
2. **AC2 — Scenario catalog committed.** S1–S8 (or the D2-confirmed set) are defined,
   documented per §6 P2, and executable; each carries the purpose/observation fields
   the catalog requires.
3. **AC3 — Baseline recorded.** The baseline artifact (D3) exists with per-scenario
   numbers, environment description, date, and commit; the findings log exists with
   every finding in the §4 rule 4 format and an explicit disposition; the specific
   questions of §6 P3 (starvation, amplification materiality, search degradation)
   each have a recorded, evidence-backed answer.
4. **AC4 — Optimizations verified.** Every P4 fix ships with before/after numbers
   from the same scenario; the full Phase 17 suite (unit, integration, e2e, browser,
   contract, coverage thresholds) stays green; no observable contract change (§5);
   no assertion or control was weakened (AC8).
5. **AC5 — Dashboard-usage review complete.** S7 exists and ran; the static review of
   `apps/web` fetch patterns is recorded; every finding has a disposition; any web-
   side fix included is small, focused, and itself covered by the existing web
   suites.
6. **AC6 — Handovers discharged.** Every §3 finding (F1–F11) has a recorded
   disposition: F2 (sweep fairness / pending bound) per D5, F3 (amplification) per
   D6, F5 (search index) per D7, F4 (rate-limit interaction) per AC7 — fixed,
   accepted-with-exit-criteria, or referred to a named owner, never dropped.
7. **AC7 — Rate-limit interaction handled.** Load scenarios configure their own
   limits via documented env overrides (no catalog change); any default-number
   change is recorded with rationale in the baseline artifact and compose/
   `.env.example`; the class catalog and algorithm are untouched unless a recorded
   amendment exists.
8. **AC8 — Security posture intact.** §8 verified: no control disabled in scenarios
   or fixes; no secrets/PII in scripts, seeds, artifacts, or documents; the ADR-0037
   register is unchanged; security-sensitive fixes carry the explicit PR review.
9. **AC9 — Required checks pass.** `pnpm lint`, `pnpm lint:openapi`,
   `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` pass from the
   repository root; CI is green; the new load scripts are themselves linted/
   typechecked where the toolchain allows (JS helpers) and validated (k6 `inspect`
   or equivalent) per the runbook.
10. **AC10 — Traceability.** All five roadmap checkboxes are satisfied and traced to
    §1; Q1 is answered (or D3's fallback explicitly invoked in the Status row).
11. **AC11 — Reproducibility.** The documented procedure reproduces the baseline
    within a stated, recorded variance band on the same machine class; deviations
    are explained in the artifact (dev-machine baselines are regression-relative —
    F7/D3 — not capacity claims).

## 11. Testing requirements

- **The Phase 17 suite is the regression net** and must stay green throughout —
  before, between, and after every optimization (AC4).
- **Optimization regression tests:** any fix that touches code paths with functional
  tests extends those suites minimally (e.g. a fairness fix adds a multi-project
  sweep ordering test at L2); a fix with no functional surface (pure query/index
  change) is proven by the before/after scenario numbers plus the existing suite.
- **Scenario determinism:** fixed VU/duration profiles, fixed data volumes, fixed
  seed procedures — committed, never ad hoc; results cite the profile that produced
  them (§4 rule 4).
- **No new Phase 17 layers.** Load testing does not join L1–L8; where a load finding
  exposes a *functional* gap (e.g. a starvation case no functional test covers), the
  gap is closed in the existing L2/L3 suites, not in k6.
- **Scripts are maintained like product code:** linted/typechecked/validated, code-
  reviewed, and free of the defects (leaks, bypasses) the security rules forbid.

## 12. Out of scope

- **Product/feature changes and contract changes**: new endpoints, new UX, new
  domain rules, error-envelope changes — including the pending-delivery bound if it
  requires new delivery states/marks (D5 escalation path).
- **Observability infrastructure**: Prometheus/metrics collection, dashboards,
  alerting, worker metrics endpoints (Phase 20) — Phase 19 observes the local stack
  with ad hoc, disposable instrumentation only.
- **Production capacity planning, AWS sizing, cloud load profiles** (Phase 24);
  **staging re-baselining** (Phase 22 — inherits the re-baseline obligation);
  **CI scheduling/nightly load jobs** (Phase 23, unless D4 explicitly revises).
- **Frontend rendering performance** (Web Vitals, bundle size, image optimization)
  — the dashboard checkbox is about API performance under dashboard usage (§6 P5).
- **Rate-limit algorithm changes** (sliding window, token bucket — ADR-0024 rejected
  them absent demonstrated need): if S1/S2 measurements demonstrate a fixed-window
  artifact that matters, it is a finding referred with an amendment proposal, never
  an in-phase swap.
- **Speculative caching** (Redis response caches, memoization layers) or premature
  restructuring (read models, materialized views) without a §6 P3 finding and D-
  confirmed disposition.
- **Accessibility** (relocated to Phase 26, Phase 18 D8), **security re-review**
  (Phase 18 complete), **release QA** (Phase 26), **Open Source/docs-site work**
  (Phase 25).
- **ROADMAP.md bookkeeping** for other phases (report-only; own checkboxes at merge
  via `chore/*`).

## 13. Decisions (D1–D9 — confirmed 2026-10-14)

All decisions below are confirmed by the product authority. The chosen option in each
row (bold) is binding for implementation.

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Load-test tooling and script home (F1) | **(a) k6, per the roadmap's literal wording, with scripts in a dedicated `loadtest/` directory** and a documented runbook — k6's scripting model fits the scenario catalog (S1–S8), thresholds, and JSON summaries the baseline needs. (b) autocannon/artillery — rejected: contradicts the roadmap checkbox wording without a product reason. (c) In-repo custom Node harness — rejected: rebuilds what k6 provides and couples load tooling to the app toolchain. | Confirmed |
| D2 | Scenario catalog scope (F1) | **(a) The bounded S1–S8 set in §6 P2** — one scenario per critical flow plus the three mandated evidence scenarios (S5 fairness/pileup, S6 amplification, S7 dashboard) and one standing regression mix (S8). (b) Broader catalog (per-endpoint sweeps of all 46 routes) — rejected: unbounded effort, low insight density. (c) Minimal (only S8) — rejected: cannot discharge F2/F3/F5/F9 evidence mandates. | Confirmed |
| D3 | Performance targets and baseline artifact (F6/F7, Q1) | **(a) Baseline-then-record:** run the catalog on the documented local reference environment, commit the measured numbers as the baseline artifact (in `docs/`, Phase 18 D3 precedent), and set the standing guardrail as "no regression beyond a recorded variance band + near-zero error rate"; re-baseline obligation recorded for Phases 22/24. Invented absolute SLOs are not written. (b) Define absolute targets now (e.g. "p95 < 200 ms") — rejected: invents business requirements the product never specified (AGENTS.md; F6). (c) Measure with no committed baseline — rejected: "optimize bottlenecks" and Phase 26 regression re-runs need a recorded bar. | Confirmed — Q1 waived; option (a) invoked |
| D4 | Execution venue (CI vs local) | **(a) Local/manual only for the MVP**, with the runbook and committed scripts; not a PR-gate step; not a scheduled job. Phase 23 may add scheduling later. (b) Scheduled CI job now — rejected: noisy-runner variance undermines the baseline (F7), and Phase 23 owns pipeline expansion. (c) Every-PR load gate — rejected: PR feedback time (Phase 17 §10) and flakiness. | Confirmed |
| D5 | F13 availability referrals disposition (F2) | **(a) Measure under S5, then dispose:** if cross-project starvation is demonstrated at sandbox-realistic volumes, fix the sweep/requeue fairness in-phase as a contract-preserving internal change (ordering/bounding change only, L2 tests added); if a pending-delivery pileup with harmful effects is demonstrated, the *bound itself* is new delivery-model behavior → escalate with options (it was Phase 13 D11's classification that it "belongs with the delivery model"); if neither is demonstrated, record both as accepted-with-exit-criteria (reopen at Phase 22 volumes or with delivery-health metrics from Phase 20). (b) Fix both unconditionally now — rejected: the pending bound is unimplemented product behavior invented without measurement; fairness changes without evidence are speculative. (c) Measure-only, refer everything to backlog — rejected: leaves a named-owner referral (ADR-0037) without the disposition this phase exists to make. | Confirmed |
| D6 | F12 request-log amplification disposition (F3) | **(a) Measure under S6; presume acceptance-with-exit-criteria** unless the numbers are pathological: the scan does no handler work, the write is best-effort post-response, 30-day retention bounds table growth; record rationale and exit criteria (e.g. reopen if Phase 20 metrics show anomalous log-write rates, or before any non-sandbox deployment where scans get cheaper relative to infrastructure). Any remedy (pre-routing limiter stage, log exclusion) is a spec change → referred with a proposal, never silently applied — a logging exclusion would weaken the Phase 11/18 completeness control and is forbidden by §4 rule 3 without explicit product decision. (b) Bound it now via a pre-routing limit stage — rejected: new enforcement behavior, unmeasured. (c) Drop unmatched-path 404s from request logs — rejected outright under §4 rule 3 unless the product authority explicitly reopens the Phase 11 completeness requirement. | Confirmed |
| D7 | Customer search indexing (F5) | **(a) Measure under S4; add a `pg_trgm` GIN index via owning-phase migration only if degradation is demonstrated** at corpus volumes; otherwise record acceptance ("substring search is a sequential scan by design below N customers") with exit criteria naming the scale that reopens it. (b) Add the index unconditionally now — rejected: speculative optimization against Phase 6's deliberate, recorded deferral. (c) Ignore the handover — rejected: F5 is an explicit inbound obligation. | Confirmed |
| D8 | Dashboard-usage review mechanism (F9) | **(a) API-level emulation (S7) built from an inventory of the dashboard's real requests, plus a static review of `apps/web` fetch patterns** — measures the layer the checkbox names (API performance), cheaply and repeatably. (b) Playwright-driven browser load testing — rejected: heavy, flaky, and measures rendering/network, not API performance. (c) Static review only — rejected: no numbers, cannot satisfy P3's evidence rule. | Confirmed |
| D9 | Volume-fixture strategy (F11) | **(a) Hybrid:** identity/capability scaffold and everything security-relevant stays API-driven (Phase 17 pattern); bulk corpus rows (customers, payments) may be seeded directly with contract-valid values, bounded and documented, never used to fabricate behavior under test; dedicated compose instance + documented reset. (b) API-driven only — rejected: setup time for thousands of rows dominates and itself confounds S2/S3 measurements. (c) Unrestricted DB seeding — rejected: erodes the Phase 17 data discipline and risks fabricating states the API could not produce. | Confirmed |

## 14. Open questions

1. **Q1 — Absolute scale or SLO expectations (F6). — WAIVED 2026-10-14.** The
   product authority confirmed no absolute expectations exist for the MVP sandbox.
   D3(a)'s baseline-then-record approach stands as the substitute: measured numbers
   plus a recorded variance band and near-zero error rate are the standing guardrail;
   no absolute SLOs are written. If absolute targets ever emerge, they are a
   specification amendment replacing the corresponding D3 guardrail numbers.

## 15. Architectural decisions to record

To be written during implementation as needed (next ADR numbers, `.ai/decisions/`):

- **Load-test harness and baseline procedure** (D1/D3/D4): tool choice, script
  home, runbook entry point, baseline artifact location and format, variance band,
  and the local-only targeting rule — one ADR so Phase 22/24 re-baselining and
  Phase 26 regression re-runs inherit the procedure instead of re-deriving it.
- **Any D5 fairness fix**, if implemented: the new sweep/requeue selection
  semantics (ordering, bounding) and why they preserve every existing guarantee
  (exactly-once CAS edges, no lost work, bounded batches).
- **Any D7 index**, if implemented: the chosen index, the measured evidence that
  justified it, and the migration reference (ADR-0011).
- **Any D6 acceptance**: bind the accepted amplification posture and its exit
  criteria into a short record so Phase 20 (metrics) and Phase 22/24 (deployment)
  inherit it deliberately — mirroring the ADR-0037 register pattern at phase scope.
- Optimizations that change **no semantics and no configuration surface** need no
  ADR (Phase 18 guard-consolidation precedent) — cite before/after numbers in the
  baseline artifact instead.

## 16. Implementation considerations (not requirements)

- **Bring the stack to a known state before every run** (`down -v`, re-seed): leftover
  rows from previous runs are the fastest way to make a baseline unreproducible.
- **Run S8 first**: it exercises both planes and usually reveals the dominant
  bottleneck class (DB write path, Redis limiter, worker lag) before you invest in
  the narrower scenarios.
- **Mind AR-3 in S1**: designing the login scenario around many generated accounts
  avoids mistaking the accepted per-account lockout (ADR-0037 AR-3) for a finding.
- **The limiter's own cost is a measurable line**: the two-stage guard adds Redis
  work per request (ADR-0024); if S2/S3 show it prominently, that is a legitimate
  finding — disposition it, do not bypass it.
- **For S6, capture Postgres side evidence** (row counts, insert rate, table size
  growth over the run) so D6's materiality answer rests on data-volume facts, not
  only on k6 latency numbers (the amplification's cost is writes, not handler time).
- **For S5, run at least two tenants with deliberately uneven volume** — fairness
  defects do not appear with a single project.
- **Keep the baseline artifact boring**: one table per scenario, numbers, environment
  paragraph, sha — it will be re-read at Phase 22/24/26 and must stay easy to append
  to, same guidance as the Phase 18 checklist.
- **When a fix surprises you** (it changes behavior you did not intend to touch),
  stop and apply §4 rule 1: the suite or the contract just told you the change was
  not behavior-preserving.
- Time-box exploratory profiling; every probe that reveals a candidate bottleneck is
  converted into a committed scenario extension before it counts as a finding
  (§4 rule 4, Phase 18 rule-4 precedent).

## 17. Dependencies and handovers

**Inputs (everything this phase measures and inherits):**

- Phase 1 (API conventions, pagination), Phase 2 (compose stack, health, logging),
  Phase 3 (auth endpoints, AR-3 lockout posture), Phase 4 (tenant model for
  multi-project scenarios), Phase 5 (API keys), Phase 6 (customer search deferral —
  F5), Phase 7 (payment simulation, advancement), Phase 8 (idempotency retry
  semantics in S2), Phase 9 (refunds in S8 mix), Phase 10 (sweep/requeue fairness
  defect, in-transaction fan-out note — F2), Phase 11 (request-log write path — F3),
  Phase 12 (audit writes on business events), Phase 13 (rate-limit catalog and the
  Phase 19 coordination obligations — F3/F4, §6.2/§16), Phase 14 (dashboard request
  patterns — F9), Phase 15 (local-dev guide — runbook home), Phase 16 (scenario
  field, scenario-aware sweep filter), Phase 17 (harness patterns, data discipline,
  required checks), Phase 18 (control baseline, ADR-0037 register — F8), ADR-0001…
  ADR-0037, `docs/api-conventions.md`, `docs/security-review.md`.

**Discharged by this phase (on implementation):**

- Phase 6 §4.5: "performance is Phase 19" (customer search indexing) — D7, AC6.
- Phase 10 fairness/pending-bound referral (via Phase 13 D11 and Phase 18 F13,
  ADR-0037 re-ownership) — D5, AC6.
- Phase 11/13/ADR-0024: F12 write-amplification measurement mandate — D6, S6, AC3/AC6.
- Phase 13 §6.2/§16: load tests must set their own limit values; defaults revisitable
  on evidence — §6 P2, AC7.
- Phase 14/17/18 out-of-scope deferrals naming Phase 19 as the performance owner —
  this phase's AC set.
- Master specification MVP #17–adjacent ("sandbox simulation" already shipped) and
  ROADMAP Phase 19 checkboxes — §1 traceability.

**Blocks / hands forward:**

- Phase 20 (bottleneck findings prioritise metrics work; D6 disposition coordinates
  with throttled-request/log-write metrics).
- Phase 22/24 (re-baseline obligation on real environments; deployment-fact handovers
  recorded here — e.g. any tuning that only holds on specific hardware).
- Phase 26 (S8 re-run as a pre-release regression sanity gate; baseline artifact is
  a QA input).

## 18. Definition of done

The phase is complete only when:

1. D1–D9 are confirmed and Q1 is answered (or explicitly waived) — the Status row
   records the decisions.
2. All five roadmap checkboxes are satisfied and traced to §10 acceptance criteria
   (scripts = AC1; scenarios = AC2; bottleneck identification = AC3; optimization =
   AC4; dashboard usage = AC5), with AC6–AC11 as cross-cutting gates.
3. The §6 catalog P1–P5 is executed and every §3 finding (F1–F11) has a recorded
   disposition (AC6) — including the F2/F3/F5 discharges with evidence (AC3).
4. Every optimization is contract-preserving, evidenced before/after, and the full
   Phase 17 suite stays green (AC4); nothing was weakened to improve a number
   (AC8, §4 rule 3).
5. The baseline artifact and findings log are committed, consistent, and
   reproducible per the documented procedure (AC3, AC11).
6. Required checks pass from the repository root and CI is green (AC9); the load
   harness introduces no bypass of the controls the functional suites enforce
   (AC8).
7. Any ADRs required by §15 are written alongside the implementation.
8. This phase's ROADMAP.md checkboxes are updated at merge time as a separate
   `chore/*` change (Phase 16 Q2 / Phase 18 F14 precedent).
