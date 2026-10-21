# Phase 17 — Testing

| | |
| --- | --- |
| Phase | 17 — Testing |
| Status | **Confirmed (2026-10-09) — D1–D7 and Q1–Q4 decided as recorded in §14–§15. Ready for implementation.** |
| Depends on | Phase 1 (API conventions, error envelope, contract), Phase 2 (Jest/Vitest/supertest baseline, CI service containers, D2 e2e tooling deferral), Phase 3–13 (the behaviors under test: auth, RBAC, projects/keys, customers, payments, idempotency, refunds, webhooks, request logs, audit logs, rate limits), Phase 14 (dashboard and public areas — the web flows under test), Phase 15 (docs flows, consistency mechanism), Phase 16 (sandbox scenario flows, updated docs), ADR-0001…ADR-0032 |
| Blocks | Phase 18 (security review relies on the test baseline and on the security assertions this phase adds), Phase 19 (load tests reuse the harness and data-setup patterns), Phase 23 (CI extensions compose with the steps added here), Phase 26 (release QA re-runs the critical-flow suites) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 17 |
| Branch | `chore/phase-17-testing` (checked out, empty of changes) |

## 1. Objective

Establish **comprehensive, trustworthy test coverage across all layers** of the BrinnPay
modular monolith and web application: close the coverage gaps that Phases 2–16
deliberately deferred to this phase, make "comprehensive" **measurable and enforced**,
and prove the eight roadmap checkboxes with automated tests that fail when behavior
regresses.

The phase is a *verification* phase: it adds tests, test tooling, and CI wiring. It does
not add product features. Where a new test exposes a defect, the defect policy in §4
rule 8 applies.

### Roadmap traceability

| Roadmap Phase 17 checkbox | Where |
| --- | --- |
| Unit tests | §12.1, AC1, AC10 |
| Integration tests | §12.2, AC2 |
| End-to-end tests | §12.3, AC3; browser layer §12.5, AC5 |
| Critical flow coverage | §7 catalog C1–C6, AC4 |
| Web application critical flow coverage | §7 catalog C7, §12.4–§12.5, AC5 |
| Authentication flow coverage | §12.3a, AC6 |
| Payment and refund flow coverage | §12.3b, AC7 |
| Webhook flow coverage | §12.3c, AC8 |

## 2. Scope

In scope:

- **Coverage gap closure** for every layer, driven by the §7 critical-flow catalog and
  the per-layer obligations in §12 (including the areas Phases 2–16 named as Phase 17
  territory: browser e2e, cross-module retry coverage, docs/scenario flows as e2e
  targets, Swagger UI "try it"/preflight behavior).
- **Coverage measurement and enforcement** — a defined, CI-enforced notion of
  "comprehensive" (D2(a) ratchet), including the tooling it needs.
- **Web application critical-flow coverage**, including the real-browser end-to-end
  layer confirmed by D1(a) and the smoke-suite gaps in §12.4.
- **Contract conformance testing** — bounded response-schema validation against the
  canonical `docs/openapi.yaml`, confirmed by D5(a).
- **Test architecture hardening**: determinism, no silent skips, data-setup strategy
  (D4), defect policy (D6), artifact hygiene.
- **CI wiring** for whatever tooling this phase adds (D7), on top of the existing
  `lint → typecheck → test → migrate → test:e2e → build` pipeline.
- **Traceability proof**: each of the eight roadmap checkboxes maps to at least one
  automated test that fails if the behavior it claims is removed.

Explicitly **not** in scope (§13): new product features, performance/load testing
(Phase 19), the systematic security review (Phase 18), observability (Phase 20),
CI/CD pipeline expansion beyond this phase's test steps (Phase 23), mutation testing,
visual regression, cross-browser matrices, ROADMAP.md checkbox bookkeeping (Q1).

## 3. Context and current-state findings

**What exists today** (Phases 0–16 merged; branch state = `main`, commit `7526aba`):

- **API unit (Jest, `apps/api`, `*.spec.ts` colocated with sources):** 64 suites,
  **834 tests**, all passing. Measured baseline on 2026-10-09 (jest `--coverage`,
  unit only): **statements 72.8 %, branches 64.9 %, functions 70.6 %, lines 73.9 %**.
  No `coverageThreshold` is configured and no CI step collects coverage.
- **API integration/e2e (Jest + supertest, `apps/api/test/*.e2e-spec.ts`, 17 suites,
  170 tests):** boots the real Nest application against **real PostgreSQL and Redis**
  (CI service containers, Phase 2 D8), with `requireDependencies` turning an
  unreachable dependency into a loud failure instead of a silent skip (Phase 12 F9).
  The webhook suites additionally boot the **real BullMQ worker context** and a real
  loopback HTTP destination. Time is controlled by backdating `created_at`, never by
  sleeps. `jest-e2e.setup.ts` raises rate limits for the shared gate; dedicated
  suites re-boot with tight limits to test throttling.
- **Web unit (Vitest + Testing Library + jsdom, `apps/web/test/unit`):** 22 suites,
  **242 tests**, with per-area fixture/stub helpers; API responses are stubbed.
