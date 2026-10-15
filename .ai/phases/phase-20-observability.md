# Phase 20 — Observability

| | |
| --- | --- |
| Phase | 20 — Observability |
| Status | **Confirmed — ready for implementation.** D1–D8 confirmed and Q1–Q6 answered by the product authority on 2026-10-15, all resolving to the architect's recommended option (Phase 19 D1–D9 precedent). Implementation may proceed on `feature/phase-20-observability`. |
| Depends on | Phase 1 (API conventions, error envelope, request IDs), Phase 2 (compose stack, `/health/live` + `/health/ready` contract, structured pino logging, config pattern), Phases 3–13 (the surface under observation — auth, RBAC/tenancy, projects/API keys, customers, payments + sweep, idempotency, refunds, webhooks + BullMQ worker topology, request logs, audit logs, rate limiting including its Phase 20 metric handover), Phase 14 (dashboard defers metrics by explicit decision — Q3 precedent), Phase 15 (local-development guide — runbook home), Phase 17 (test harness, required checks), Phase 18 (verified control baseline, A09 "alerting/metrics deferred to Phase 20" limitation), Phase 19 (performance baseline + findings prioritize which metrics matter first), ADR-0012 (contract canon), ADR-0018 (worker topology), ADR-0021 (request logs are the incident surface), ADR-0024 (rate-limit degraded posture), ADR-0037 (security accepted-risk register), ADR-0038/ADR-0039 (load baseline, Phase 19 disposition triggers) |
| Blocks | Phase 21 (production Docker needs the metrics port/path, healthcheck and config-key facts recorded here), Phase 22 (staging probes, dashboards and alert rules consume this phase's outputs), Phase 23 (pipeline health gating may use the endpoints verified here), Phase 24 (log/metric ingestion and alert routing on AWS; ADR-0039 exit-criteria evaluation on real infrastructure), Phase 26 (release QA may close the Phase 18 A09 monitoring limitation only if this phase delivered it) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 20 |
| Branch | `feature/phase-20-observability` |

## 1. Objective

**Give BrinnPay production-ready monitoring: collect the metrics that matter, keep
health/readiness trustworthy, provide dashboards, and make API errors and background jobs
observable.**

Like Phases 17–19, this is an *enabling* phase: it adds operational instrumentation and
its supporting configuration — not product features. It discharges the monitoring and
alerting deferrals prior phases filed into it (§3 F7, F8) and attaches concrete signals
to every reopen trigger ADR-0039 bound (§3 F8). Where scope interpretation was itself
ambiguous — dashboards as infrastructure vs. product UI, alerting with no checkbox, the
exposure policy of an unauthenticated metrics surface — it was escalated rather than
invented: the product authority resolved all of it in §13/§14 (2026-10-15), and those
answers are normative for this phase.

### Roadmap traceability

| Roadmap Phase 20 checkbox | Where |
| --- | --- |
| Metrics collection (Prometheus/custom) | §6 M1, D1, AC1 |
| Health/readiness endpoints | §6 M2, D7, AC2 |
| Monitoring dashboards | §6 M3, Q2/D2, AC3 |
| API error monitoring | §6 M4, D8, AC4 |
| Background job monitoring | §6 M5, D3/D5, AC5 |

The roadmap goal sentence — "Production-ready monitoring **and alerting**" — has no
matching checkbox; alerting was answered by Q3 and is in scope as **rules-only**
(D6(a): committed rules + local/log notification; human routing deferred).

## 2. Scope

In scope:

- **Metrics collection** (D1): in-process instrumentation of the API and worker planes
  exposing a documented metrics surface in the chosen format, plus the bounded metric
  catalog §6 M1 defines (HTTP traffic, rate limiting, request-log writes, errors, queue
  and sweep health).
- **Health/readiness completion** (D7): preservation and hardening of the existing
  `/health/live` + `/health/ready` contract, a liveness/readiness signal for the worker
  process (which has none — F1), and the operational facts Phases 21/22 need.
- **Monitoring dashboards** (D2(a), Q2 answered): committed, provisioned dashboard
  definitions covering the API process, the worker, and their dependencies, loadable via
  an opt-in compose profile with one documented command. No product observability UI and
  no contract surface (§5 rule).
- **API error monitoring** (§6 M4): an aggregated, scrapeable error signal (5xx,
  unhandled exceptions) correlated with the existing request-ID log trail — not a
  replacement for it.
- **Background job monitoring** (§6 M5): queue depth, delivery aging/lag, attempt
  outcomes, and sweep durations — including the ADR-0039 trigger metrics (F8).
- **Alerting, rules-only** (D6(a), Q3 answered): committed alert rules over the
  collected metrics (error rate, degraded limiter, queue lag, log-write anomaly),
  evaluated by the D2 stack, notifying locally/to the log — using only mechanisms that
  exist in this repository (no new SaaS, no human routing).
- **Configuration and documentation**: new non-secret env vars in the established
  pattern, compose wiring (opt-in profile where appropriate), and a runbook entry in the
  Phase 15 local-development-guide style.

Explicitly **not** in scope (§12): product/business analytics, web-app (client-side)
monitoring, third-party SaaS, centralized log shipping, distributed tracing, SLO
definition, changes to any readiness/business/rate-limit/delivery semantics, and
ROADMAP.md bookkeeping beyond this phase's own checkboxes (report-only; `chore/*` at
merge — Phase 16 Q2 / Phase 18 F14 precedent).

## 3. Context and current-state findings

**What exists today** (Phases 0–19; branch `feature/phase-20-observability`):

