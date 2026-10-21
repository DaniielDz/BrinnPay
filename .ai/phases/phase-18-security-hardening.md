# Phase 18 — Security Hardening

| | |
| --- | --- |
| Phase | 18 — Security Hardening |
| Status | **Confirmed (2026-10-13) — D1–D8 and Q1 confirmed by the product authority exactly as recommended (D1–D8 = option (a) each; Q1 deferral confirmed). This specification is ready for implementation.** |
| Depends on | Phase 1 (security baseline, API conventions), Phase 2 (validation pipe, helmet, config module), Phases 3–13 (the controls under review: auth/sessions, RBAC, API keys, customers, payments, idempotency, refunds, webhooks, request/audit logs, rate limiting), Phase 14 (web security headers, route protection, dashboard), Phase 15 (docs surface), Phase 16 (sandbox scenario field, outbound delivery markers), Phase 17 (test baseline, security assertions, coverage ratchet, defect policy), ADR-0001…ADR-0035, `docs/security-baseline.md` |
| Blocks | Phase 26 (release QA requires the security review sign-off this phase produces); Phase 22/24 inherit the deployment-fact handovers recorded here (proxy trust, cookie/HSTS posture, webhook destination lists) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 18 |
| Branch | `feature/phase-18-security-hardening` (checked out, empty of changes) |

## 1. Objective

Perform a **systematic, evidence-based security review** of the complete BrinnPay
surface (Phases 0–17 merged; `main` at `d12739b`), fix the defects it finds, disposition
every accepted residual risk explicitly, and produce the sign-off artifacts the MVP
release (Phase 26) depends on: a completed **OWASP Top 10 checklist** and a recorded
review outcome per roadmap checkbox.

Like Phase 17, this is a *verification* phase: it adds review findings, regression
tests, focused fixes, and documentation — not product features. Where a finding would
require **new product behavior**, the defect policy in §4 rule 2 applies: escalate, do
not invent.

### Roadmap traceability

| Roadmap Phase 18 checkbox | Where |
| --- | --- |
| Authorization review (IDOR prevention) | §6 R1, AC1 |
| Tenant isolation verification | §6 R2, AC2 |
| API security (injection, XSS) | §6 R3, AC3 |
| Web application security review | §6 R4, AC4 |
| Session and authentication review | §6 R5, AC5 |
| Secrets management review | §6 R6, AC6 |
| OWASP Top 10 checklist | §6 R7, AC7 |

## 2. Scope

In scope:

- **The §6 review catalog (R1–R7)**, executed against the running system and the
  codebase, producing a findings log with severity and disposition per item.
- **Discharge of every explicit Phase 18 handover** recorded by prior phases and ADRs
  (§3 F2, §17): audit immutability/isolation (ADR-0023), proxy-trust posture per
  environment (ADR-0025), web headers/CSP residual risk (ADR-0028), outbound delivery
  markers (ADR-0032), log redaction (Phase 11), IP-trust/rate-limit posture (Phase 13),
  docs/examples and sandbox surfaces (Phases 15–16), and the Phase 17 test-tooling/test-
  switch inventory.
- **Focused fixes** for confirmed defects (severity critical/high, and medium where the
  fix is small and behavior-preserving), each with regression tests.
- **Guard-clone consolidation** if D1 is confirmed (Phase 7 OQ-1 discharge: one
  authorization implementation instead of four).
- **The OWASP Top 10 (2021) checklist artifact** (D3) mapping each category to controls,
  verification evidence, and disposition.
- **Dependency vulnerability scanning** if D4 is confirmed (closes the OWASP A06 gap;
  no automated scanning exists today — F8).
- **Accepted-risk register**: reaffirmations (SSRF posture, CSP relaxation, per-account
  login lockout) recorded with rationale and exit criteria so Phase 22/24/26 inherit
  them deliberately rather than by accident.

Explicitly **not** in scope (§12): product features, performance/load testing
(Phase 19), observability (Phase 20), deployment work (Phases 21–24), accessibility
audit (D8), custom error pages (Q1), release QA (Phase 26), ROADMAP.md bookkeeping
beyond this phase's own checkboxes (report-only per Phase 16 Q2 precedent).

## 3. Context and current-state findings

**What exists today** (Phases 0–17 merged; branch `feature/phase-18-security-hardening`
from `d12739b`):

- **API:** NestJS modular monolith with auth, organizations/RBAC, projects/API keys,
  customers, payments, idempotency, refunds, webhooks, request logging, audit logging,
  rate limiting; helmet (CSP disabled — Swagger UI) and CORS with credentials in
  `bootstrap.ts`; global validation pipe; env-driven config with fail-fast boot
  validation (e.g. `WEBHOOK_ENCRYPTION_KEY` demanded, `CORS_ORIGINS` non-empty,
  `TRUST_PROXY_*` combination checks).
- **Web:** single Next.js app (public + docs + auth + dashboard); static security
  headers via `next.config.ts` (ADR-0028); client-side route protection (ADR-0027);
  in-memory access token + `HttpOnly` refresh cookie; docs markdown rendered without
  `dangerouslySetInnerHTML` (unit-asserted).