- **Web "e2e" (`apps/web/test/e2e`, 9 smoke suites, 17 tests):** still the jsdom
  stubbed-fetch pattern established in Phase 2 D2 — **no real browser, no real API**.
  Areas with a smoke: home, docs, auth, dashboard, organizations, projects, customers,
  payments, rate-limit presentation. Areas **without** one: refunds, webhooks,
  API keys, settings, request/audit log viewers, invitations.
- **Contract:** `docs/openapi.yaml` is linted (`pnpm lint:openapi`, Redocly) and is the
  single source of truth (ADR-0012); the web docs area asserts guide↔contract facts
  (`docs-consistency.spec.ts`). **Nothing validates an actual API response against the
  contract schema.** Swagger UI is asserted to be served at `/docs` (and 404 under
  `/api/v1`); its "try it"/preflight behavior is explicitly deferred here by ADR-0030.
- **Tooling:** no Playwright (or any browser tooling) is installed;
  `@vitest/coverage-v8` is not installed; no coverage thresholds anywhere.
- **Infrastructure:** `docker/compose.yml` already provides `postgres`, `redis`,
  `api`, `worker`, `web` — a full stack for full-stack testing needs no new services.
- **CI** (`.github/workflows/ci.yml`): validate job (structure, package metadata,
  OpenAPI lint) → ci job (lint, typecheck, unit tests, `prisma migrate deploy`,
  `test:e2e`, build) with Postgres 17 + Redis 7 service containers.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | "Comprehensive test coverage" (roadmap) has no definition: no coverage measurement, no thresholds, no gate. The 72.8 % baseline above is a one-off measurement, not an enforced property. | D2(a) confirmed — measure, set, and enforce (ratchet). |
| F2 | Web end-to-end coverage is stub-based; **nine** phases (2 D2, 3, 4, 5, 6, 7, 14, 15, 16) explicitly deferred browser e2e to Phase 17, and Phase 14 §11 states "real browsers are Phase 17". Web↔API integration (cookies against a real API, CORS, security headers as served, refresh/redirect behavior, real error envelopes) is currently untested end-to-end. | D1(a) confirmed — adopt Playwright, chromium only. |
| F3 | Web smoke gaps: refunds, webhooks, API keys, settings, request/audit logs, invitations have page-level unit tests but **no e2e smoke**, so the "web application critical flow coverage" checkbox is only partly true today. | §12.4, AC5. |
| F4 | No test spans a **cross-module journey**: onboarding (register → org → project → key) → customer → payment → refund, or the webhook lifecycle across registration → event → worker delivery → replay. Each module suite proves its own slice; composition is unproven. | §7 C1–C6, AC4. |
| F5 | Phase 8 §"Coordination obligations" assigned Phase 17 "broader end-to-end retry coverage across payment/refund flows"; refunds and payments each test idempotency in isolation. | §7 C5, AC7. |
| F6 | No implementation↔contract conformance check (F1 of D5): a response can drift from `docs/openapi.yaml` while Redocly lint and the docs facts stay green. | D5(a) confirmed. |
| F7 | ADR-0030 leaves Swagger UI "try it" and **preflight behavior** to Phase 17; today only "Swagger UI is served" is asserted, and no explicit `OPTIONS` preflight assertion exists (a `request-logs` test only proves preflights are not persisted). | §12.6, AC12. |
| F8 | Phase 7 OQ-2 (missing payments HTTP-level e2e suite) was closed by Phase 16 (`payments.e2e-spec.ts` exists). | §18 — recorded as discharged, not reopened. |
| F9 | Phase 7 OQ-4 (the `payments.retrieve` description omits lazy advancement while `payments.list` documents it) is still open in the contract. | Q4 answered: keep open unless the contract is touched for another reason. |
| F10 | Silent-skip hazard is solved for DB suites (`requireDependencies`) but any **new** layer (browser, coverage, conformance) inherits the same class of risk: a step that never ran must not read as green. | §4 rule 5, AC11. |
| F11 | E2E suites need a real database and migrations; local runs need `docker compose` + `prisma:migrate:deploy`. New layers must keep the same explicit dependency posture rather than introducing environment-dependent quiet skips. | §10, §12. |
| F12 | Web coverage measurement requires a provider dependency (`@vitest/coverage-v8`) that is not installed; jest coverage needs threshold configuration. | D2 (dependency declared), §17. |
| F13 | ROADMAP.md checkbox bookkeeping is stale (Phases 4–12 unchecked though merged; 13/15/16 claimed) — same finding as Phase 16 F9/Q2. | Q1 answered: report only, separate `chore/*` change. |
| F14 | Phase 14 Q6 left custom not-found/error pages "to revisit in Phase 17/18 polish" — a product change, not a test. | Q2 answered: out of scope for Phase 17. |
| F15 | E2E wall-clock posture: suites already raise timeouts to 60–120 s and raise global rate limits for the shared gate. More layers multiply flakiness risk; the deterministic patterns (backdating, near-zero delays, polling on real queues) are established and must be reused, not replaced with sleeps. | §4 rules 3–4, AC11. |

## 4. Domain rules (normative)