- **API:** NestJS modular monolith with the full MVP domain surface; global exception
  filter rendering the canonical error envelope and logging unhandled exceptions with
  request IDs; two-stage rate limiter with a degraded in-process fallback (ADR-0024);
  request-log persistence for every `/api/v1` request (ADR-0020/0021); audit log.
- **Worker:** separate process (ADR-0018) with **no HTTP surface at all** — no
  controller, no port, no readiness contract; runs the BullMQ consumer, advancement
  sweep, reconciliation, requeue, and retention; logs to stdout via pino; **no compose
  healthcheck** (docker/compose.yml).
- **Health:** `/health/live` + `/health/ready` (Postgres + Redis, 3 s timeout, minimal
  failure payloads) outside `/api/v1`, excluded from request logs, rate limiting, and
  pino auto-logging; compose healthchecks for `postgres`, `redis`, `api` only.
- **Logging:** structured pino JSON to stdout with redaction paths and request-ID
  propagation — Phase 11 §5.3 names it "the Phase 20 shipping source"; Phase 24/CloudWatch
  is its consumer.
- **Metrics:** none — no metrics library, endpoint, counter, or dashboard exists
  anywhere in the repository (verified by dependency and source search).
- **Dashboards/monitoring stack:** no Prometheus/Grafana/compose monitoring service; the
  dashboard explicitly states "No metrics, counts or aggregates: those would require API
  surface that does not exist (Q3)".
- **Baseline artifacts:** `docs/performance-baseline.md` + `docs/performance-findings.md`
  record what is worth watching first (API latency/throughput/error rate, queue depth,
  sweep pass duration, delivery lag, request-log write amplification, lock-wait
  convoy) — but only as static documents.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | **The health checkbox targets completion, not creation.** The endpoints exist since Phase 2; what does not exist: any worker-side health signal (the worker is invisible to compose beyond "process alive" — it has no healthcheck line at all), and recorded operational facts for Phases 21/22 (probe paths, timings, payload contract). Phase 2 D9 and Phase 10's "readiness must not depend on queue drain health" remain binding. | D7, §6 M2, AC2. |
| F2 | **Metrics collection is greenfield.** No library, no endpoint, no counters; "Prometheus/custom" (roadmap wording) is a real tool-choice fork. | Resolved: Q1/D1(a) — Prometheus pull. |
| F3 | **Logging is the shipping channel and must be preserved, not replaced.** Phase 11 §5.3 designates the pino stdout channel as Phase 20's source; Phase 24 consumes it. This phase instruments *metrics*; it does not re-architect logs or add log shipping. | §4 rule 6, §12. |
| F4 | **"Monitoring dashboards" is ambiguous.** (a) Infrastructure dashboards (e.g. Grafana over Prometheus) — no contract change, compose-profile addition; (b) a product observability UI in `apps/web` — requires new `/api/v1` metrics endpoints, OpenAPI changes, authz/tenancy design, and would decide Phase 14/16's explicit deferral *into* scope; (c) both. Phase 14 and Phase 16 each wrote "observability UI (Phase 20)" as a deferral, not a commitment. | Resolved: Q2/D2(a) — infrastructure dashboards only. |
| F5 | **API error monitoring exists only as logs.** The exception filter logs unhandled exceptions per request; request logs persist every status; but there is no aggregated error-rate signal, no threshold, and no alert. Phase 18 A09 recorded this as a "noted limitation", deferred here. | §6 M4, D8, AC4. |
| F6 | **The background job plane is unobservable.** BullMQ state lives only in Redis; sweep durations and delivery lag are visible only by reading logs or rows; the worker exposes nothing scrapable and has no healthcheck. ADR-0018's "serves no HTTP traffic" posture collides with Prometheus-style scraping of a second process. | D3, §6 M5, AC5. |
| F7 | **Alerting is in the goal sentence but has no checkbox, no channel, and no recipient.** No notification infrastructure exists (no email, no webhook-of-our-own); Phase 18 A09 deferred "alerting" here wholesale. Inventing alert destinations or paging behavior would invent business requirements (AGENTS.md). | Resolved: Q3/D6(a) — in scope, rules-only. |
| F8 | **Named trigger metrics are owed to ADR-0039 and prior handovers.** PR-1 (per-project fairness ages), PR-2 (pending deliveries beyond the attempt ladder), PR-3 (anomalous request-log write rate), PR-5 (sustained queue lag / log-ingestion lag) each name "Phase 20 metrics" as the reopen trigger; Phase 13 §16 owes throttled-request counts, per-class exhaustion, and degraded-mode visibility; Phase 10/ADR-0015/ADR-0018 owe worker observability. Handovers are discharged or re-owned, never dropped (Phase 19 rule 7). | §6 M1/M5, AC6. |
| F9 | **The metrics surface's security posture is undefined.** Exposure (public port vs. internal), authentication (scrape token vs. network-trust), label cardinality (raw URLs with path IDs would leak identifiers and explode series), and tenant-identifying labels (per-project gauges = cross-tenant visibility) have no existing rule. | D4, D5, §8, AC7. |
| F10 | **No SLOs or absolute targets exist** (Phase 19 Q1 waived; ADR-0038 baseline-then-record). Alert thresholds written as absolutes would invent business requirements; thresholds must be configuration derived from the recorded baseline, explicitly framed as operational guardrails, not SLOs. | D6, §7, §8 rule 7. |
| F11 | **Downstream consumers need recorded facts.** Phase 21 (metrics port/path, env keys, healthcheck wiring), Phase 22 (probe and dashboard provisioning), Phase 24 (ingestion/alert routing, ADR-0039 trigger evaluation on real infra) inherit whatever this phase records; ad hoc setups will be re-derived. | §7, §17, AC11. |