- **Tests (Phase 17):** API unit/integration/e2e, web unit/jsdom smoke, Playwright
  browser critical flows, coverage ratchet, contract conformance — security behaviors
  (401/403/404 non-disclosure, cookie/header posture, secret redaction, shown-once
  secrets) are asserted inside the critical-flow catalog C1–C8.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | Authorization semantics exist in **four** implementations: the shared `ProjectAccessGuard`/`ProjectScope` (used by webhooks) plus module clones `PaymentsAccessGuard`, `CustomersAccessGuard`, `RefundsAccessGuard`. Phase 7 OQ-1 left phase ownership open, naming Phase 18 the "natural home for authorization-drift removal". Drift between copies is an unmanaged authorization risk. | D1 proposed. |
| F2 | Prior phases and ADRs filed explicit **Phase 18 re-review obligations**: ADR-0023 (audit immutability + tenant cascade), ADR-0025 (proxy trust — "confirm the values of **each** environment"), ADR-0028 (header set + CSP `'unsafe-inline'` review item), ADR-0032 (outbound delivery markers), Phase 11 (log redaction completeness), Phase 13 (IP-trust/normalization review), Phases 15–16 (security-sensitive docs/sandbox parts, scenario field, delivery-path change), Phase 17 (tooling/config/test-switch inventory). | §6 catalog, AC8. |
| F3 | ADR-0019 accepted **SSRF residual risks** for the sandbox: permissive private/loopback destination default, host-based (not IP-pinned) allow/deny lists, no DNS-rebinding/TOCTOU mitigation, no true connect-phase budget. The ADR mandates revisiting "before any such [non-sandbox] deployment". | D6 proposed — reaffirm for MVP, record exit criteria. |
| F4 | ADR-0028 left **CSP `script-src 'unsafe-inline'`** as the largest residual web relaxation, explicitly "recorded as a Phase 18 review item"; removal requires nonce/hash support in the Next.js rendering path. | D5 proposed. |
| F5 | ADR-0024/0025 record that the `account` login rate-limit scope lets an unauthenticated caller keep a known email's login budget spent (**per-account lockout DoS**); the remedy was assigned to "an auth-UX phase" that **does not exist in the roadmap**. Without a disposition this finding has no owner. | D7 proposed. |
| F6 | Phase 14 §7.6 defers a **"full [accessibility] audit" to Phase 18**, but the roadmap scope of Phase 18 is security hardening. The handover predates the roadmap's fixed checkbox list and is an inconsistency, not a requirement. | D8 proposed — out of scope; relocate. |
| F7 | Phase 14 Q6 / Phase 17 Q2 left **custom not-found/error pages** to "Phase 17/18 polish" — a product/UX change with no material security effect (Next.js defaults leak nothing). | Q1 proposed — keep out of scope. |
| F8 | **No dependency vulnerability scanning** exists (no `pnpm audit`/equivalent in scripts or CI). OWASP A06 (Vulnerable and Outdated Components) therefore has no automated control; Phase 23's "advanced CI (… security)" is too late to *discover* the posture. | D4 proposed. |
| F9 | The API serves helmet with **`contentSecurityPolicy: false`** (Swagger UI inline assets). The review must confirm this stays justified: Swagger UI at `/docs` is the only API-served HTML surface, and no contracted route returns HTML. | §6 R3, AC3. |
| F10 | Phase 17 added **browser tests, coverage tooling, and contract conformance** — new configuration and artifact surfaces (traces/screenshots can contain session material; must remain git-ignored and never committed). | §6 R6, AC6. |
| F11 | `WEBHOOK_ALLOW_INSECURE_TEST_KEY` exists with a `DATABASE_URL`-keyed production refusal; the **full inventory** of test-only switches and their production posture has never been enumerated in one place (Phase 17 §9 rule 2 defers the list here). | §6 R6, AC6. |
| F12 | Request logs (three-layer allowlist projection) and audit logs (allowlisted `jsonb` builders, `BEFORE UPDATE` trigger, org cascade) were designed as absence-is-the-control surfaces; Phase 11/12 both hand their **completeness re-review** to this phase. | §6 R2/R6, AC2/AC6. |
| F13 | Phase 13 D11 "referred onward" two availability items with no named owner: a **pending-delivery bound per webhook endpoint** and **per-project sweep fairness**. Phase 10 classified the fairness defect as outside a rate-limiting mandate. They are availability defects, not security controls. | §12 — recorded, referred to Phase 19/backlog; not silently dropped. |
| F14 | ROADMAP.md Phases 4–17 were marked completed in `d12739b`; this phase's seven checkboxes are unchecked. Bookkeeping for this phase happens at merge time as a separate `chore/*` change (Phase 16 Q2 / Phase 17 Q1 precedent). | §18 DoD item 9. |

## 4. Domain rules (normative)

1. **The specification is the source of truth.** Review findings are judged against
   `docs/security-baseline.md`, the phase specifications, the ADRs, and the master
   specification — never against ad-hoc expectations.
