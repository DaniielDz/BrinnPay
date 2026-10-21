# Security Review — Phase 18 (OWASP checklist, IDOR and tenant-isolation verification)

- **Status:** Accepted — 2026-10-13
- **Phase:** 18 (security hardening)
- **Artifact of record:** D3(a) — committed markdown; feeds Phase 25's SECURITY policy
  and Phase 26's sign-off QA.
- **Reviewed baseline:** Phases 0–17 as merged (`d12739b`), plus this phase's changes
  on `feature/phase-18-security-hardening` (D1 guard consolidation, D4 dependency
  gating).
- **Method:** the R1–R7 catalog of `.ai/phases/phase-18-security-hardening.md` §6,
  evidence-based per §4 rule 4. Every claim below cites a test or a file/behavior
  reproducible from the repository root. No secrets, working exploits, session
  material, or production hostnames appear in this document (§8 rule 1).

How to re-verify: from the repository root, `pnpm lint`, `pnpm lint:openapi`,
`pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, `pnpm audit:deps`
(local databases: `docker compose -f docker/compose.yml up -d` then
`pnpm --filter @brinnpay/api prisma:migrate:deploy`). Test names cited below appear
in the suites of `apps/api/test/`, `apps/api/src/**/*.spec.ts`,
`apps/web/**/*.spec.ts(x)`, and `apps/web/test/browser/`.

## 1. Findings log (R1–R7)

Severity definitions are the phase spec's (§6). Dispositions are *fix* (spec
defect, fixed in this phase), *accept* (recorded residual risk with exit criteria),
or *refer* (named later phase).

| Id | R | Location | Finding | Severity | Spec ref. | Disposition | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P18-01 | R1 | `apps/api/src/{payments,customers,refunds}` | Authorization semantics existed in four implementations (shared guard + three module clones; F1). Drift between copies is an unmanaged authorization risk. No semantic drift was observed: the line-by-line comparison found the clones behaviorally identical to the shared guard. | medium | D1, Phase 7 OQ-1 | **fix** — consolidated onto `DualModeAccessGuard`/`ProjectAccessGuard`; clone guards, scope decorators, and their specs deleted; characterization specs added first | `apps/api/src/common/project-scope/project-access.guard.spec.ts`, `project-scope.spec.ts`; full e2e suite green (19 suites / 185 tests) |
| P18-02 | R1 | every authenticated route | IDOR negative cases exist per resource family in both auth modes; cross-scope reads answer 404 (non-disclosure), 403 only where the capability matrix defines it; session-only surfaces reject `sk_…` keys. Zero open critical/high authorization findings. | info | AC1 | verified — no action | `payments.e2e-spec.ts` "cross-project and cross-environment lookups …"; `customers.e2e-spec.ts` "tenant isolation: strangers and cross-project ids are 404 everywhere", "api-key mode: cross-project and cross-environment targets are 404"; `refunds.e2e-spec.ts` "enforces key environment and session membership…", "enforces member/viewer read-only access…"; `webhooks.e2e-spec.ts` "enforces the capability matrix…", "API-key mode: … another project is 404"; `projects.e2e-spec.ts` "tenant isolation: non-members get 404 everywhere", "revoke: … cross-project revocation is 404"; `organizations.e2e-spec.ts` "tenant isolation: a non-member never learns an organization exists" |
| P18-03 | R2 | audit logging | ADR-0023 re-review: no update/delete code path for entries; `BEFORE UPDATE` trigger installed by migration; plain-id columns without `SET NULL`; organization cascade is the only deletion path; tenant binding asserted in suite. | info | ADR-0023, F2, F12 | verified — no action | `audit-logs.e2e-spec.ts` "keeps entries append-only in the database and bound to their organization (AC9)", "never persists a secret, email or free text in any entry (AC10)", "rolls a mutation back when its audit insert fails…" |
| P18-04 | R2 | request logging | ADR-0020 re-review: request-log rows scoped to project+environment by construction; 30-day retention enforced; environment semantics asserted. | info | ADR-0020, F12 | verified — no action | `request-logs.e2e-spec.ts` "applies the D1 environment semantics and never crosses projects (AC9)", "drops rows past retention…" |
| P18-05 | R2 | cross-environment | TEST/LIVE never mixed for payments, customers, webhooks, keys, refunds — including dashboard-selector concerns (URL state carries no records; lists are API-scoped). Zero open critical/high isolation findings. | info | AC2 | verified — no action | cross-environment cases cited in P18-02 (key-mode sections) |
| P18-06 | R3 | Prisma usage | Exactly two raw-SQL call sites, both parameterized tagged templates: refunds parent-payment row lock (`FOR UPDATE`) and the readiness `SELECT 1`. No string-built SQL anywhere in `apps/api/src`. | info | R3 | verified — no action | `apps/api/src/refunds/refunds.service.ts:93`, `apps/api/src/prisma/prisma.service.ts:37` |
| P18-07 | R3 | validation surface | Global `ValidationPipe` with `whitelist: true` + `forbidNonWhitelisted: true`; DTO whitelists reject unknown properties, so client-supplied `organization_id`/`role`/`status` can never set server-owned state. | info | R3, AC3 | verified — no action | `apps/api/src/common/validation.ts`; e2e 400-cases throughout the resource suites |
| P18-08 | R3 | error envelope | 4xx/5xx responses carry the contracted envelope only; no stack traces, DB/driver messages, or hostnames; JSON only from contracted routes; the only API-served HTML is Swagger UI at `/docs` (helmet CSP stays off solely for it — F9 confirmed justified; `/docs` 404s under `/api/v1`). | info | R3, F9, AC3 | verified — no action | `apps/api/src/common/filters/api-exception.filter.ts`; `apps/api/src/bootstrap.ts`; `contract-conformance.e2e-spec.ts` "validates the error envelope…" |
| P18-09 | R4 | web headers | Header set as served matches ADR-0028: CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff, referrer policy, permissions policy; HSTS iff `WEB_SECURE`; `'unsafe-eval'` absent from production CSP. Token in memory only (never web storage); refresh cookie `HttpOnly` + path-scoped + SameSite + Secure-default; logout clears cookie server-side. Route-protection parity holds — forged API calls past the UI hit 401/403/404. | info | R4, ADR-0027/0028, AC4 | verified — no action | `apps/web/next.config.ts`; `apps/web/test/browser/critical-flows.spec.ts` (critical flows C1–C8); `apps/api/test/auth.e2e-spec.ts` |
| P18-10 | R4 | CSP `script-src 'unsafe-inline'` | Largest residual web relaxation (F4); removal requires nonce/hash support in the Next.js rendering path. | medium | D5, ADR-0028 | **accept** — residual risk AR-1 (§4) | D5 decision 2026-10-13; exit criteria recorded |
| P18-11 | R5 | password/JWT/sessions | Argon2id explicit (`type: argon2id`); JWT demands a strong secret at boot outside `NODE_ENV=test` (length-checked, generation hint); refresh rotation with reuse detection green in suite; logout revocation asserted; login/registration failures generic. | info | R5, AC5 | verified — no action | `apps/api/src/auth/password.service.ts`; `apps/api/src/config/configuration.ts` `resolveJwtSecret`; `apps/api/src/config/configuration.spec.ts`; `apps/api/test/auth.e2e-spec.ts` |
| P18-12 | R5 | auth rate limiting | `auth.*` classes enforced through the single client-identity resolver (ADR-0025 single-model rule); per-account login budget bounds credential guessing but lets a caller spend a known email's budget (**per-account lockout DoS**, F5). | medium | D7, ADR-0024/0025 | **accept** — residual risk AR-3 (§4) | `apps/api/test/rate-limits.e2e-spec.ts`; `apps/api/src/rate-limiting/`; D7 decision 2026-10-13 |
| P18-13 | R5 | proxy trust | ADR-0025 per-environment discharge: `TRUST_PROXY_HOPS=0` + empty CIDR allowlist confirmed in local Compose and CI; required values for staging/production recorded as deployment-fact handover (§5). | info | ADR-0025, F2 | verified — handover recorded | `docker/compose.yml:74-75`; `apps/api/.env.example`; `apps/api/src/config/configuration.spec.ts` (trust-proxy combination refusals) |
| P18-14 | R6 | repository/config | No committed secrets (`.env*` git-ignored; example files placeholders only); compose values documented as non-production defaults; boot refuses missing/weak `JWT_SECRET`, missing/invalid `WEBHOOK_ENCRYPTION_KEY` (demanded even under test), empty `CORS_ORIGINS`, and invalid `TRUST_PROXY_*` combinations — each refusal unit-tested. | info | R6, AC6 | verified — no action | `apps/api/src/config/configuration.spec.ts`; `apps/api/src/webhooks/webhook-crypto.ts`; `.gitignore` |
| P18-15 | R6 | credential lifecycle | API keys: CSPRNG (`randomBytes`), stored as sha256 hex, shown once, never logged or re-returned; webhook signing secrets: shown once, AES-256-GCM encrypted at rest, HMAC over exactly the bytes sent; encryption key never logged. | info | R6, ADR-0017 | verified — no action | `apps/api/src/api-keys/api-key-crypto.ts`; `apps/api/src/webhooks/webhook-crypto.ts`; `projects.e2e-spec.ts` / `webhooks.e2e-spec.ts` shown-once cases; browser critical flows |
| P18-16 | R6 | log redaction (Phase 11 handover, F12) | Request-log allowlist (three layers) and audit-log builders admit no field capable of holding passwords, API keys, tokens, `Idempotency-Key` values, webhook secrets, or raw bodies; error paths do not bypass the allowlist; structured-logger redaction configured for auth/webhook paths. | info | F12, Phase 11 | verified — no action | P18-03/P18-04 evidence; `apps/api/src/common/logging/logger.config.ts`; `audit-logs.e2e-spec.ts` (AC10) |
| P18-17 | R6 | test-only switches (F11) | Full inventory enumerated (§6): `WEBHOOK_ALLOW_INSECURE_TEST_KEY` and the `NODE_ENV=test` JWT fallback. Both are refused under production configuration with unit tests at the config layer; the harness rate-limit raises are environment knobs of the test runner, not application switches. | info | F11, Phase 17 §9 rule 2 | fixed — inventory recorded (§6) | `apps/api/src/config/configuration.spec.ts`; `apps/api/test/jest-e2e.setup.ts` |
| P18-18 | R6 | artifacts (F10) | Playwright traces/screenshots/videos and coverage reports remain git-ignored, captured on failure only, never committed. | info | F10 | verified — no action | `.gitignore` (`playwright-report/`, `test-results/`, `coverage/`) |
| P18-19 | R6 | dashboard surfacing | API-key plaintext and webhook secrets appear exactly once in the UI; nowhere else in lists, details, toasts, or URLs. | info | R6 | verified — no action | `apps/web/test/browser/critical-flows.spec.ts` |
| P18-20 | R7 | OWASP A06 (F8) | No dependency vulnerability scanning existed. | medium | D4, F8 | **fix** — `pnpm audit:deps` script + CI step failing on high/critical production vulnerabilities; vulnerable transitive versions pinned via `pnpm-workspace.yaml` overrides (17 known advisories → 0) | `package.json` `audit:deps`; `.github/workflows/ci.yml`; `pnpm-workspace.yaml` |
| P18-21 | R7 | OWASP A10 / SSRF (F3) | ADR-0019 sandbox posture accepted permissive private/loopback destinations, host-based lists, no DNS-rebinding mitigation. Compensating controls (validation, no redirects, bounded timeouts, no credential forwarding, sanitized logs) remain. Not safe outside sandbox context. | medium | D6, ADR-0019 | **accept** — residual risk AR-2 (§4) | `apps/api/src/webhooks/` destination resolution; D6 decision 2026-10-13 |
| P18-22 | R4 | accessibility handover (F6) | Phase 14 §7.6 deferred a full accessibility audit to "Phase 18", which contradicts the roadmap's fixed security scope. | info | D8 | **refer** — relocated to Phase 26 QA (or standalone change); §7.6 baseline already shipped in Phase 14 | D8 decision 2026-10-13 |
| P18-23 | — | custom error pages (F7) | Q1: product/UX change with no material security effect (Next.js defaults leak nothing). | info | Q1 | **refer** — standalone `feature/*` web change or Phase 26 polish | Q1 decision 2026-10-13 |
| P18-24 | — | availability referrals (F13) | Phase 13 D11 referred two availability items with no owner: pending-delivery bound per webhook endpoint; per-project sweep fairness. Availability defects, not security controls. | info | §12 | **refer** — Phase 19 (availability work) / backlog | Phase 13 D11; Phase 10 classification |
| P18-25 | — | roadmap bookkeeping (F14) | This phase's seven ROADMAP.md checkboxes update at merge as a separate `chore/*` change. | info | DoD 9 | **refer** — `chore/*` at merge | Phase 16 Q2 / Phase 17 Q1 precedent |

**Summary by severity:** 0 critical, 0 high, 3 medium (P18-01 fixed; P18-10, P18-12,
P18-21 accepted with exit criteria), 22 info. **Zero open critical/high findings**
(AC1–AC6).

## 2. F1–F14 disposition table (AC8)

| # | Finding (phase spec §3) | Disposition |
| --- | --- | --- |
| F1 | Four authorization implementations (guard clones) | Fixed — D1(a) consolidation (P18-01) |
| F2 | Explicit Phase 18 re-review obligations (ADR-0023/0025/0028/0032, Phases 11/13/15–17) | Discharged — R2 (P18-03/04), R4 (P18-09/10), R5 (P18-11/12/13), R6 (P18-14–19), R7 (§3 A05/A09/A10 rows) |
| F3 | SSRF residual risks (ADR-0019) | Accepted — AR-2 with exit criteria (D6) |
| F4 | CSP `script-src 'unsafe-inline'` | Accepted — AR-1 with exit criteria (D5) |
| F5 | Per-account login lockout DoS | Accepted — AR-3 with exit criteria (D7) |
| F6 | Accessibility full-audit handover conflict | Relocated — Phase 26 QA (D8) |
| F7 | Custom not-found/error pages | Out of scope — standalone/Phase 26 (Q1) |
| F8 | No dependency vulnerability scanning | Fixed — D4(a) audit gating (P18-20, ADR-0036) |
| F9 | Helmet CSP-off justification (Swagger UI) | Confirmed — P18-08; stays documented and minimal |
| F10 | New artifact surfaces (browser traces, coverage) | Verified git-ignored, failure-only (P18-18) |
| F11 | Test-only switch inventory | Recorded — §6 (P18-17) |
| F12 | Log redaction completeness (Phases 11/12 handovers) | Verified — P18-03/04/16 |
| F13 | Availability referrals (pending-delivery bound, sweep fairness) | Referred — Phase 19 / backlog (P18-24) |
| F14 | ROADMAP.md bookkeeping | Referred — `chore/*` at merge (P18-25) |

## 3. OWASP Top 10 (2021) checklist

Threat statements are scoped to the sandbox context: simulated payments, developer
audience, no real money, no production deployment (Phases 22/24).

### A01 — Broken Access Control

| Item | Content |
| --- | --- |
| Threats | IDOR on any resource id; cross-organization/project/environment reads and writes; privilege escalation via role fields; session/API-key confusion; UI-only authorization. |
| Controls | Dual-mode guards resolving exactly one scope per request (`DualModeAccessGuard`); per-family capabilities from the Phase 4 registry, enforced server-side; UUID validation before lookup; non-disclosure 404s; session-only surfaces reject API keys; environment pinning in key mode. |
| Evidence | P18-01/02; `project-access.guard.spec.ts`; cross-scope e2e cases per family (payments, customers, refunds, webhooks, projects, organizations, request-logs, audit-logs); `route-rate-limit-classes.e2e-spec.ts` guard inventory. |
| Findings / residual | P18-01 fixed (consolidation). No open residual. |

### A02 — Cryptographic Failures

| Item | Content |
| --- | --- |
| Threats | Secret/key exposure at rest or in logs; weak password hashing; plaintext credential storage; downgrade of transport protections. |
| Controls | Argon2id passwords; API keys CSPRNG + sha256-at-rest, shown once; webhook secrets AES-256-GCM at rest (ADR-0017), shown once; JWT strong-secret boot demand; TLS via deployment (staging/production handover); structured-log redaction; no secrets in repo. |
| Evidence | P18-14/15/16; `password.service.ts`; `api-key-crypto.ts`; `webhook-crypto.ts`; `configuration.spec.ts`; `audit-logs.e2e-spec.ts` (AC10). |
| Findings / residual | None open. |

### A03 — Injection

| Item | Content |
| --- | --- |
| Threats | SQL injection; log-format injection; mass assignment; XSS via any reflected input. |
| Controls | Global validation pipe with whitelist + forbidNonWhitelisted; Prisma parameterized access only (two justified raw call sites, both tagged templates); UUID path params; JSON-only responses; no `dangerouslySetInnerHTML` in the web app (unit-asserted). |
| Evidence | P18-06/07/08; `validation.ts`; `refunds.service.ts:93`; `prisma.service.ts:37`; web unit assertion (Phase 15); `contract-conformance.e2e-spec.ts`. |
| Findings / residual | None open. |

### A04 — Insecure Design

| Item | Content |
| --- | --- |
| Threats | Missing tenant boundary; authorization delegated to the client; unbounded credential guessing; feature paths that bypass validation. |
| Controls | Modular monolith with scoping by construction at the service layer; capability registry (Phase 4); idempotency concurrency control (Phase 8); rate limiting (Phases 3/13); defect policy (rule 2) that fixed spec-contradicting findings inside this phase. |
| Evidence | R1/R2 evidence above; `journeys.e2e-spec.ts`; `idempotency.e2e-spec.ts`; `rate-limits.e2e-spec.ts`. |
| Findings / residual | Accepted: AR-3 (lockout DoS) is an accepted cost of bounding credential guessing (D7). |

### A05 — Security Misconfiguration

| Item | Content |
| --- | --- |
| Threats | Widened CORS; trusted-proxy spoofing; insecure cookie/HSTS defaults; over-permissive CSP in production; permissive compose defaults leaking to production. |
| Controls | CORS allowlist demanded non-empty at boot with `credentials: true` only for allowlisted origins; `TRUST_PROXY_HOPS=0` + empty CIDRs in Compose/CI with combination refusals tested; `COOKIE_SECURE` defaults true in production; HSTS iff `WEB_SECURE`; production CSP without `'unsafe-eval'`; Swagger-only CSP-off documented; compose values documented as non-production. |
| Evidence | P18-08/09/13/14; `bootstrap.ts`; `next.config.ts`; `configuration.spec.ts` (CORS, trust-proxy, cookie refusals). |
| Findings / residual | Accepted: AR-1 (CSP `script-src 'unsafe-inline'`) — the only web relaxation kept (D5). |

### A06 — Vulnerable and Outdated Components

| Item | Content |
| --- | --- |
| Threats | Known-vulnerable transitive dependencies reaching production installs. |
| Controls | `pnpm audit:deps` (prod dependencies, fail on high/critical) runs locally and as a CI gate; `pnpm-workspace.yaml` overrides pin fixed versions of known-vulnerable transitives. |
| Evidence | P18-20; `package.json`; `.github/workflows/ci.yml`; ADR-0036. |
| Findings / residual | Posture: dev-only advisories below the production gate are reported by the same command but do not fail the gate (recorded in ADR-0036). |

### A07 — Identification and Authentication Failures

| Item | Content |
| --- | --- |
| Threats | Credential stuffing; session fixation/reuse; JWT algorithm confusion; account enumeration; lockout abuse. |
| Controls | Argon2id; generic auth failures; access-token TTL as configured; refresh rotation with family invalidation on reuse detection; server-side logout revocation; cookie cleared on terminal paths; `auth.*` rate-limit classes (IP + account scopes); JWT library default algorithm handling verified (no custom `alg` parsing). |
| Evidence | P18-11/12; `auth.e2e-spec.ts`; `token.service.spec.ts`; `password.service.spec.ts`; `rate-limits.e2e-spec.ts`; browser critical flows (cookie posture). |
| Findings / residual | Accepted: AR-3 (per-account lockout DoS, D7) with exit criteria. |

### A08 — Software and Data Integrity Failures

| Item | Content |
| --- | --- |
| Threats | Tampered dependencies; unsigned/rolled-back webhook events; idempotency replay abuse; integrity loss in audit trail. |
| Controls | Lockfile-committed installs; dependency audit gate (D4/A06); webhook HMAC over exactly the bytes sent with rotation support; encrypted secret storage; audit append-only (DB trigger) with transactional coupling to mutations; idempotency claims serialize concurrent creates. |
| Evidence | P18-03/15/20; `webhook-crypto.ts`; `audit-logs.e2e-spec.ts` (AC5/AC9); `idempotency.e2e-spec.ts`; `webhook-delivery.e2e-spec.ts`. |
| Findings / residual | None open. |

### A09 — Security Logging and Monitoring Failures

| Item | Content |
| --- | --- |
| Threats | Sensitive data in logs; silent authorization failures; uncorrelated incidents. |
| Controls | Three-layer request-log allowlist; audit entries allowlisted at the builder; structured-logger redaction for auth/webhook paths; request-id correlation on every request; audit and request logs are the incident surfaces (Phase 20 owns metrics/alerting — noted limitation). |
| Evidence | P18-03/04/16; `audit-logs.e2e-spec.ts` (AC1/AC7/AC10); `request-logs.e2e-spec.ts`; `logger.config.ts`. |
| Findings / residual | Limitation (not a finding): alerting/metrics deferred to Phase 20 by roadmap scope. |

### A10 — Server-Side Request Forgery (SSRF)

| Item | Content |
| --- | --- |
| Threats | Webhook deliveries to internal/loopback targets; DNS rebinding against destination checks. |
| Controls | Destination validation; no redirects followed; bounded connect/request timeouts; no credential forwarding to destinations; sanitized delivery logs; optional allow/deny host lists (ADR-0019/ADR-0032 — zero-HTTP outbound markers for simulated deliveries). |
| Evidence | P18-21; `webhook-delivery.e2e-spec.ts`; `webhook-failures.e2e-spec.ts`; ADR-0019, ADR-0032. |
| Findings / residual | Accepted: AR-2 — sandbox-only posture; not safe outside sandbox context; exit criteria require IP pinning + resolved-address revalidation before any non-sandbox deployment (Phases 22/24 obligation, D6). |

## 4. Accepted-risk register (AC10)

Each entry records rationale, blast radius, and exit criteria. Nothing was closed by
weakening a control (§4 rule 3).

| Id | Risk | Decision | Rationale | Blast radius | Exit criteria | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| AR-1 | CSP `script-src 'unsafe-inline'` on the web app | D5(a) reaffirm | Nonce/hash CSP is a Next.js rendering-path change with dashboard breakage risk; ADR-0028 already rejected speculative work | XSS impact bounded to same-origin session/token theft in the browser context of the sandbox dashboard | Implement nonce or hash-based CSP in the rendering path; revisit post-MVP / before production-grade deployments | Web app phases (post-MVP) |
| AR-2 | SSRF sandbox posture (permissive destinations, host-based lists, no IP pinning/rebinding mitigation) | D6(a) reaffirm | ADR-0019 accepted these for the sandbox; compensating controls bound the exposure; hardening is real deferred work | Deliveries from the worker to attacker-chosen destinations inside the sandbox network context; no real customer data at stake | IP pinning + resolved-address revalidation (TOCTOU mitigation) implemented **before any non-sandbox deployment** (Phases 22/24 obligation) | Phases 22/24 |
| AR-3 | Per-account login lockout DoS (account-scope rate limit) | D7(a) accept | Intended cost of bounding credential guessing; sandbox accounts carry no real value; remedy (progressive delay/challenge/per-attacker dimension) needs product design | An unauthenticated caller can exhaust a known email's login budget for the window duration | Revisit together with any auth-UX work, or before production-grade accounts | Auth UX (product decision; not on the roadmap yet) |

## 5. Deployment-fact handovers (Phases 22/24)

These are obligations this phase specifies but cannot execute (environments do not
exist yet). ADR-0025's "confirm the values of each environment" is discharged as:
confirm what exists (local Compose, CI) + specify what must be set.

| Fact | Local/CI (confirmed) | Required at staging/production |
| --- | --- | --- |
| `TRUST_PROXY_HOPS` | `0` (`docker/compose.yml`, `.env.example`) | Real hop count of the deployment's proxy chain — never `0` behind a proxy, never a guess |
| `TRUST_PROXY_CIDRS` | empty | Proxy addresses only (the immediate reverse proxies); never `0.0.0.0/0` or client-reachable ranges |
| `COOKIE_SECURE` | defaults by `NODE_ENV` (production → true) | `true` — enforced by the production default; do not override |
| `WEB_SECURE` | not set locally | `true` — turns on HSTS and production header posture |
| `JWT_SECRET` | refused if missing/weak outside tests | Strong random value (≥ configured minimum), injected via secrets management (Phase 21), never in the repo |
| `WEBHOOK_ENCRYPTION_KEY` | demanded at boot; test fallback refused under a database | 32-byte base64 from the deployment's secrets store (Phase 21) |
| `WEBHOOK_DESTINATION_ALLOWLIST` / `DENYLIST` | unset (permissive sandbox default) | Set deliberately; SSRF exit criteria (AR-2) additionally require IP pinning before non-sandbox use |
| `CORS_ORIGINS` | non-empty allowlist demanded at boot | The deployed dashboard origin(s) only |

## 6. Test-only switch inventory (F11)

Every configuration flag that relaxes a control for testing, with its production
posture:

| Switch | Effect | Production refusal | Test evidence |
| --- | --- | --- | --- |
| `WEBHOOK_ALLOW_INSECURE_TEST_KEY='true'` | Accepts the committed fallback `WEBHOOK_ENCRYPTION_KEY` **only when `DATABASE_URL` is empty/unset** — i.e. nothing can be stored. Refused (boot throws) once a database is in play, because the connection string falls back to a localhost default: "no `DATABASE_URL` exported" is not "no database". | A production deployment necessarily provides `DATABASE_URL`; with it set the opt-in is inert and boot demands a real key. Value must be exactly `'true'`. | `configuration.spec.ts` (opt-in accepted only without `DATABASE_URL`; refusal with it set) |
| `NODE_ENV=test` | Enables the documented non-secret JWT fallback (`TEST_JWT_SECRET`) so unit suites run without secrets. Any other environment demands `JWT_SECRET` at boot, minimum-length checked, with a generation hint. | Refusal is keyed on `nodeEnv !== 'test'` — production/development/staging all demand a real secret. | `configuration.spec.ts` (weak/absent secret refusals) |

Not application switches (recorded for completeness): the e2e harness raises
rate-limit maxima and sets a disposable encryption key via
`apps/api/test/jest-e2e.setup.ts` — environment knobs of the test runner, applied
only to local/CI test runs, never shipped as application defaults.

## 7. Sign-off record (AC10)

### Roadmap checkbox verdicts

| Checkbox (roadmap) | AC | Verdict | Basis |
| --- | --- | --- | --- |
| Authorization review (IDOR prevention) | AC1 | **Pass** | R1 executed; D1 consolidation done (clones deleted, shared guard only); per-resource cross-scope negatives in both modes; 0 open critical/high |
| Tenant isolation verification | AC2 | **Pass** | R2 executed; scoping by construction per family; ADR-0023/ADR-0020 re-reviews evidenced; 0 open critical/high |
| API security (injection, XSS) | AC3 | **Pass** | R3 executed; validation whitelist, parameterized SQL, error envelope, CORS/helmet/Swagger postures tested; 0 open critical/high |
| Web application security review | AC4 | **Pass** | R4 executed; headers as served; token/cookie rules; route-protection parity; CSP residual dispositioned (AR-1); 0 open critical/high |
| Session and authentication review | AC5 | **Pass** | R5 executed; Argon2id/JWT/rotation/enumeration evidenced; lockout DoS dispositioned (AR-3); proxy-trust confirmed + handovers recorded; 0 open critical/high |
| Secrets management review | AC6 | **Pass** | R6 executed; repository/config/credential-lifecycle/redaction/artifact checks evidenced; F11 inventory complete; 0 secrets found; 0 open critical/high |
| OWASP Top 10 checklist | AC7 | **Pass** | This document (§3), consistent with the findings log (§1); residual risks in §4 with exit criteria |

### Cross-cutting gates

| Gate | Verdict | Basis |
| --- | --- | --- |
| AC8 handovers discharged | **Pass** | §2 (F1–F14 all dispositioned; F13 explicitly referred) |
| AC9 fixes verified | **Pass** | P18-01 shipped with characterization specs first, then clone deletion; full Phase 17 suite stays green (unit 842; e2e 185); no assertion weakened |
| AC10 sign-off record | **Pass** | This document: per-checkbox verdicts, findings summary, accepted-risk register (§4), deployment-fact handovers (§5) |
| AC11 required checks | **Pass** | `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, `pnpm audit:deps` green from the repository root |

### Findings summary

0 critical · 0 high · 3 medium (1 fixed, 2 accepted) · 22 info. Known limitations
compensated by this review (out of MVP scope): SAST/DAST product rollouts,
bug-bounty programs, external penetration tests, metrics/alerting (Phase 20),
production secrets injection (Phase 21).

Security-sensitive changes in this phase (the guard consolidation) require the
explicit security review in their PR (§8 rule 2) — the PR description cites this
document and the characterization specs.