## 4. Domain rules (normative)

1. **No control may be weakened for a signal (Phase 18/19 rule 3).** Request logging,
   rate limiting, HMAC, authorization, tenancy, and log redaction stay enabled exactly as
   verified; instrumentation never bypasses, samples away, or slows a control into
   disabling itself, and metrics are not a reason to drop any log line.
2. **Escalation over invention (Phase 18 rule 2).** Dashboard interpretation,
   alerting scope and destinations, metrics-endpoint exposure, and any product-facing
   metrics API are decided by the product authority — never assumed by implementation.
   Q2–Q4 settled them for this phase (infrastructure dashboards, rules-only alerting,
   flag+optional-token exposure); any change to those answers is a new decision, not an
   implementation choice. A new `/api/v1` surface remains a contract change following
   ADR-0012 and the Phase 14 rule "no ad hoc web-only endpoint".
3. **The readiness contract is unchanged.** API readiness = PostgreSQL + Redis reachable
   (Phase 2 D9); queue drain health never gates API readiness (Phase 10 §5.3,
   ADR-0015/ADR-0018). Worker observability is *additive* — separate signals, separate
   process — and health payloads stay minimal, revealing nothing internal (Phase 2 §4.3).
4. **Metrics labels are bounded and non-sensitive.** Route *templates* only (never raw
   URLs or path/query values), no PII (emails, names), no secrets (keys, tokens,
   signatures), no request bodies, and a closed set of label keys; user- or
   tenant-controlled values never become label values (§8 rule 3). Any tenant-
   identifying label is a D5 decision, never a default.
5. **Observability is passive.** Instrumentation must not change payment, refund,
   webhook, idempotency, rate-limit, or logging behavior; counters and gauges are
   in-process increments or reads of already-maintained state, never new blocking work
   in a request's critical path beyond negligible constant time.
6. **The log channel stays the shipping channel.** Structured pino JSON to stdout with
   the existing redaction paths remains the log mechanism (F3); metrics complement logs
   (correlated where possible by request ID/process), they do not replace, rewrite, or
   re-route them — log shipping is Phase 24's question.
7. **Every inbound trigger gets a signal or a recorded disposition** (Phase 19 rule 7):
   each ADR-0039 PR-1…PR-5 trigger and the Phase 11/13 handovers either has a shipped
   metric/gauge in §6 or an explicit, reasoned disposition in the phase record.
8. **Evidence over anecdote applies to thresholds.** Alert thresholds ship as documented
   configuration with defaults derived from `docs/performance-baseline.md`, labeled as
   operational guardrails with reopen criteria — not as SLOs the product never defined
   (F10, Phase 19 D3(a) posture).
9. **The phase's own work obeys the checks it reports on.** `pnpm lint`,
   `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`
   (AGENTS.md); no secrets, credentials, or PII in metrics, dashboards, alert rules,
   scrape configs, or documentation.

## 5. API behavior

**Default expectation: no changes to the versioned contract.** Everything published in
`docs/openapi.yaml` (statuses, error codes, auth modes, pagination, headers) stays
exactly as is; `/health/live` and `/health/ready` keep their documented Phase 2 behavior,
payload shapes, and placement outside `/api/v1`.

What the phase may add, narrowly:

- **An operational metrics endpoint** outside `/api/v1` and outside the OpenAPI contract,
  following the Phase 2 health-endpoint pattern (same exclusion list, same "operational,
  not contracted API traffic" classification — so it is likewise not rate-limited and not
  persisted as a request log). Path and format follow D1(a); exposure follows D4(a)
  (enable flag + optional scrape token, internal-network-only). It must not appear in
  Swagger or the public API reference.
- **Nothing under `/api/v1`.** Q2 selected the infrastructure interpretation, so this
  phase adds no product metrics surface; if a later phase ever wants one, it is a
  contract change following ADR-0012 (auth mode, RBAC roles, tenant scoping,
  pagination/filtering, error envelope, OpenAPI conformance testing per ADR-0035) — a
  decision for that phase, never an implementation detail.
- **Health semantics preserved; worker signal additive.** The worker gains its own
  minimal metrics/health listener on a separate port (D3(a)) — a new, separately
  addressed operational surface on the worker process: never a change to the API's
  readiness contract, never a shared port, never a new obligation for API readiness.
- **Configuration only, no behavior changes:** all new knobs (enable flags, ports, paths,
  scrape token, threshold numbers) are non-secret-or-fail-fast env vars in the
  `configuration.ts` pattern; no business rule, status, or error code changes.

## 6. Observability work catalog (normative)

Each area (M1–M5) maps to one roadmap checkbox. M1/M4/M5 build the signal; M2 completes
health; M3 presents it.

### M1 — Metrics collection (D1)

- A metrics registry and exposition endpoint (Prometheus text, D1(a)) on the API process, plus
  default runtime metrics (memory, event loop, process uptime) as the library provides.
- **Bounded metric catalog v1** (names illustrative; final names recorded in the phase
  record):

  | Area | Signals | Serves |
  | --- | --- | --- |
  | HTTP API | request count + duration histogram by route template/method/status class; in-flight requests | API error monitoring (M4), Phase 19 baseline continuity |
  | Rate limiting (Phase 13 §16) | throttled-request count per class; per-class window-exhaustion events; degraded-mode state/episode gauge (the "degraded-mode warning" as a signal) | Phase 13 handover (F8) |
  | Request logs (Phase 11) | write count + write failure count (log-ingestion rate proxy) | ADR-0039 PR-3, PR-5 trigger |
  | Errors (M4) | 5xx count, unhandled-exception count, by route template | Phase 18 A09 closure |
  | Background jobs (M5) | see M5 table | ADR-0039 PR-1/PR-2/PR-5 |