2. **Defect policy (D2).** A finding that shows behavior contradicting an existing
   specification is a **defect**: fix it in a focused `fix/*` change with a regression
   test, inside this phase's window. A finding whose remedy requires **new product
   behavior** (new endpoints, new UX, new domain rules) is **escalated** to the product
   authority with options — never silently implemented, never closed by weakening a
   test.
3. **No control may be weakened to close a finding.** An accepted risk is recorded with
   rationale, blast radius, and exit criteria (checklist entry; ADR only if a prior
   decision actually changes). "Delete the assertion", "widen the allowlist", or
   "disable the guard" is never a disposition.
4. **Evidence-based sign-off.** Each of the seven roadmap checkboxes and each OWASP
   category maps to concrete evidence: an automated test where behavior is testable, or
   a documented inspection with file/behavior references where it is not. A checkbox is
   not satisfied by "reviewed and looked fine".
5. **Review the whole surface, not only the new code.** Phases 3–17 shipped under
   per-phase reviews; this phase is the first **systematic, cross-module** pass
   (cross-tenant journeys, guard composition, config interplay). Phase 17's critical
   flows C1–C8 are the journey skeleton the review walks.
6. **Fixes ride the existing architecture.** Fixes reuse existing guards, config
   patterns, and test scaffolding; no new frameworks, no microservices, no speculative
   hardening beyond what findings require (master specification; AGENTS.md).
7. **The phase's own work obeys the controls it reviews.** No secrets in findings
   documents, checklists, test fixtures, or PR descriptions; no test backdoors; every
   new check passes `pnpm lint/typecheck/test/test:e2e/build` (AGENTS.md).
8. **Handovers are discharged or re-owned, never dropped.** Every §3 finding and §17
   input ends the phase with an explicit disposition: fixed, reaffirmed-and-recorded,
   or referred to a named later phase.

## 5. API behavior

**No API surface changes are planned.** No new endpoints, no contract schema changes,
no rate-limit class changes, no pagination or error-envelope changes.

What the phase may change, narrowly:

- **Internal behavior fixes** where an endpoint's current behavior contradicts its
  documented contract or a phase specification (defect per rule 2) — the contract
  already being canonical (ADR-0012), a defect fix aligns implementation to contract,
  not the reverse; if the contract itself is wrong, apply the in-place refinement
  procedure and record it.
- **Guard consolidation** (D1): route-by-route migration to the shared
  `ProjectAccessGuard`/`ProjectScope` with **zero observable behavior change** — same
  statuses, same error codes, same scoping — proven by the existing suites staying
  green before any clone is deleted.

Everything else — statuses, error codes, auth modes, capabilities — stays exactly as
published in `docs/openapi.yaml`.

## 6. Review catalog (normative)

Each area (R1–R7) maps to a roadmap checkbox. For every area the review produces
findings logged as: *id, location, description, severity (critical/high/medium/low/info),
specification reference, disposition (fix / accept / refer), evidence*. Severity
definitions: **critical** = exploitable cross-tenant data access, auth bypass, secret
exposure, or injection; **high** = control bypass with bounded blast radius or a
material weakening of a documented guarantee; **medium** = defense-in-depth gap or
unmanaged accepted risk; **low/info** = hygiene.

### R1 — Authorization review (IDOR prevention)

- Enumerate **every** authenticated route (session mode and API-key mode) and verify
  its guard chain and capability against the Phase 4 capability registry and the
  publishing phase's authorization section: organizations/members/invitations,
  projects, API keys, customers, payments, refunds, webhook endpoints/events/deliveries
  (incl. replay), idempotency, request logs, audit logs, health exclusions.
- Verify **IDOR negative cases** per resource family: a valid-format id belonging to
  another organization, project, or environment returns the documented status with
  **non-disclosure** semantics (404 for cross-scope, 403 only where the spec defines
  it), in both auth modes. ID opacity is never treated as a control (ADR-0001).
- Verify the **dual-mode boundaries** resolve to exactly one scope (no request can act
  as both session and API key; environment conflicts are 422), and that session-only
  surfaces (request logs, audit logs, organizations) reject `sk_…` keys.
- **Guard-clone drift analysis** (F1/D1): line-by-line behavioral comparison of the
  three clones against `ProjectAccessGuard`; any semantic difference found is a defect
  (rule 2), not a refactor note.
- Capability checks are enforced server-side; "the dashboard hides the button" is never
  accepted as authorization (Phase 14 D5 rationale; Phase 17 §9 rule 7).

### R2 — Tenant isolation verification

- Walk each resource's service/query layer and verify **organization/project scoping
  is applied by construction** on every read and write path, including: list queries,
  retrieve-by-id, mutations with foreign ids (refund → parent payment's project;
  webhook delivery → endpoint → project), cascades, and count/aggregate paths.
- Verify **cross-environment isolation** (TEST vs LIVE) for projects, keys, payments,
  customers, webhooks — including the dashboard's environment selector not leaking
  records via URL state or cached lists (Phase 9 §"UI must not…").
- Re-review **audit log immutability and tenant cascade** per ADR-0023 (F2): no
  update/delete code path, trigger installed by migration, plain-id columns with no
  `SET NULL`, organization cascade the only deletion path; request-log org scoping and
  30-day retention behavior per ADR-0020.
