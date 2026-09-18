# BrinnPay — Security Baseline

> Architecture artifact of **Phase 1 — Architecture & MVP Spec** (phase 1 specification §10, §13.1).
> The baseline is established now; detailed implementation lands in the relevant phases (3–13).

## 1. Baseline requirements

| Area | Requirement |
| --- | --- |
| Passwords | **Argon2id is the required/default algorithm**; bcrypt permitted only as a documented exception requiring an explicit Phase 3 decision (ADR-0007). Phase 3. |
| Sessions | Short-lived JWT access tokens + revocable refresh sessions. Web: access token held in memory (never in `localStorage`/`sessionStorage`); refresh token exposed to the browser only via an `HttpOnly` cookie (`Secure` in secure/production environments, `SameSite` configured to minimize CSRF); logout revokes the refresh session and clears the cookie (phase 1 §11.5). |
| API keys | Prefixed format `sk_test_…`/`sk_live_…`; stored hashed only; shown once at creation; scoped to (project, environment); never logged (ADR-0006). |
| Authorization | RBAC with roles `owner`, `admin`, `member`, `viewer`; enforced per route and per resource. |
| Tenant isolation | All queries and mutations scoped by organization; IDOR prevention is a first-class test concern. ID opacity (ADR-0001) is not a security control — authorization never relies on ID secrecy. |
| Webhooks | HMAC-SHA256 signatures with endpoint secret; secrets never logged or returned. |
| Rate limiting | IP-based and API-key-based; applied to auth endpoints from Phase 3, to all API routes by Phase 13. |
| Input validation | All external input validated at the boundary (NestJS pipes/DTOs). |
| Logs | Structured; secrets, passwords, API keys, webhook secrets, and tokens never written to logs. |
| Headers | Security headers on web responses (CSP, HSTS in production, etc.). |
| Errors | Error responses never leak internals (stack traces, db details, secrets). |

## 2. Principles

- Strong authentication.
- Role-based authorization.
- Tenant isolation.
- Secure API key handling.
- HMAC-SHA256 webhook signatures.
- Rate limiting.
- Secure logging.
- Secrets never exposed.
- Authenticated web routes must enforce authorization.
- Sensitive data must not be exposed through public web routes.

## 3. Credential handling rules

- Passwords: never stored in plaintext, never logged, never transmitted back to the client
  (ADR-0007; implementation in Phase 3).
- API keys: plaintext shown exactly once at creation; only a hash stored; hashes unique per project
  environment; keys never logged and never returned by later requests (ADR-0006). Key loss requires
  rotation (Phase 5).
- Webhook signing secrets: returned exactly once at endpoint creation; never logged, never returned
  again (Phase 10).
- Session tokens: access tokens are held in memory client-side and never placed in web storage;
  refresh tokens are never readable by browser JavaScript (delivered only via `HttpOnly` cookie),
  are revocable server-side, and are never written to logs (phase 1 §11.5, Phase 3).
- Authorization is enforced server-side in `apps/api`: the web application never bypasses API-level
  authorization, and public routes must not expose authenticated data.

## 4. Enforcement points

- Route-level authorization is enforced in the API (`apps/api`) at the appropriate boundary; the
  web application never bypasses API-level authorization (phase 1 §11.4).
- Data access is always scoped by organization; API-key-authenticated requests are scoped to the
  project the key belongs to (phase 1 §6.4).

## 5. Phase mapping

| Requirement | Implemented in |
| --- | --- |
| Password hashing (Argon2id) | Phase 3 |
| JWT access + refresh tokens | Phase 3 |
| RBAC roles and authorization | Phase 4 |
| API key scheme (generation, hashing, lookup) | Phase 5 |
| HMAC-SHA256 webhook signing | Phase 10 |
| Rate limiting | Phase 3 (auth) → Phase 13 (all API routes) |
| Input validation (pipes/DTOs) | Phase 2 foundation + every phase |
| Structured secure logging / request IDs | Phase 2 base, Phases 11–12 |
| Security headers on web responses | Phase 14 |
| Security hardening review (OWASP, IDOR tests) | Phase 18 |