1. **Tests encode the specification.** An assertion is changed only when the
   specification it encodes changes. A test that fails because the implementation
   regressed is fixed by fixing the implementation, never by weakening the assertion.
2. **Every roadmap checkbox traces to ≥ 1 automated test** that fails if the claimed
   behavior is removed (§11 AC tables are the traceability record).
3. **Layer discipline.** Unit tests prove logic in isolation; integration suites prove
   persistence/transactions against **real** PostgreSQL and Redis; HTTP e2e proves the
   public contract through supertest; browser tests (D1(a)) prove only what
   genuinely requires a browser. A behavior is not re-proven at a more expensive layer
   without a stated reason (F4 composition journeys are such a reason).
4. **Determinism.** No fixed sleeps to wait for schedule-driven behavior: reuse
   backdating (`created_at`), near-zero env delays, and polling on real queues.
   Every suite must pass repeatedly, in any order, against a database that already
   contains other suites' rows (unique per-run data, §8).
5. **No silent skips.** A suite that cannot run must fail loudly with an actionable
   message (the `requireDependencies` pattern) or be explicitly `describe.skip`ped and
   reported as pending — never reported as passing (Phase 12 F9; F10).
6. **Public interfaces first.** Behavior is triggered through the HTTP API (or the web
   UI for browser tests). Direct database access is allowed only to assert persisted
   state, to control time, and to clean up — never to fabricate the behavior under
   test.
7. **Security assertions are part of coverage.** Authorization (401/403), tenant
   isolation (404 non-disclosure), secret exposure, header and cookie posture are
   first-class assertions in the flows that touch them, not a separate afterthought
   (§9 rule 3).
8. **Defect policy (D6).** If a new test exposes behavior that contradicts an existing
   phase specification, that is a **defect**: fix it in a focused `fix/*` change with
   the strict assertion intact. If closing the gap would require **new behavior** or a
   specification change, stop and escalate — do not invent behavior and do not encode
   an invented expectation in a test.
9. **No test backdoors in production paths.** Testability hooks must be
   configuration-gated, refused in production configuration, documented, and flagged
   for the Phase 18 review (§9 rule 2).
10. **Tests are maintained like product code**: linted, typechecked, built, and covered
    by the same required checks (AGENTS.md).

## 5. API behavior

**This phase makes no API surface changes.** No new endpoints, no contract schema
changes, no rate-limit class changes, no data changes.

What the phase *requires of* the API:

- The documented contract stays canonical (ADR-0012): tests target the routes,
  statuses, error envelope, and pagination semantics exactly as published in
  `docs/openapi.yaml`. Representative responses are additionally validated against
  the contract schema (D5(a), §12.6).
- Error/status expectations in tests come from the phase specifications that defined
  them (e.g. 400 `VALIDATION_ERROR`, 401/403/404/409/422/429 semantics); a test must
  not assert a status the specification does not define (rule 8 escalation).
- Swagger UI behavior at `/docs` — including its preflight/`OPTIONS` handling and
  same-origin request posture (ADR-0030 deferral) — becomes part of the covered
  surface (§12.6, AC12).

## 6. Test architecture and layers

| Layer | Tooling (existing unless D1/D2/D5 say otherwise) | Proves | Runs against |
| --- | --- | --- | --- |
| L1 Unit — API | Jest (`apps/api`) | Pure logic, DTO/validation boundaries, guards, state machine, crypto, classification tables | nothing (isolated) |
| L2 Integration — API | Jest + Prisma + Redis | Migrations, transactions/rollback, cascades, retention, concurrency, queue/worker behavior | real PostgreSQL + real Redis (+ real worker context) |
| L3 E2E — API | Jest + supertest | The published HTTP contract: auth modes, capabilities, isolation, pagination, idempotency, rate limits, logs | real Nest app + real dependencies |
| L4 Unit — Web | Vitest + Testing Library (jsdom) | Page/ component behavior with stubbed API, docs content, security-header configuration | stubs |
| L5 Smoke — Web | Vitest (jsdom) | Scripted multi-view flows per dashboard area with stubbed API | stubs |
| L6 Browser — Web | Playwright, chromium only (D1(a)) | Web↔API integration: real session, cookies, redirects, headers, real error envelopes, route protection | full stack (`docker/compose`: api + worker + web + PG + Redis) |
| L7 Contract | Bounded response-schema validation in L3 (D5(a)) | Implementation matches `docs/openapi.yaml` | real app responses |
| L8 Docs/consistency | Existing Vitest specs (`docs-consistency`, `docs-guides`, …) | Guides ↔ contract facts; no page claims an absent feature | contract file + page content |

Layers L1–L5 and L8 exist today and keep their current home and script names
(`pnpm test`, `pnpm test:e2e`). New layers must slot into the existing scripts or add
explicit new ones (§10) — the six root scripts (`lint`, `lint:openapi`, `typecheck`,
`test`, `test:e2e`, `build`) keep working unchanged.

## 7. Critical flow catalog (normative)

Each flow below must exist as at least one automated test at the stated layer. A flow
is **covered** when a failure at any step makes the test fail.