- Cross-tenant negative cases must exist in the automated suite for every resource
  family (Phase 17 added journey-level cases; this review closes per-resource gaps).

### R3 — API security (injection, XSS)

- **Injection:** verify all external input passes the global validation pipe/DTOs;
  verify Prisma usage is parameterized everywhere (flag any `queryRaw`/`executeRaw`/
  string-built SQL for justification); verify no string interpolation into log formats
  or internal queries; verify path/id parameters are validated as UUIDs before lookup.
- **XSS/error leakage:** verify error responses carry no stack traces, DB details,
  driver messages, or internal hostnames (error envelope per API conventions); verify
  JSON responses only from contracted routes (no HTML reflection of user input).
- **CORS posture:** `credentials: true` only for the configured `CORS_ORIGINS`
  allowlist; verify the allowlist cannot be widened by env accident (boot validation),
  and the exposed headers remain the non-secret rate-limit budget fields only.
- **Helmet/Swagger** (F9): confirm `/docs` Swagger UI is the only API-served HTML
  surface and the CSP-off decision remains documented and minimal; confirm `/docs`
  serves the canonical contract only and 404s under `/api/v1` (Phase 17 AC12).
- **Mass-assignment-style risks:** DTO whitelists reject unknown properties (Validation
 Pipe configuration), so client-supplied `organization_id`/`role`/`status` fields can
  never set server-owned state.

### R4 — Web application security review

- Verify the §7.5/ADR-0028 header set **as served** (browser layer or built app):
  CSP directives, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, nosniff,
  referrer policy, permissions policy, HSTS present iff `WEB_SECURE` (production
  default), `'unsafe-eval'` absent from production CSP.
- CSP residual relaxation (F4/D5): disposition `script-src 'unsafe-inline'` —
  reaffirm with exit criteria or schedule nonce/hash work (escalation if chosen).
- **Token/session rules:** access token in memory only (never web storage — verify in
  the browser layer); refresh cookie `HttpOnly`+path-scoped+SameSite+Secure-default;
  logout revokes server-side and clears the cookie; no tokens/keys/secrets in URLs,
  rendered output, console logs, or `NEXT_PUBLIC_*` vars.
- **Route protection parity** (ADR-0027): every authenticated dashboard route redirects
  unauthenticated users, **and** the API independently enforces the same authorization
  — a request forged past the UI hits 401/403/404, never data.
- **Public-area hygiene:** no authenticated data, internal architecture details, or
  environment specifics on public routes; docs examples remain placeholder-only
  (Phase 15 consistency mechanism); markdown/docs rendering keeps the
  no-`dangerouslySetInnerHTML` property (Phase 15 unit assertion).
- **Open-redirect-style risks:** any redirect targets (post-login return paths, etc.)
  are same-origin/allowlisted or absent.

### R5 — Session and authentication review

- **Password:** Argon2id parameters meet the documented policy; no plaintext, no
  logging, no transmission of passwords anywhere in the flow.
- **JWT:** signing secret strength/validation (issuer/audience/expiry as configured),
  no `alg` confusion (library defaults verified), access-token TTL as specified,
  secrets never logged.
- **Refresh sessions:** rotation with reuse detection (a replayed old token invalidates
  the family — verify the test still passes and the behavior matches Phase 3 D-rules);
  server-side revocation on logout; cookie cleared on all terminal paths.
- **Enumeration resistance:** registration and login failures are generic; timing
  posture acceptable (documented, not necessarily constant-time beyond password
  verification).
- **Auth rate limiting:** `auth.*` classes enforced through the same client-identity
  resolver (ADR-0025 single-model rule); **lockout DoS disposition** (F5/D7): reaffirm
  per-account budget as accepted for the MVP sandbox with recorded rationale and exit
  criteria, or escalate a remedy.
- **Proxy trust per environment** (ADR-0025 mandate): confirm `TRUST_PROXY_HOPS=0`
  and empty CIDR allowlist in local Compose and CI; record the **required values for
  staging/production** (real hop count, proxy addresses only) as an inherited
  deployment-fact obligation for Phases 22/24 — those environments do not exist yet,
  so "confirm each environment" is discharged as *confirm what exists + specify what
  must be set*.

### R6 — Secrets management review

- **Repository:** no committed secrets (spot-check tracked files, `.env*` git-ignored,
  `.env.example`-style files carry placeholders only); docker-compose local values
  documented as non-production defaults.
- **Config demands:** boot fails fast on missing/invalid security-critical config
  (`JWT` secret handling, `WEBHOOK_ENCRYPTION_KEY` demanded even under test, CORS
  non-empty, trust-proxy combination checks) — verify each refusal is tested.
- **Credential lifecycle:** API keys generated from CSPRNG, stored hashed, shown once,
  never logged/returned later; webhook signing secrets shown once, HMAC over exactly
  the bytes sent, never logged; encryption key never logged; key rotation and
  revocation work as specified.