- No per-user, per-request-ID, per-customer, or free-text labels ever (D5 policy).
- Instrumentation covers the API process; worker signals follow D3(a).

### M2 — Health/readiness completion (D7)

- Existing `/health/live` and `/health/ready` behavior, payloads, exclusions (rate
  limiting, request logs, auto-logging), and 3 s dependency timeout stay exactly as
  specified — regression-proven, not merely preserved by care.
- A **worker health signal** served by the D3(a) listener plus a compose healthcheck,
  so the worker container is observable the way `api` already is; it never feeds the API
  readiness payload.
- Recorded operational facts for downstream phases: probe endpoints and semantics,
  expected payloads, timings, compose healthcheck definitions, and which checks exist
  per process — handed to Phases 21/22 (§17).

### M3 — Monitoring dashboards (D2(a), Q2 answered)

- Committed, provisioned dashboard definitions covering at minimum — API request
  rate/latency/errors, rate-limit throttles/degraded state, request-log write rate,
  queue depth and delivery lag, sweep durations, Postgres/Redis reachability — loadable
  through the opt-in compose profile with one documented command from a clean checkout.
- Dashboards are committed artifacts (like the Phase 19 baseline), written as if public:
  no hostnames beyond localhost, no credentials, no PII.
- No product UI in this phase (Q2); a dashboard never duplicates domain logic (master
  specification: the dashboard is a client of the metrics surface, not of domain
  services).

### M4 — API error monitoring (D8)

- Aggregated error signals from M1 (5xx, unhandled exceptions) sufficient to answer
  "is the API erroring right now, on which routes, at what rate" without grep'ing logs.
- Correlation path documented: metric spike → request-ID-bearing structured logs →
  request logs/audit logs (the Phase 18 A09 incident surfaces) — metrics add the
  *detection* layer, logs remain the *investigation* layer (F5, §4 rule 6).
- At least one error-rate rule over these signals, per D6(a) (mechanism and
  baseline-derived thresholds).

### M5 — Background job monitoring (D3/D5)

- | Signal | Answers | Trigger served |
  | --- | --- | --- |
  | Queue depth (waiting/delayed/active/failed) per queue | is work piling up? | PR-5 (sustained queue lag) |
  | Oldest-pending delivery age (aggregated per D5 label policy) | are deliveries aging past the ladder? | PR-2, PR-5 |
  | Delivery attempt outcomes (attempted/succeeded/failed, retry counts) | is delivery health degrading? | PR-1, PR-2 exit criteria |
  | Per-project fairness gauge (oldest-pending age per project, bounded per D5) | is one tenant starving another? | PR-1 exit criteria |
  | Sweep pass duration + last-run timestamp (advancement, reconciliation, requeue, retention) | is the worker keeping up? | PR-5, Phase 19 P-11 |
  | Worker process liveness (M2) | is the worker running at all? | operational baseline |
- Collected per D3's mechanism; scrape/read costs on Redis or DB must be bounded (never
  an unbounded scan per scrape — §4 rule 5).

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **None.** Metrics are in-process/Redis-sourced; no Prisma schema change is planned. A schema change would be an escalation (§4 rule 2). |
| Metrics storage | D1(a): pull-model exposition carries **no** local time-series storage obligation — storage lives in the scraping stack, not the app. Any process-local buffer must be bounded and documented (no unbounded in-memory growth). |
| Configuration | New env vars following `configuration.ts` patterns: metrics enable/path/port (API and worker), scrape token (optional per D4(a); fail-fast like `JWT_SECRET` when mandated), alert enable + threshold values (D6(a)), dashboard/stack profile toggles. Non-secret values documented in compose comments (`.env.example`-style listing, Phase 19 precedent); secrets never committed. |
| Compose | Any monitoring stack service (Prometheus/Grafana equivalents per D1/D2) is an **opt-in profile** (the `worker` profile precedent) so the default dev stack and the Phase 19 load harness stay unchanged; committed provisioning/config files reference only documented local endpoints. |
| Artifacts | Dashboard definitions and alert rules (D6(a)) are committed, reviewable, and free of secrets/PII/hostnames beyond localhost; threshold defaults cite `docs/performance-baseline.md`. |
| No product data | No new persistent product rows; no PII, tenant data, or business records ever exported into metrics/dashboards beyond what D5's label policy permits. |

## 8. Security requirements (for this phase's own work)

1. **The new metrics surface requires an explicit exposure decision (D4) and an
   explicit security review** (AGENTS.md) before merge. D4(a) is decided: enable flag +
   optional scrape token, endpoint outside `/api/v1`, out of OpenAPI, documented as
   internal-network-only — with the Phase 21/24 firewall obligation recorded (F11).
   "We left it open" is not a posture.
2. **No secret, credential, token, or PII in any metric label, dashboard panel, alert
   rule, or scrape config** (§4 rule 4, §4 rule 9). Redaction paths in `logger.config.ts`
   are read-only for this phase; metric builders never see request bodies.
3. **Cardinality safety as a DoS control:** raw URLs, query strings, IDs from path
   parameters, emails, API keys, and any attacker-controlled value are forbidden as label
   values — a route-template label policy (D5) is tested, not assumed (AC7). Series
   growth must not be influenceable by unauthenticated traffic.