| # | Flow | Steps | Layer |
| --- | --- | --- | --- |
| C1 | Onboarding journey | register → default organization exists → create organization → invite/accept (or direct membership) → create project → create API key (plaintext shown once) → revoke | L3 (+ L6 for the dashboard half) |
| C2 | Payment journey (API-key mode) | create customer → create payment (default success) → retrieve/list → simulation advances to `succeeded` → event row exists | L3 |
| C3 | Payment failure/timeout journey (Phase 16) | create with `scenario: "decline"` → `failed` + `failure_code` in response/event/audit; create with `scenario: "timeout"` → stays `processing` | L3 |
| C4 | Refund journey | succeeded payment → partial refund → remaining refund → over-refund rejected (422) → list/retrieve scoped | L3 |
| C5 | Safe-retry journey (Phase 8 handover, F5) | same `Idempotency-Key` retried across **payment and refund** creates: one resource, verbatim replay, concurrent same-key attempts serialize to one row; different keys independent | L3 |
| C6 | Webhook lifecycle | register endpoint (secret shown once) → payment → event persisted in-transaction → worker delivers signed request a receiver verifies → failure → retry ladder → replay → retention/expiry behavior | L2 + L3 |
| C7 | Web application critical flows | public home → product → docs navigation; register/login; dashboard shell → overview; project → payments list/create (scenario field) → status observed; API key created and shown once; sign-out; 401/403/404/429 presented correctly; route protection without a session | L5 + L6 |
| C8 | Docs/consistency flows (Phase 15/16 handover) | docs pages render their required content; guide↔contract facts match; no page claims an absent feature; examples are placeholder-only | L8 |

Flows may be implemented as one test each or composed from existing suites — the
requirement is that **every step is exercised and asserted somewhere that fails
loudly**, and that the mapping table above stays truthful.

## 8. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **None.** This phase adds no tables, columns, indexes, or migrations (ADR-0011 workflow is untouched). |
| Fixture creation | **API-driven (D4):** test state is built through public endpoints with per-run unique suffixes (existing `pay16-<stamp>` pattern). No SQL/ORM seed scripts for business fixtures. |
| Direct DB access | Allowed only for: asserting persisted state, controlling time (backdating `created_at`), and cleanup. Never to fabricate behavior under test. |
| Test identities | Generated data only: UUIDv7 ids, generated emails on reserved example domains (`example.com`/`example.test`), random passwords meeting the Phase 3 policy. No PII, no reused credentials across suites. |
| Time control | Existing mechanisms only: `PAYMENT_*_DELAY_MS` near-zero overrides, webhook backoff env values, `created_at` backdating, `vi.useFakeTimers` in jsdom. No `sleep`-based waiting (rule 4). |
| Rate-limit posture | Shared gate overrides stay in `jest-e2e.setup.ts` (documented there); limit behavior is tested in dedicated suites that boot with tight values (existing pattern). New suites must not raise limits further without stating why. |
| Environment configuration | New variables introduced by D1/D5/D7 (e.g. web/API base URLs for browser runs) are **non-secret, documented in `.env.example`-style files, and explicitly declared** — an undeclared env var is a spec deviation (Phase 16 §7 precedent). |
| Secrets in tests | Only the existing fixed, non-secret test values (e.g. the zeroed `WEBHOOK_ENCRYPTION_KEY` fallback, a test JWT secret), each documented as test-only and never reused in a real environment. No real credentials anywhere (AGENTS.md). |
| Artifacts | Coverage reports, browser traces/screenshots/videos are **generated, git-ignored, and treated as sensitive** (they can contain session material): capture on failure only, never commit, never paste into docs or PRs. |

## 9. Security requirements

1. **No secrets in the repository or test output.** Fixtures, snapshots, traces, and
   logs carry placeholders only; nothing logs passwords, API keys, `Idempotency-Key`
   values, JWTs, or webhook signing secrets (AGENTS.md). Coverage/artifact uploads are
   checked for leakage.
2. **Test-only switches stay test-only.** Any hook that relaxes a control for testing
   must be refused under production configuration (the existing `DATABASE_URL`-keyed
   refusal pattern for `WEBHOOK_ALLOW_INSECURE_TEST_KEY` is the model), documented in
   `.env.example`, and listed for the Phase 18 review. This phase introduces **no**
   unguarded bypass of authentication, authorization, validation, rate limiting, or
   tenant isolation.
3. **Security behaviors are asserted, not assumed** — as part of critical-flow
   coverage: 401/403/404 non-disclosure across tenants and environments, API-key
   plaintext shown exactly once, HttpOnly/SameSite/Secure cookie posture, security
   headers (helmet + web CSP/HSTS per ADR-0028), rate-limit responses and headers,
   redaction of secrets in request/audit logs, generic auth failures (no user
   enumeration).
4. **Browser tests do not weaken the browser posture.** Tests run against the real
   headers/CSP; any relaxation is test-scoped, explicit, and reported. Tests never
   disable TLS/cookie/CSP checks to make a flow pass.
5. **No external egress.** All test traffic stays on loopback: webhook destinations,
   browser targets, and docs examples never reach the public internet (determinism and
   no data exfiltration).