- **Log redaction completeness** (Phase 11 handover, F12): request-log allowlist
  (three layers) and audit-log builders admit no field capable of holding passwords,
  API keys, tokens, `Idempotency-Key` values, webhook secrets, or raw bodies; error
  paths (including 4xx/5xx) do not bypass the allowlist; structured logger redaction
  verified for auth and webhook paths.
- **Test-only switches** (Phase 17 inventory handover, F11): enumerate every
  configuration flag that relaxes a control for testing (e.g.
  `WEBHOOK_ALLOW_INSECURE_TEST_KEY`), verify each is refused under production
  configuration, documented as test-only, and listed in the checklist.
- **Artifacts** (F10): Playwright traces/screenshots/videos and coverage reports remain
  git-ignored, captured on failure only, never committed or pasted into PRs/docs.
- **Dashboard surfacing:** API-key plaintext and webhook secrets appear exactly once,
  nowhere else in the UI (lists, details, toasts, URLs).

### R7 — OWASP Top 10 checklist (2021)

Produce the checklist artifact (D3) covering A01–A10 with, per category: applicable
threats for BrinnPay's sandbox context, the controls in place (referencing phase
specs/ADRs/code areas), verification evidence (tests/inspections from R1–R6), findings
and dispositions, and residual accepted risks. Notable categories needing explicit
answers: **A03 Injection** (validation + Prisma), **A05 Misconfiguration** (helmet
posture, CORS, trust proxy, cookie/HSTS defaults, compose defaults), **A07 Auth
Failures** (Argon2id, rotation/reuse detection, rate limits, lockout DoS acceptance),
**A08 Data Integrity Failures** (JWT handling, dependency audit per D4), **A09 Logging
& Monitoring Failures** (request/audit logs, redaction — noting Phase 20 owns metrics),
**A10 SSRF** (ADR-0019 posture + D6 reaffirmation + ADR-0032 zero-HTTP markers).

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **None planned.** If a defect fix genuinely requires a schema change, it follows ADR-0011 (owning-phase migration) and is escalated per rule 2 — not invented mid-review. |
| Findings log / checklist | Committed markdown artifacts (D3); contain file references and behavior descriptions only — **never working exploits, real credentials, session material, or production hostnames**. |
| Regression tests | Follow Phase 17 layer discipline (D4 data strategy: API-driven fixtures, unique per-run data, no DB seeding, no sleeps). |
| Configuration | Any new variable (e.g. audit-scan thresholds if D4 needs one) is non-secret, documented in `.env.example`, declared explicitly. |
| Review evidence | Test names/IDs and file references cited in the checklist must be reproducible from the repository root; no evidence that exists only in a chat or local notes. |

## 8. Security requirements (for this phase's own work)