4. **Tenant isolation:** the metrics surface is platform-operational, never a data
   surface; a product metrics API does not exist (Q2/D2(a)), and the only
   tenant-identifying signal — the per-project gauge — is permitted solely under D5(a)'s
   bounded conditions and cannot become an IDOR/cross-tenant read. Any future product
   metrics API would have to preserve RBAC/tenant scoping (Phase 4) by its own decision.
5. **No control bypass and no weakening** (§4 rule 1): the metrics endpoint's
   classification (like health's) must not create a hole — it exposes metrics only, no
   domain data, no debug/admin information, no dependency versions or internals in
   failure payloads.
6. **Health payloads stay minimal** (Phase 2 §4.3): check names and statuses only;
   failure causes remain server-side logs.
7. **The ADR-0037 register is read, not modified**, and the Phase 18 verified baseline
   survives; alerting thresholds are operational config, never permission to auto-disable
   or auto-relax a control.
8. **Artifacts hygiene:** dashboards, alert rules, and runbook entries are reviewed for
   leakage (tokens, cookies, internal hostnames) before commit — Phase 17/19 artifact
   rules.

## 9. CI and tooling requirements

- Root scripts and pipeline order stay unchanged: `pnpm lint`, `pnpm lint:openapi`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.
- New dependencies (metrics library, dashboard tooling) are declared, pinned, and
  justified; nothing added may slow or destabilize the pipeline (Phase 19 §9 pattern).
- Compose profile additions must not alter default `docker compose up` behavior or break
  the Phase 19 load harness (`pnpm loadtest`) procedure.
- Dashboard/rule artifacts are validated in CI where a cheap validator exists (analogous
  to `pnpm lint:openapi`), otherwise validated by the integration tests (§11).

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — Metrics collection exists.** The D1-chosen metrics surface is implemented on
   the API (and per D3 on the worker); the §6 M1 catalog is exposed and scrapeable/
   readable locally with one documented command; default process metrics present; the
   endpoint's placement/exclusions match §5.
2. **AC2 — Health/readiness trustworthy.** Existing `/health/live` + `/health/ready`
   behavior, payloads, and exclusions are regression-proven unchanged (Phase 2 e2e
   expectations still hold); the worker has a health signal per D7; no readiness semantic
   change (§4 rule 3); operational facts for Phases 21/22 are recorded (§17).
3. **AC3 — Dashboards per D2(a).** Committed dashboard definitions load via the
   documented opt-in profile procedure and display the M3 minimum set from a clean
   checkout; dashboards are artifact-clean (§8 rule 8).
4. **AC4 — API error monitoring works.** 5xx and unhandled-exception signals are
   aggregated by route template and demonstrably spike under an induced failure in a
   test; the correlation path metric → logs → request/audit logs is documented; the
   error-rate rule exists with a documented baseline-derived threshold (D6(a)).
5. **AC5 — Background job monitoring works.** The M5 signals appear and update under
   simulated webhook activity (deliveries enqueued, attempted, retried) in an
   integration/e2e setting; worker liveness is observable per D7.
6. **AC6 — Handovers discharged.** Every §3 trigger has a shipped signal or a recorded
   disposition: Phase 13 (throttled counts, per-class exhaustion, degraded state), Phase
   11 (log-write rate/failures), Phase 10/ADR-0015/0018 (worker observability), and
   ADR-0039 PR-1…PR-5 (fairness ages, pending-delivery aging, write rate, queue lag) —
   never dropped (§4 rule 7).
7. **AC7 — Security posture verified.** D4's exposure posture implemented as decided;
   label-policy tests prove no raw URLs/IDs/PII/secrets in labels; the metrics surface
   carries its explicit security review; ADR-0037 register unchanged; no control
   weakened (§4 rule 1).
8. **AC8 — Contract integrity.** `docs/openapi.yaml` unchanged (Q2 chose
   infrastructure-only, so no product metrics surface exists to specify); the metrics
   endpoint appears in no public documentation surface; health behavior byte-compatible
   with Phase 2 (AC2).
9. **AC9 — Required checks pass.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:e2e`, `pnpm build` pass from the repository root; CI green;
   the coverage ratchet (ADR-0034) holds for touched packages.
10. **AC10 — Traceability.** All five roadmap checkboxes are traced to §1 and satisfied;
    D1–D8 are confirmed and Q1–Q6 answered (Status row and §14 record them).
11. **AC11 — Downstream handover recorded.** §17's Phase 21/22/24/26 facts (ports,
    paths, env keys, probe semantics, dashboard provisioning steps, alert posture) are
    written down in the phase record/runbook so no downstream phase re-derives them.

## 11. Testing requirements

- **The Phase 17 suite is the regression net** and must stay green throughout — health
  e2e, contract conformance, security suites, coverage thresholds (AC2, AC9).
- **Unit:** metric registration and label construction (route-template normalization —
  a request to `/api/v1/customers/<uuid>` yields the template label, never the UUID);
  counters/gauges increment on simulated events; degraded-mode and throttled signals
  toggle with the limiter's real states; redaction-adjacent rule: metric builders never
  receive body/header material.
- **Integration/e2e:** the metrics endpoint returns the D1 format with the expected
  catalog after activity; it is excluded from rate limiting and request-log persistence
  per §5 (mirroring the health-endpoint tests); induced-5xx spike visible (AC4);
  webhook activity moves M5 signals (AC5); worker health signal behaves under
  start/stop (AC7/AC2).
- **Security/property tests:** adversarial paths and query strings produce no new label
  series (cardinality bound, AC7); a corpus of secret-shaped strings never appears in
  exposition output; metrics failure (endpoint down/misconfigured) never fails a business
  request (passive instrumentation, §4 rule 5).
- **Artifact tests:** dashboards/alert rules load or parse in CI/test (AC3/AC4);
  compose profile brings the stack up and the documented scrape works from a clean
  checkout (AC11).
- **No new Phase 17 layer:** observability tests live in the existing unit/integration/
  e2e layers; a functional gap they expose is closed in those layers, not in a bespoke
  harness.

## 12. Out of scope

- **Product/business analytics** — payment volume dashboards, conversion/usage metrics,
  per-tenant usage reporting, billing-style metering (master specification: analytics
  dashboard is "Future"; no business requirement exists).
- **Web application (client-side) monitoring** — Web Vitals, browser error tracking,
  frontend RUM; the roadmap's five checkboxes name API, background jobs, and health.
- **Third-party SaaS** — Sentry, Datadog, New Relic, hosted alerting; no new external
  service dependency for the MVP.
- **Centralized log shipping and log storage** (Phase 24 CloudWatch; §4 rule 6 keeps
  stdout JSON as the channel).
- **Distributed tracing / OpenTelemetry spans** — no roadmap item and no handover asks
  for trace correlation beyond request IDs.
- **SLO/SLA definition** (Phase 19 Q1 waived — F10; thresholds are operational
  configuration, never invented targets).
- **Readiness/business-semantic changes** — queue-drain gating of API readiness
  (Phase 2 D9/Phase 10), new health check names in the API readiness payload, delivery
  model bounds (ADR-0039 PR-2 remedy), the pre-routing limiter/log-exclusion for PR-3,
  worker concurrency changes (PR-5 remedy) — those remain referred; this phase ships the
  *triggers*, not the remedies.
- **Rate-limit algorithm or catalog changes** (ADR-0024); **worker topology changes**
  beyond what D3 decides for signal export; **Postgres/Redis engine metrics beyond what
  D2 dashboards read from the stack's own exporters, if any are adopted as part of D1/D2.**
- **A product metrics/observability API or UI** (Q2 selected infrastructure-only,
  D2(a)).
- **Alert routing to humans via channels this repo does not have** (email, paging) —
  D6(a) is rules-only with local/log notification; human routing stays deferred.
- **Staging/production deployment concerns** (Phases 21/24 — consuming this phase's
  recorded facts), **CI pipeline expansion** (Phase 23), **release QA** (Phase 26),
  **ROADMAP.md bookkeeping** for other phases (report-only; own checkboxes at merge via
  `chore/*`).

## 13. Decisions (D1–D8 — confirmed)

The product authority confirmed every decision below on 2026-10-15, selecting the
recommended option in each row (Q1–Q6 answered in §14). These are now normative:
implementation must follow the selected option, and any change requires a new
decision record (Phase 19 D1–D9 precedent).

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Metrics backend and exposition format (F2, Q1) | **(a) Prometheus text format via `prom-client` (or equivalent), exposed for pull scraping** — matches the roadmap's literal "Prometheus" wording (Phase 19 D1 precedent of honoring literal wording), is the de-facto standard Phase 22/24 tooling expects, and needs no local storage. (b) Custom JSON counters endpoint — rejected: non-standard, every consumer (dashboards, Phase 24) must be re-implemented against it; kept only if the authority explicitly prefers zero new deps. (c) OpenTelemetry push pipeline — rejected: overkill for the MVP, no collector exists, no handover asks for tracing. | **Confirmed (2026-10-15) — option (a).** |
| D2 | "Monitoring dashboards" interpretation (F4, Q2) | **(a) Infrastructure dashboards as committed artifacts loadable via an opt-in compose profile (Grafana-compatible), no product surface.** (b) Product observability UI in `apps/web` + new `/api/v1` metrics endpoints — only if the authority wants the Phase 14/16 "observability UI" deferral cashed in *now*; it triggers a full contract design in this phase. (c) Both. (d) Defer dashboards — rejected: it is a roadmap checkbox. Recommendation: (a), leaving (b) as an explicit non-goal unless chosen. | **Confirmed (2026-10-15) — option (a); Q2 answered.** |
| D3 | Worker metrics/health export mechanism (F6, ADR-0018 collision) | **(a) The worker exposes its own minimal metrics/health listener on a separate port** (Prometheus-native, matches "deployments run it as its own service"), amending ADR-0018's "no HTTP" posture with a recorded ADR note (metrics/health only — still no controllers/Swagger/readiness-contract). (b) Worker exports counters to Redis, API's scrape reads them — keeps "worker serves no HTTP" literally but couples scrape freshness to Redis key design and adds write work. (c) Logs-only worker observability — rejected: cannot satisfy M5 gauges or ADR-0039 triggers as *metrics*. Recommendation: (a). | **Confirmed (2026-10-15) — option (a).** |
| D4 | Metrics endpoint exposure and authentication (F9) | **(a) Configurable: an enable flag plus an optional scrape-token env var (fail-fast pattern if mandated), endpoint documented as internal-network-only, with Phase 21/24 recording the firewall obligation.** Placement outside `/api/v1` in every variant. (b) Always unauthenticated, network-trust only — acceptable only with an explicit accepted-risk record (ADR-0037 pattern) since production exposure is Phase 21/24's to enforce. (c) Always token — simplest to verify but every consumer must manage a secret. Recommendation: (a), confirmed via Q4. | **Confirmed (2026-10-15) — option (a); Q4 answered.** |
| D5 | Label and tenant-data policy (F9, §4 rule 4) | **(a) Route templates + method + status class only; closed label-key set; tenant-identifying labels confined to the M5 fairness gauge, permitted only because the metrics surface is non-public per D4, with bounded project cardinality and an aggregate fallback (max-across-projects) if the project count is unbounded.** (b) No tenant labels ever — rejected: PR-1's fairness trigger cannot be observed without some per-project signal. (c) Free label set — rejected outright (cardinality DoS, §8 rule 3). | **Confirmed (2026-10-15) — option (a).** |
| D6 | Alerting scope (F7, F10, Q3) | **(a) Rules-only alerting: committed alert rules (error rate, degraded limiter, queue lag, log-write anomaly) over D1 metrics, evaluated by the D2 stack, notification target = local/log/webhook-of-record — with thresholds documented as baseline-derived operational guardrails (§4 rule 8) and any email/paging routing explicitly deferred to Phase 22/24.** (b) Full alerting with delivery channels now — rejected: no channel/recipient exists in-repo; inventing them invents business requirements. (c) Defer all alerting — rejected only if the authority reads the goal sentence as binding; if chosen, record it as a Phase 18 A09 limitation extension with a named owner (Phase 22/24). Recommendation: (a). | **Confirmed (2026-10-15) — option (a); Q3 answered.** |
| D7 | Health/readiness completion scope (F1) | **(a) Preserve the API contract exactly; add the worker health signal (per D3 mechanism + compose healthcheck); record probe facts for Phases 21/22; make no change to the readiness check set.** (b) Extend API readiness (e.g. queue or metrics-stack checks) — rejected: violates Phase 2 D9 and Phase 10's explicit rule (§4 rule 3). | **Confirmed (2026-10-15) — option (a).** |
| D8 | Metric catalog v1 boundary (scope control) | **(a) The §6 M1/M5 catalog is the closed v1 set** — driven by Phase 19 findings, Phase 13/11 handovers, and ADR-0039 triggers; additions require a recorded reason (a trigger or a finding), not a "while we're here". (b) Broad instrumentation (all domain entities, histograms everywhere) — rejected: unbounded effort, cardinality risk, no trigger serves it. | **Confirmed (2026-10-15) — option (a).** |

## 14. Questions — resolved

All six questions were answered by the product authority on 2026-10-15; each resolved
to the architect's recommended option. They are recorded here for traceability (AC10);
none is open.

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Metrics format — Prometheus pull vs. custom JSON (D1)? | **D1(a) — Prometheus text format via `prom-client`, pull scraping.** |
| Q2 | What is a "monitoring dashboard" (F4, D2)? | **D2(a) — infrastructure dashboards only:** committed Grafana-compatible JSON on an opt-in compose profile. The product observability UI stays out of scope; no new `/api/v1` surface, no OpenAPI/RBAC/tenancy work. |
| Q3 | Is alerting in scope (F7, D6)? | **D6(a) — rules-only:** committed alert rules over D1 metrics, evaluated by the D2 stack, local/log notification. No delivery channel or human routing in this phase; that deferral is recorded per §15. |
| Q4 | Metrics endpoint exposure (F9, D4)? | **D4(a) — enable flag plus optional scrape token,** documented internal-network-only, with the Phase 21/24 firewall obligation recorded. |
| Q5 | Worker metrics/health export (F6, D3)? | **D3(a) — minimal separate worker listener,** with the ADR-0018 posture amendment recorded as an ADR note. |
| Q6 | Threshold posture (F10)? | **Baseline-derived operational guardrails** (§4 rule 8, ADR-0038/0039 numbers), explicitly not absolute SLOs. No hard product target is supplied; none exists in any specification. |

## 15. Architectural decisions to record

To be written during implementation as needed (next ADR numbers, `.ai/decisions/`):

- **Metrics architecture** (D1/D3/D4/D5): exposition format and endpoint placement,
  worker export mechanism (explicitly noting the ADR-0018 posture amendment that D3(a)
  requires), exposure/authentication posture, and the label/tenant policy — one ADR so
  Phases 21/22/24 inherit the scrape contract instead of re-deriving it.
- **Alerting posture** (D6): what exists (rules, evaluation, notification target) and
  what is deliberately deferred (human routing), mirroring the ADR-0037 register style
  so the Phase 18 A09 limitation can be closed or explicitly narrowed with a named owner.
- **Dashboard interpretation** (D2(a)): a short note binds "no product metrics surface
  in MVP" so a later phase proposing one reopens the decision explicitly.
- Optimizations or wiring that change **no semantics and no configuration surface**
  need no ADR (Phase 18 guard-consolidation precedent).

## 16. Implementation considerations (not requirements)

- **Register metrics once at boot**, not per request; keep hot-path work to integer
  increments and observe duration with the same clock discipline the Phase 19 scenarios
  would measure (instrumentation must not become the next bottleneck finding).
- **Route templates are the hard part**: NestJS sees matched routes, but 404s and
  static assets have none — bucket them as a single low-cardinality `unmatched` group
  rather than using raw paths (this also protects the D5 policy against scan traffic,
  the exact F3/PR-3 shape).
- **Reuse the exclusion plumbing**: health already rides `GLOBAL_PREFIX_EXCLUSIONS`,
  the request-log prefix rule, and the pino auto-logging ignore list — the metrics
  endpoint should slot into all three (plus rate-limit stage 0) the same way, so a
  15-second scrape never becomes request-log or limiter noise.
- **Scrape-side work must be bounded**: `getJobCounts`-style Redis reads and any
  per-project gauge refresh run on scrape with an explicit cap (the Phase 19 P-11
  lesson: observability must not recreate the write amplification it is meant to
  detect).
- **Wire M5 signals where the worker already knows the numbers** (attempt outcomes,
  sweep timing) rather than re-deriving them from DB queries at scrape time.
- **Dashboards first, alerts second**: build M3 panels on the M1/M5 catalog, then let
  D6 thresholds reference those exact panel queries — an alert over a signal nobody
  panels is untestable.
- **Keep the default stack lean**: opt-in profile, default-off or dev-default env
  values, and zero change to `pnpm loadtest` (Phase 19 AC11 reproducibility must
  survive).
- **Health tests before health edits**: run the existing health e2e first; if any
  change makes them red, §4 rule 3 says stop — the contract is not the thing to adapt.
- **Document as you go**: the runbook entry (AC11) and the Phase 21/22 handover facts
  are part of the deliverable, not a follow-up; write them while the wiring is fresh.

## 17. Dependencies and handovers

**Inputs (what this phase instruments and inherits):**

- Phase 1 (request IDs, error envelope), Phase 2 (health contract, pino logging, config
  and compose patterns), Phase 3 (auth rate-limit classes), Phase 4 (tenant model — D5
  label policy), Phase 5 (API keys), Phase 6 (customer search — PR-4 reference), Phase 7
  (payment sweep — M5), Phase 8 (idempotency semantics), Phase 9 (refunds), Phase 10
  (worker topology, queue/delivery model — M5, D3), Phase 11 (request-log write path —
  PR-3/PR-5 signals; "Phase 20 shipping source"), Phase 12 (audit as investigation
  surface), Phase 13 (throttling handover §16: counts, exhaustion, degraded warning),
  Phase 14 (dashboard metrics deferral — Q2/D2(a) keeps it deferred), Phase 15
  (runbook home), Phase 16 (sandbox
  scenarios must remain observable, not throttled), Phase 17 (harness, required checks),
  Phase 18 (A09 limitation, control baseline), Phase 19 (baseline + findings prioritize
  M1/M5; `docs/performance-baseline.md` derives thresholds), ADR-0012, ADR-0018,
  ADR-0020/0021, ADR-0024, ADR-0034/0035, ADR-0037, ADR-0038/0039.

**Discharged by this phase (on implementation):**

- Phase 13 §16: "Phase 20: throttled-request counts, per-class exhaustion, and the
  degraded-mode warning are the metrics this phase's behavior implies" — §6 M1, AC6.
- Phase 11 §5.3/§11: log shipping/alerting deferred to Phase 20 (as metrics; shipping
  itself remains Phase 24 — F3/§4 rule 6), log-write-rate visibility — §6 M1, AC6.
- Phase 10 §5.3 + ADR-0015/ADR-0018: "Phase 20 owns worker observability" — §6 M2/M5,
  D3, AC5.
- Phase 18 A09: "alerting/metrics deferred to Phase 20 by roadmap scope" — partially
  closed: metrics + rules-only alerting ship here (D6(a)/Q3); human alert routing stays
  deferred with a named owner recorded per §15 — §6 M4, AC4.
- ADR-0039 PR-1…PR-5 exit-criteria triggers: "Phase 20 metrics" named six times as the
  reopen condition — §6 M5, AC6.
- Phase 14/16: "observability UI (Phase 20)" deferrals — disposition: **not cashed in**;
  Q2/D2(a) keeps them deferred past Phase 20, recorded at AC10.
- ROADMAP Phase 20 checkboxes — §1 traceability.

**Blocks / hands forward:**

- Phase 21: metrics port/path, env keys, healthcheck definitions, exposure posture
  (firewall obligation from D4) — AC11.
- Phase 22: probe semantics, dashboard provisioning, alert evaluation on staging;
  first real-environment evaluation of ADR-0039 triggers with these metrics — AC11.
- Phase 23: possible health-gate use of the verified endpoints (its decision).
- Phase 24: log channel consumption (unchanged stdout JSON), metric ingestion
  continuity, human alert routing (if deferred by D6) — AC11.
- Phase 26: the Phase 18 A09 monitoring limitation closes only if D6(a) delivered;
  release QA consumes the dashboards/rules as evidence.

## 18. Definition of done

The phase is complete only when:

1. D1–D8 are confirmed and Q1–Q6 answered — recorded in the Status row and §14
   (AC10).
2. All five roadmap checkboxes are satisfied and traced to §10 acceptance criteria
   (metrics = AC1; health = AC2; dashboards = AC3; API error monitoring = AC4;
   background jobs = AC5), with AC6–AC11 as cross-cutting gates.
3. Every §3 finding (F1–F11) and every inbound handover has a recorded disposition —
   signals shipped or reasoned deferrals — never dropped (AC6, §4 rule 7).
4. The §6 catalog M1–M5 is implemented with its security rules: label policy tested,
   exposure posture as decided and security-reviewed, no PII/secrets anywhere in the
   observability surface (AC7).
5. The versioned contract is untouched and health behavior is regression-proven
   unchanged (AC8, AC2).
6. Required checks pass from the repository root and CI is green; the Phase 17 suite
   stays green throughout (AC9).
7. Artifacts (dashboards, rules, runbook, handover facts) are committed, artifact-clean,
   and usable from a clean checkout per the documented procedure (AC3, AC11).
8. Any ADRs required by §15 are written alongside the implementation, including the
   ADR-0018 amendment note (D3(a) chose the worker listener).
9. This phase's ROADMAP.md checkboxes are updated at merge time as a separate
   `chore/*` change (Phase 16 Q2 / Phase 18 F14 precedent).