6. **Tenant isolation under the new layers.** Browser flows
   must include at least one negative case per journey (a second user cannot see the
   first user's project/payment), so the new layer does not become the one place
   isolation is untested.
7. **Contract/auth parity.** Tests must not document or rely on authorization the API
   does not enforce; a test that "passes because the UI hides it" is insufficient —
   the API assertion is the enforcement proof (Phase 14 D5 rationale).
8. **Review.** The added tooling and any configuration it requires are flagged for the
   Phase 18 security review; this phase must introduce no known critical issue.

## 10. CI and tooling requirements

- The existing pipeline order stays: validate → lint → typecheck → unit tests →
  migrations → `test:e2e` → build. New steps (coverage per D2/D7, browser per D1/D7) are
  added as explicit steps with explicit dependency setup (browser install/cache,
  service containers reused from the existing job).
- Every new step has a **pass/fail** outcome; a step that cannot run fails the job
  (rule 5), it never no-ops green.
- Root scripts keep working: `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:e2e`, `pnpm build`, plus whatever new script names D1/D2/D5/D7
  define (declared in the respective `package.json`, runnable from the repository
  root).
- Local reproducibility: every CI step must be runnable locally with the documented
  compose stack and `.env.example` defaults (Phase 15 local-development guide is the
  reference; no undocumented setup steps).
- Feedback time is a real constraint: the added steps must keep PR feedback
  practical; implementation measures and records the resulting pipeline duration
  (§17) rather than letting the suite grow unbounded.

## 11. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — Unit.** API and web unit suites pass with no silent skips; every module
   lacking boundary/negative unit coverage for its documented rules (per its phase
   spec) gains it; new/changed code from this phase's tooling is itself tested.
2. **AC2 — Integration.** DB-backed suites cover, with real PostgreSQL and Redis:
   migrations apply cleanly, transactional rollback, cascades/retention, and at least
   one real concurrency case per critical flow that claims atomicity (payment edge,
   idempotent create, audit write).
3. **AC3 — API end-to-end.** Every MVP resource area has HTTP-level coverage under
   **both auth modes** where applicable: auth, organizations/membership/invitations,
   projects/API keys, customers, payments (incl. scenarios), idempotency, refunds,
   webhooks, request logs, audit logs, rate limits, health, error envelope, pagination.
4. **AC4 — Critical flows.** C1–C6 (§7) each exist as automated tests that fail when
   any step breaks; the traceability table in §1 maps each roadmap checkbox to them.
5. **AC5 — Web critical flows.** C7 is covered: every dashboard area (including
   refunds, webhooks, API keys, settings, request/audit logs, invitations — F3) has an
   e2e smoke, and the bounded browser set (D1(a)) exercises the same critical flows
   against the real stack including at least one negative authorization/isolation
   case (§9 rule 6).
6. **AC6 — Authentication flows.** Registration, login, session cookie, refresh
   rotation + reuse detection, logout/revocation, 401 handling, generic auth failures,
   auth rate limiting, and cross-tenant non-disclosure are all asserted at L3 (existing
   coverage retained; gaps closed).
7. **AC7 — Payment and refund flows.** State machine + deterministic schedule, all
   three sandbox scenarios, money rules (minor units, `usd`, positive amounts),
   partial/full/excess refund validation, refund eligibility, and the **cross-flow
   idempotent retry** of C5 are asserted (F5 discharged).
8. **AC8 — Webhook flows.** Registration/secret-once, in-transaction event persistence,
   signed delivery verified by a real receiver, retry ladder + backoff + terminal
   failure, `Retry-After`, replay, retention/expiry, destination policy, sandbox
   failure markers, and sweep-driven delivery without reads are asserted at L2/L3
   (existing suites kept green; gaps closed).
9. **AC9 — Docs and scenario flows.** C8 holds: the Phase 15 consistency mechanism and
   the Phase 16 scenario/doc assertions still pass and extend to anything this phase
   touches; no published surface contradicts the implementation.
10. **AC10 — Coverage is measured and enforced (D2(a)).** Coverage is collected for
    both apps in CI and the baseline-derived thresholds (statements and branches,
    rounded down per app) fail the build on regression; the measured baseline is
    documented next to the thresholds.
11. **AC11 — Trustworthiness.** The full suite passes **twice in a row** on the same
    database and in a fresh environment; there are no fixed-sleep waits, no
    order-dependent tests, and no step that reports success without running (rule 5);
    any flaky test found is fixed or reported, not retried away.
12. **AC12 — Contract and Swagger.** Representative responses for the core resources
    and the error envelope validate against `docs/openapi.yaml` in CI (D5(a)) and
    drift fails the build; `pnpm lint:openapi` at zero errors; the Swagger UI surface
    (`/docs`, canonical contract, preflight/same-origin posture — F7) is covered
    (§12.6).
13. **AC13 — Required checks.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
    `pnpm test`, `pnpm test:e2e`, `pnpm build` (plus the new scripts from D1/D2/D5/D7)
    pass from the repository root; CI is green.
14. **AC14 — Security.** §9 verified: no secrets in code, fixtures, logs, or
    artifacts; no unguarded test backdoors; security behaviors asserted in the
    critical flows; nothing this phase adds is exempt from the controls it tests.

## 12. Testing requirements

### 12.1 Unit (`apps/api`, `apps/web`)

- Keep all 834 API / 242 web unit tests green (they are the specification of the
  behavior built in Phases 2–16).
- Add unit coverage for logic the phase specs define but no unit suite asserts yet —
  identified by walking the §7 flows against existing specs (e.g. cross-module helpers,
  contract-facing mappers, client request construction in `apps/web/lib/brinnpay`).
- New tooling introduced by this phase (coverage config, conformance helpers, browser
  fixtures) gets its own unit tests where it contains logic.

### 12.2 Integration (real PostgreSQL + real Redis + real worker)

- Keep the existing 17 e2e suites green; they are the integration layer.
- Close F4/F5 composition gaps at this layer where a real queue/transaction is part of
  the claim (C2, C4, C5, C6).
- Any new suite keeps the `requireDependencies` dependency posture (F10/F11).

### 12.3 API end-to-end (supertest) — roadmap checkboxes "end-to-end", "authentication", "payment and refund", "webhook"

- **a. Authentication:** the AC6 list, both session and API-key entry points, plus an
  explicit `OPTIONS` preflight assertion (allowed origin, echoed allowed headers,
  no auth required) — F7.
- **b. Payments and refunds:** AC7 including C3 scenarios and the cross-flow C5 retry
  (payment + refund in one journey, same key and different keys, concurrent attempts).
- **c. Webhooks:** AC8 including the worker-driven path and the Phase 16 markers.
- **d. Cross-module journeys:** C1 and C2 end-to-end as journeys, not only as
  per-endpoint assertions (F4).

### 12.4 Web application (jsdom, existing pattern)

- Extend `test/e2e` smoke coverage to **every** dashboard area missing one (F3):
  refunds, webhooks, API keys, settings, request logs, audit logs, invitations.
- Each new smoke follows the established pattern: stubbed API, scripted one-user flow,
  no assertions on styling internals, no session material on public surfaces.
- Keep `docs-consistency` / `docs-guides` / `docs-pages` green (C8).

### 12.5 Web application in a real browser (D1(a) confirmed)

- A bounded critical-flow set over the **real stack** (api + worker + web + PG + Redis
  from `docker/compose.yml`): public → docs navigation; register/login/logout;
  dashboard → project → payments create (incl. scenario field) → status observed; API
  key created and shown once; a 401/redirect case without a session; one negative
  isolation case (§9 rule 6); one 429 presentation case (Phase 14 §7.3/§7.4).
- Chromium only, one config, one script, wired into CI per D7; state built through the
  UI/API (D4), never through DB seeding.
- Existing jsdom smoke suites remain (they are fast feedback and already cover each
  area); the browser set complements rather than replaces them.

### 12.6 Contract and API documentation surface

- Response-schema validation for core resources (`Payment`, `Refund`, `Customer`,
  `Project`, webhook endpoint/event/delivery, the error envelope, list envelopes)
  executed against real responses inside L3; failure = build failure (D5(a)).
- Always: Swagger UI served from the canonical contract at `/docs`, 404 under
  `/api/v1`, contract loads (no broken `$ref`s), and preflight/same-origin posture
  asserted (F7).

### 12.7 Shared

- All checks run from the repository root and in CI (AC13).
- No secrets in fixtures or output; unique per-run data; no external egress (§9).
- Deterministic execution: no sleeps, polling with bounded timeouts, near-zero
  env-driven delays (AC11).

## 13. Out of scope

- **Any product/feature change**, contract change, schema change, or migration. New
  behavior demanded by a test is escalated per rule 8, not built here.
- **Performance and load testing** (Phase 19), **security review sign-off**
  (Phase 18), **observability/metrics** (Phase 20), **CI/CD pipeline expansion and
  release automation** (Phase 23).
- **Mutation testing, property-based/fuzz testing, visual regression/screenshot
  baselines, accessibility automation beyond what exists, cross-browser matrices
  (Firefox/WebKit), device farms, mobile emulation.**
- **Test parallelization/sharding and suite split optimizations** (revisit only if
  measured feedback time demands it — §17).
- **Seeding/fixture services, test-data packages, shared `packages/*` for tests**
  (master specification: packages only for demonstrated reuse).
- **Custom not-found/error pages** (Phase 14 Q6 — Q2 answered: out of scope here).
- **ROADMAP.md checkbox bookkeeping** (Q1 answered: report only, separate `chore/*`;
  Phase 16 Q2 precedent) and `.ai/` artifact restructuring.
- **README/CONTRIBUTING/SECURITY content** (Phase 25), release QA (Phase 26),
  real payment processing / card data / microservices (master specification).

## 14. Decisions (D1–D7 — confirmed 2026-10-09)

All seven decisions were confirmed by the product authority on 2026-10-09, each at
its recommended option **(a)**. The table preserves the alternatives for the record.

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Browser end-to-end tooling (deferred by Phases 2 D2, 3, 4, 5, 6, 7, 14, 15, 16 to this phase) | **(a) Adopt Playwright, chromium only, for the bounded §12.5 critical set** — discharges nine explicit handovers, and is the only layer that proves web↔API integration (cookies/CORS/headers/refresh/real error envelopes) and "web application critical flow coverage" against reality; `docker/compose.yml` already provides everything it needs. (b) Keep jsdom-only web e2e and declare API e2e sufficient — simplest and cheapest, but leaves every deferral unfulfilled and redefines the checkbox as stub-based; must be confirmed as an explicit discharge, not left implicit. (c) HTTP-only checks of the built Next app (no browser) — cheap realism for public pages/SSR, but cannot drive client-side flows, so it satisfies neither (a) nor (b) cleanly. | **Confirmed: (a)** |
| D2 | How "comprehensive coverage" is measured and enforced (F1) | **(a) Enforce a ratchet:** measure the baseline per app in this phase (API ≈ 72.8 % statements measured 2026-10-09; web unmeasured — needs `@vitest/coverage-v8`), configure thresholds at that baseline, fail CI only on regression. (b) Report-only coverage (collected and visible, never failing) — zero risk of red-CI churn, but "comprehensive" then remains unenforced. (c) No coverage metric; criteria-based ACs only — rejects the roadmap's wording. | **Confirmed: (a)**; threshold numbers = measured baseline per Q3 |
| D3 | Critical-flow catalog | **(a) Adopt §7 C1–C8 as normative** — explicit, traceable to the roadmap, and testable. (b) Derive flows implicitly from each phase's ACs — preserves 16 phases of AC lists as the source but leaves "critical" undefined and composition (F4) unaddressed. (c) Leave the catalog to the implementer — unverifiable. | **Confirmed: (a)** |
| D4 | Test data strategy | **(a) API-driven setup with per-run unique suffixes + existing time-control mechanisms; direct DB access only for assertions, time control, and cleanup** — matches every existing suite, needs no seed infrastructure, keeps tests honest (rule 6). (b) Prisma/SQL seed scripts for fixtures — faster setup, but fabricates state outside the contract and risks drift. | **Confirmed: (a)** |
| D5 | Contract conformance testing (F6) | **(a) Bounded response-schema validation** of core resources + error envelope against `docs/openapi.yaml`, executed in L3 — the only mechanism that catches implementation↔contract drift, and aligned with "the specification is the source of truth"; costs one parser/validator dependency and a maintained allowlist of covered operations. (b) Status quo (Redocly lint + docs facts) — no new dependency, but drift between contract and implementation stays undetected. | **Confirmed: (a)**, bounded (no validation of every response of every operation) |
| D6 | Defect policy when new tests fail | **(a) Fix defects that contradict an existing phase spec in a focused `fix/*` change within this phase's window, keeping the strict assertion; escalate anything that needs new behavior or a spec change** — keeps the specification authoritative (rule 8) without letting a testing phase silently grow scope. (b) Log and defer all fixes to later phases — a green pipeline cannot be claimed while known defects sit in the critical flows. | **Confirmed: (a)** |
| D7 | CI wiring for the new layers (D1/D2/D5 confirmed) | **(a) Run every new layer on every pull request** (browsers cached, coverage + conformance inline) — immediate feedback, matches the current single-job pipeline. (b) Run browser/coverage layers only on `main`/scheduled — faster PRs, but the critical-flow guarantee does not hold per PR. | **Confirmed: (a)** for the bounded suites defined here; revisit if measured duration (§10) proves impractical |

## 15. Open questions — answered 2026-10-09

1. **Q1 — ROADMAP.md checkbox bookkeeping (F13).** Phases 4–12 are implemented but
   unchecked; 13/15/16 were claimed early. **Answered:** this phase makes **no**
   ROADMAP.md edits; the drift is reported and fixed in a separate `chore/*` change
   (exact Phase 16 Q2 precedent, including Phase 17's own checkboxes).
2. **Q2 — Custom not-found/error pages (F14).** Phase 14 Q6 deferred "revisit in
   Phase 17/18 polish". It is a **product** change, not a test.
   **Answered:** out of scope for Phase 17; revisit in Phase 18 or a standalone
   `fix/*`/`feature/*` web change.
3. **Q3 — Coverage baseline value (D2).** The API baseline is ~72.8 % statements /
   64.9 % branches (unit only); the web baseline is unmeasured.
   **Answered:** thresholds = measured baseline rounded down per app, so CI fails only
   on regression — "no regression" is the bar for this phase, not an arbitrary
   improvement target (e.g. 80 %). Branch coverage is included.
4. **Q4 — Phase 7 OQ-4 (F9): `payments.retrieve` description omits lazy advancement.**
   **Answered:** keep it open for the next contract-touching phase (Phase 7's own
   disposition), unless this phase touches the contract for another confirmed reason —
   i.e. a D5 drift fix — in which case the one-line in-place refinement (ADR-0012) is
   applied alongside it.

## 16. Architectural decisions to record

To be written during implementation, since D1, D2 and D5 are confirmed (next ADR
numbers, `.ai/decisions/`):

- **Browser e2e tooling and topology** (D1, D7): tool choice, chromium-only scope,
  what the browser layer is responsible for versus jsdom smoke and API e2e, why the
  suite is bounded, rejected alternatives.
- **Coverage enforcement policy** (D2, Q3): ratchet approach, what is measured, why a
  baseline ratchet instead of a target number, what deliberately stays unmeasured
  (generated/config files).
- **Contract conformance mechanism** (D5): how responses are validated against the
  canonical contract, the covered-operation allowlist, the dependency chosen, and why
  full-coverage validation was deferred.

## 17. Implementation considerations (not requirements)

- Measure both baselines **first** (API jest coverage; web via `@vitest/coverage-v8`),
  then configure thresholds — never the other way around.
- Keep `collectCoverageFrom` honest: exclude generated/config/test files explicitly so
  the ratchet is stable across refactors.
- Reuse existing suite scaffolding (`apps/api/test/support/db-e2e.ts`,
  `requireDependencies`, per-suite `jest-e2e.setup.ts` env, `payments.e2e-spec.ts`
  backdating helpers) instead of building a new harness.
- For C1/C2 journeys, a shared "setup" helper inside `apps/api/test/support` is
  preferable to copy-pasted arrange blocks; keep it test-local (no `packages/*`).
- Browser runs need `NEXT_PUBLIC_API_BASE_URL` pointed at the API origin, the API's
  `CORS_ORIGINS` including the web origin (both already exist), and a seeded session —
  drive it through the UI, not by minting tokens in the test.
- Playwright/web-server wiring should launch the **built** apps (`next start`,
  `node dist/main.js`) in CI to match production behavior; document the local
  equivalent (compose) in the local-development guide only if Phase 15/25 content
  needs it (Q1-style scope discipline: docs edits belong to their owning phase).
- Conformance (D5): validate *responses* (and maybe request bodies) of a curated
  operation list; skip `additionalProperties` strictness that would fail on legitimate
  additive fields — the goal is catching drift, not freezing the schema.
- Poll rather than sleep everywhere; if a suite needs a longer timeout, raise it per
  suite (existing 60–120 s pattern) instead of globalizing longer waits.
- Flaky tests: fix the cause (usually shared state or timing); do not add retries as
  a default. If a retry is unavoidable, it must be explicit and reported.
- Watch total pipeline duration after wiring (§10) and record it in the PR description
  so the trade-off is visible to the next phase (19/23).

## 18. Dependencies and handovers

**Inputs:** Phases 1–16 (all behaviors under test), Phase 2 D2 (e2e tooling deferral
that this phase resolves), Phase 8 (retry-coverage obligation), Phase 12 F9
(no-silent-skip pattern), Phase 14 §11 (browser = Phase 17) and Q6 (F14), Phase 15
(docs flows as e2e targets), Phase 16 (scenario flows as e2e targets; F11 payments
suite), ADR-0001…ADR-0032 (notably ADR-0012 contract single-source, ADR-0030
Swagger/preflight deferral).

**Discharged by this phase (decisions confirmed 2026-10-09; discharged on implementation):**

- Phases 2/3/4/5/6/7/14/15/16: "browser e2e remains Phase 17" — D1.
- Phase 8: "broader end-to-end retry coverage across payment/refund flows" — C5/AC7.
- Phase 14 §11: "real browsers are Phase 17" — §12.5.
- Phase 15: "docs flows become e2e targets" — C8/AC9 (already partly true; kept green
  and extended).
- Phase 16: "scenario flows and the updated docs become e2e targets" — C3/AC7, C8/AC9.
- ADR-0030: Swagger UI "try it"/preflight behavior — §12.6/AC12.
- Phase 7 OQ-2: recorded as already discharged by Phase 16 (F8) — not reopened.
- Master specification MVP #17 "Automated testing" — the §11 AC set.

**Blocks:** Phase 18 (relies on the baseline and the security assertions added here),
Phase 19 (harness/data-setup reuse), Phase 23 (CI composition), Phase 26 (re-runs the
critical flows as release QA).

## 19. Definition of done

The phase is complete only when:

1. D1–D7 confirmed and Q1–Q4 answered (done — Status row records the 2026-10-09
   decisions).
2. All eight roadmap checkboxes are satisfied and traced to §11 acceptance criteria
   (unit = AC1; integration = AC2; e2e = AC3; critical flows = AC4; web critical flows
   = AC5; authentication = AC6; payments/refunds = AC7; webhooks = AC8), with AC9–AC14
   as cross-cutting gates.
3. The §7 catalog C1–C8 is covered and the §12 layer obligations are closed (F1–F15
   resolved or explicitly answered).
4. Coverage is measured and enforced per D2/Q3 in CI (AC10), and the suite is
   demonstrably deterministic — twice-green, no sleeps, no silent skips (AC11).
5. Required checks pass from the repository root: `pnpm lint`, `pnpm lint:openapi`,
   `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, plus the scripts this
   phase adds; CI is green (AC13).
6. §9 security requirements are verified: no secrets anywhere, no unguarded test
   backdoors, security behaviors asserted, nothing exempt from what it tests (AC14),
   and flagged items handed to Phase 18.
7. Any defects found are fixed or escalated per rule 8/D6 — no known critical defect
   remains open behind a passing suite.
8. §16 ADRs are written for D1, D2 and D5, alongside the implementation.