1. Findings documents and the OWASP checklist are written as if public (they may feed
   Phase 25's SECURITY policy): no exploit recipes against a live deployment, no
   secrets, no PII.
2. Fixes touching authentication, authorization, tenant isolation, cryptographic
   handling, or secret exposure receive an **explicit security review** in the PR
   (AGENTS.md), separate from ordinary review.
3. The phase introduces **no** new bypass of authentication, authorization, validation,
   rate limiting, or tenant isolation — including "temporary" review helpers.
4. Dependency tooling added by D4 reads lockfiles/registries only; it does not execute
   package post-install scripts beyond what the existing package manager already does,
   and its CI output does not leak tokens.
5. No scanning/fuzzing tool is pointed at any non-local deployment; everything runs
   against the local compose stack or static analysis of the repository.

## 9. CI and tooling requirements

- The existing pipeline order stays (validate → lint → typecheck → unit → migrate →
  `test:e2e` → build). If D4 is confirmed, a dependency-audit step is added with the
  confirmed blocking policy (advisory vs fail-on-high/critical); it must be runnable
  locally with the documented commands.
- No new test layers: verification reuses Phase 17's L1–L8. New automated checks are
  ordinary unit/e2e suites in the existing harnesses.
- Required checks from the repository root remain the gate: `pnpm lint`,
  `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`
  (plus the audit script if D4).

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — Authorization/IDOR.** R1 completed: every authenticated route inventoried
   against its spec-defined guard/capability; per-resource cross-scope negative cases
   exist and pass in both auth modes; guard-clone disposition per D1 executed (clones
   deleted, shared guard only) **or** explicitly reaffirmed as accepted with recorded
   rationale; zero open critical/high authorization findings.
2. **AC2 — Tenant isolation.** R2 completed: scoping verified by construction per
   resource family with automated cross-tenant and cross-environment negative cases;
   audit immutability/cascade and request-log scoping re-reviewed per ADR-0023/F12
   with evidence; zero open critical/high isolation findings.
3. **AC3 — API security.** R3 completed: injection and error-leakage checks evidenced;
   CORS/helmet/Swagger postures documented and tested; validation-pipe whitelisting
   verified; no API-served HTML beyond Swagger UI; zero open critical/high findings.
4. **AC4 — Web application.** R4 completed: header set verified as served; CSP
   residual risk dispositioned per D5; token-storage, route-protection parity, and
   public-area hygiene evidenced (browser-layer tests where applicable); zero open
   critical/high findings.
5. **AC5 — Session and authentication.** R5 completed: password/JWT/refresh-rotation/
   enumeration/rate-limit postures evidenced; lockout DoS dispositioned per D7;
   proxy-trust values confirmed for existing environments and required values recorded
   for Phases 22/24 (ADR-0025 discharge); zero open critical/high findings.
6. **AC6 — Secrets management.** R6 completed: repository/config/credential-lifecycle/
   redaction/test-switch/artifact checks evidenced; every test-only switch inventoried
   with its production refusal test; zero secrets found in code, fixtures, logs,
   artifacts, or documents; zero open critical/high findings.
7. **AC7 — OWASP checklist.** The D3 artifact is committed, covers A01–A10 with
   evidence references from AC1–AC6, lists every accepted residual risk with exit
   criteria, and matches the findings log (no category hand-waved).
8. **AC8 — Handovers discharged.** Every §3 finding (F1–F14) and every §17 input has a
   recorded disposition; the Phase 13 D11 referrals (F13) are explicitly referred to a
   named owner or backlog, not dropped.
9. **AC9 — Fixes verified.** Every fix ships with a regression test that fails without
   the fix; the full Phase 17 suite (unit, integration, e2e, browser, contract,
   coverage thresholds) stays green; no assertion was weakened to make a finding pass
   (§4 rule 3).
10. **AC10 — Sign-off.** A review-outcome record exists (in the checklist or phase
    appendices): per-checkbox verdict, findings summary by severity, accepted-risk
    register, and the deployment-fact handovers for Phases 22/24 — sufficient for
    Phase 26's "security review sign-off" QA item.
11. **AC11 — Required checks.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
    `pnpm test`, `pnpm test:e2e`, `pnpm build` (plus the D4 script if confirmed) pass
    from the repository root; CI is green.

## 11. Testing requirements

- **Baseline:** the complete Phase 17 suite is the regression net and the source of
  existing security assertions; it must stay green throughout (AC9).
- **Gap-closing tests:** for every R1/R2 family lacking a per-resource cross-scope
  negative case, add e2e assertions in the existing suites (same harness, same
  fixtures pattern) — no new test project.
- **Fix regression tests:** each defect fix adds the minimal test that fails before
  and passes after (Phase 17 rule 8/D6 pattern); characterization tests precede the
  D1 guard migration so zero-behavior-change is proven, not claimed.
- **Verification-by-test vs inspection:** where a property is already asserted by
  Phase 17 flows (cookie posture, header set, shown-once secrets, redaction), cite the
  test as evidence instead of duplicating it; where it is not, add the assertion.
- **Configuration refusals:** every production-refusal rule (test switches, trust
  proxy combinations, config demands) has a unit test at the config layer (existing
  `configuration.spec.ts` pattern).
- **No new layers, no new frameworks.** Playwright usage stays within the bounded
  critical set; any browser-based header/parity evidence extends
  `test/browser/critical-flows.spec.ts` rather than spawning new configurations.
- All testing follows the Phase 17 determinism, data, and no-secrets rules (§8/§9
  of that specification remain binding on shared infrastructure).

## 12. Out of scope

- **Product/feature changes**: new endpoints, new UX, new domain rules. Including:
  custom not-found/error pages (Q1), progressive login delays/captcha (D7 remedy if
  escalated — needs its own product decision), hardened-mode SSRF IP-pinning (D6
  exit-criteria work), CSP nonce implementation (D5 exit-criteria work).
- **Accessibility audit** (D8 — Phase 14 §7.6 handover conflict with the roadmap
  scope; relocate to Phase 26 QA or a standalone change).
- **Performance/load testing** (Phase 19 — which also inherits F13's pending-delivery
  bound and sweep-fairness referrals as availability work), **observability/metrics**
  (Phase 20), **production Docker/secrets injection** (Phase 21), **staging/production
  deployment** (Phases 22/24 — they consume this phase's deployment-fact handovers),
  **CI/CD expansion beyond the D4 audit step** (Phase 23), **release QA** (Phase 26).
- **SAST/DAST product rollouts, bug-bounty programs, external penetration tests**
  (beyond MVP scope; the checklist records this as a known limitation with the manual
  review as compensation).
- **Mutation/fuzz testing, cross-browser matrices** (rejected in Phase 17, unchanged).
- **ROADMAP.md bookkeeping** for other phases (report-only; this phase's own checkboxes
  update as a separate `chore/*` at merge — F14).
- **`.ai/` artifact restructuring**, README/CONTRIBUTING/SECURITY content (Phase 25),
  real payment processing / card data / microservices (master specification).

## 13. Decisions (D1–D8 — confirmed 2026-10-13)

Each row states the options and the confirmed option (product authority confirmed all
recommendations on 2026-10-13; Q1 answered in §14).

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Guard-clone consolidation (Phase 7 OQ-1; F1) | **(a) Consolidate inside this phase** as a behavior-preserving `refactor/*` change (migrate payments/customers/refunds to `ProjectAccessGuard`/`ProjectScope`, characterization tests first, delete clones) — the authorization review is exactly when one wants one authorization implementation, and Phase 7 named this phase the natural home. (b) Standalone `refactor/*` before this phase's review — same change, but the review then cannot verify a single guard story. (c) Keep four implementations — rejects the drift finding; requires explicit acceptance of the risk. | **Confirmed (a) 2026-10-13** |
| D2 | Defect disposition during the review | **(a) Phase 17 D6 policy verbatim:** fix spec-contradicting defects in focused `fix/*` changes with the strict assertion intact; escalate anything needing new behavior or a spec change. (b) Log-and-defer all fixes to later phases — a "security reviewed" claim cannot stand behind known open criticals. | **Confirmed (a) 2026-10-13** |
| D3 | OWASP checklist artifact (F8/AC7) | **(a) Committed markdown in `docs/`** (e.g. `docs/security-review.md`): doubles as roadmap-checkbox evidence and feeds Phase 25's SECURITY policy; sandbox threat model is not sensitive. (b) Keep it under `.ai/` — internal-only, but then the repo's docs surface lacks the security posture record Phase 25 will want. (c) No artifact, verbal sign-off — unverifiable; rejects the roadmap's "checklist" wording. | **Confirmed (a) 2026-10-13** |
| D4 | Dependency vulnerability scanning (F8, OWASP A06) | **(a) Add a `pnpm audit`-equivalent CI step now, failing on high/critical for production dependencies** — the OWASP checkbox requires an answer for A06 today, and Phase 23 is too late to discover the posture; the step is small and inherits forward. (b) Advisory-only (report, never fail) — visibility without red-CI risk, weaker guarantee. (c) Defer entirely to Phase 23 — leaves A06 with no automated control through the security-review phase itself. | **Confirmed (a) 2026-10-13** |
| D5 | CSP `script-src 'unsafe-inline'` (F4, ADR-0028) | **(a) Reaffirm as accepted residual risk for the MVP**, recorded in the checklist with exit criteria (nonce/hash support in the Next.js rendering path; revisit post-MVP) — ADR-0028 already rejected speculative work, and nonce CSP is a rendering-path change, not hardening polish. (b) Implement nonce/hash CSP now — closes the largest residual web relaxation, but is a web-architecture change needing its own design and risk of breaking the dashboard; would need escalation with a plan. | **Confirmed (a) 2026-10-13** |
| D6 | SSRF posture (F3, ADR-0019) | **(a) Reaffirm the permissive sandbox default and its compensating controls** (validation, no redirects, bounded timeouts, no credential forwarding, sanitized logs, optional allow/deny lists); record in the checklist: not safe outside sandbox context, exit criteria = IP pinning + resolved-address revalidation before any non-sandbox deployment (Phases 22/24 obligation). (b) Implement hardened mode (IP pinning/rebinding mitigation) now — real work the ADR explicitly deferred; escalate with scope if chosen. | **Confirmed (a) 2026-10-13** |
| D7 | Per-account login lockout DoS (F5, ADR-0024/0025) | **(a) Accept for the MVP sandbox**, documented in the checklist with rationale (intended cost of bounding credential guessing; sandbox accounts carry no real value; remedy needs product design — progressive delay/challenge/per-attacker dimension) and exit criteria (revisit with any auth-UX work or before production-grade accounts). (b) Implement a remedy now — new auth behavior with UX implications; requires product specification first (rule 2 escalation). | **Confirmed (a) 2026-10-13** |
| D8 | Accessibility "full audit → Phase 18" handover (F6, Phase 14 §7.6) | **(a) Out of scope for Phase 18; relocate** the full accessibility audit to Phase 26 QA (or a standalone change) — the roadmap fixed Phase 18's scope as security hardening, and folding a11y into it dilutes both. The §7.6 baseline already shipped in Phase 14. (b) Include an accessibility audit in this phase — satisfies the stray handover sentence but contradicts the roadmap checkbox list. | **Confirmed (a) 2026-10-13** |

## 14. Open questions — answered

1. **Q1 — Custom not-found/error pages (F7).** Phase 14 Q6 and Phase 17 Q2 both left
   this to "Phase 17/18 polish". It is a product/UX change with no material security
   effect. **Decision (2026-10-13):** out of scope for Phase 18; handle as a standalone
   `feature/*` web change or fold into Phase 26 polish. (Deferral confirmed, as
   recommended.)

## 15. Architectural decisions to record

To be written during implementation as needed (next ADR numbers, `.ai/decisions/`):

- **Dependency-vulnerability gating** (if D4(a)): tool/command, blocking policy, why
  fail-on-high/critical, what is deliberately not scanned (dev-only caveats posture).
- **Security review outcome / accepted-risk register** (AC10): one record binding the
  checklist's reaffirmations (D5/D6/D7), the proxy-trust deployment-fact handover for
  Phases 22/24, and the F13 referrals — so the next phases inherit a single artifact
  instead of re-deriving it from six ADRs.
- Guard consolidation (D1) needs **no new ADR** if behavior is unchanged (refactor,
  characterization-tested); if the review finds and changes a semantic difference, the
  fix PR cites the specification that made one behavior a defect.

## 16. Implementation considerations (not requirements)

- **Run the review area-by-area (R1→R7)**, logging findings as you go; do not fix
  inline except for trivial criticals — keeps the findings log complete even if the
  phase window is cut short.
- **Inventory first, verify second:** for R1/R2, generate the route/guard inventory
  from the controllers (decorators are the source) and diff it against the spec tables
  before writing negative tests — the diff *is* the gap list.
- For D1, migrate **one module per commit** (payments, then customers, then refunds),
  running the full suite each time; delete the clones only when all three suites pass
  against the shared guard.
- Cite existing Phase 17 tests by name in the checklist — it keeps the artifact short
  and makes re-verification cheap for Phase 26.
- Keep the checklist artifact maintainable: one table per OWASP category, evidence as
  test/file references, no prose walls; it will be re-read at Phase 26 sign-off and
  possibly amended at Phase 25.
- When in doubt whether a finding is a defect or a preference, apply rule 2: check the
  specification first; preferences are info-severity findings, not fixes.
- Time-box exploratory testing (manual curl/browser probing of auth and isolation
  edges) and convert every probe that reveals a gap into an automated test immediately
  — unrecorded manual findings do not count as evidence (rule 4).

## 17. Dependencies and handovers

**Inputs (everything under review):** Phases 0–17 as merged (`d12739b`); specifically
Phase 3 (auth/session rules, auth rate limits), Phase 4 (capability registry, tenant
model), Phase 5 (API key scheme), Phases 6–9 (resource guards/scoping — incl. Phase 7
OQ-1), Phase 8 (idempotency concurrency), Phase 10 (webhook signing, SSRF posture
ADR-0019, secret handling ADR-0017), Phases 11–12 (log redaction, audit immutability
ADR-0023), Phase 13 (rate-limit architecture ADR-0024, proxy trust ADR-0025),
Phase 14 (web headers ADR-0028, route protection ADR-0027, Q6), Phase 15 (docs
consistency, placeholder examples), Phase 16 (scenario field, outbound markers
ADR-0032), Phase 17 (test baseline, security assertions, tooling/switch inventory,
Q2), `docs/security-baseline.md`, `docs/api-conventions.md`, ADR-0001…ADR-0035.

**Discharged by this phase (on implementation):**

- Phase 7 OQ-1: guard consolidation ownership — D1.
- Phase 11: "log redaction review" handover — §6 R6/AC6.
- Phase 12: "immutability and tenant-isolation review" handover — §6 R2/AC2.
- Phase 13: "security hardening review of IP trust" handover — §6 R5/AC5.
- Phase 14 §7.6: accessibility full-audit handover — D8 (relocated, not dropped).
- Phase 14 Q6 / Phase 17 Q2: custom error pages — Q1 (deferral confirmed or scoped).
- Phase 15/16: "security-sensitive parts flagged for Phase 18" — §6 R4/R6, ADR-0032
  in R7.
- Phase 17 §9 rule 2 / F11: test-only switch inventory — §6 R6/AC6.
- ADR-0023 / ADR-0025 / ADR-0028 / ADR-0032: explicit Phase 18 re-review mandates —
  §6 R2/R5/R4/R7, AC2/AC5/AC4/AC7.
- Master specification MVP #20 precursor and `docs/security-baseline.md` §5
  ("Security hardening review (OWASP, IDOR tests) → Phase 18") — the §10 AC set.

**Blocks / hands forward:** Phase 26 (AC10 sign-off record is its QA input);
Phases 22/24 (deployment-fact handovers: `TRUST_PROXY_*` real values, `COOKIE_SECURE`
/`WEB_SECURE` true, webhook destination allow/deny lists, SSRF exit criteria);
Phase 19 (F13 availability referrals); Phase 25 (checklist feeds SECURITY policy
content).

## 18. Definition of done

The phase is complete only when:

1. D1–D8 confirmed and Q1 answered (the Status row records the decisions).
2. All seven roadmap checkboxes are satisfied and traced to §10 acceptance criteria
   (authorization = AC1; tenant isolation = AC2; API security = AC3; web = AC4;
   session/auth = AC5; secrets = AC6; OWASP checklist = AC7), with AC8–AC11 as
   cross-cutting gates.
3. The §6 catalog R1–R7 is executed and every §3 finding (F1–F14) has a recorded
   disposition (AC8).
4. All confirmed defects are fixed with regression tests, or explicitly escalated with
   options — no known critical/high finding remains open behind a green pipeline
   (AC9, §4 rule 2).
5. The OWASP checklist artifact is committed and consistent with the findings log
   (AC7), and the accepted-risk register plus Phase 22/24 deployment-fact handovers
   are recorded (AC10).
6. Required checks pass from the repository root and CI is green (AC11); nothing the
   phase added is exempt from the controls it reviewed (§4 rule 7).
7. Security-sensitive fixes carry the explicit security review noted in their PRs
   (§8 rule 2).
8. Any ADRs required by §15 are written alongside the implementation.
9. This phase's ROADMAP.md checkboxes are updated at merge time as a separate
   `chore/*` change (F14; Phase 16 Q2 precedent).
