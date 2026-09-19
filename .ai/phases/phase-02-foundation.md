# Phase 2 — Foundation

|                   |                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase             | 2                                                                                                                     |
| Name              | Foundation                                                                                                            |
| Status            | Ready — decisions D1–D9 confirmed by the product authority (2026-09-17); architectural policy recorded as ADR-0011, ADR-0012, ADR-0013 |
| Depends on        | Phase 0 (complete), Phase 1 (complete)                                                                                |
| Blocks            | Phase 3 (Authentication) and all subsequent phases                                                                    |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 2                                                                              |

---

## 1. Objective

Establish the core application stack so that all subsequent phases can build features on a
working, tested, containerized foundation:

- NestJS + TypeScript backend (`apps/api`) scaffolded and wired with the base cross-cutting
  infrastructure: configuration, validation, structured logging, request IDs, error envelope,
  Prisma/PostgreSQL, Redis connectivity, health checks, and Swagger UI.
- Next.js + TypeScript web application (`apps/web`) scaffolded with the initial public and
  authenticated routing structure (placeholder content only; no features).
- Local development infrastructure: PostgreSQL, Redis, and the two applications via Docker
  Compose.
- All required checks (lint, typecheck, unit, integration/e2e, build) green, including in CI.

Phase 2 introduces **no business features** and **no domain endpoints**. Business behavior
belongs to Phases 3–16; this phase only establishes the base the features run on.

## 2. Scope

In scope (mapped to the Phase 2 roadmap checkboxes):

1. NestJS backend setup (`apps/api`).
2. Next.js web application setup (`apps/web`).
3. Public web application structure.
4. Initial routing structure for public and authenticated areas.
5. PostgreSQL database (Docker Compose service + Prisma connection).
6. Prisma ORM + schema (base schema and migration workflow; see D1).
7. Redis (Docker Compose service + connectivity; see D9).
8. Docker Compose for local development.
9. Request validation base (global pipes/DTO infrastructure).
10. Structured logging base (JSON logs, request IDs, secure logging).
11. Health check endpoints.
12. OpenAPI/Swagger integration (contract served via Swagger UI).

Out of roadmap, but required to keep Phase 2 self-consistent (see §14):

- Request ID assignment and `X-Request-Id` response header (phase 1 §7.7; security baseline
  maps request IDs and structured secure logging to the "Phase 2 base").
- The canonical error envelope (phase 1 §7.6, `api-conventions.md` §6) as the base exception
  mapping, so that Phase 3+ endpoints inherit it.
- CI adjustment (service containers for PostgreSQL/Redis) so the API integration/e2e tests can
  run (D8).

## 3. Context

Constraints reused from the master specification and Phase 1 (all binding):

- Modular monolith: NestJS API + Next.js web app, PostgreSQL + Prisma, Redis + BullMQ, Docker,
  REST, OpenAPI (`docs/openapi.yaml` is the single canonical contract — phase 1 §13.2).
- The web application is a single Next.js app containing public and authenticated areas; it is a
  **client of the API** and must not contain domain/business logic (phase 1 §11).
- API conventions bind from day one: `/api/v1` prefix (ADR-0005), error envelope, request IDs,
  validation at the boundary, secure logging (phase 1 §7).
- Module structure follows domain and cross-cutting responsibilities, not a phase-to-module
  mapping (phase 1 §6.3). Phase 2 creates only the **base cross-cutting infrastructure**;
  domain modules (`auth`, `organizations`, …) are added by their owning phases.
- Security baseline (phase 1 §10): validation at the boundary, structured secure logging,
  request IDs are Phase 2 base responsibilities; auth/RBAC/keys/webhook signing/rate limiting
  belong to Phases 3–13.
- Repository state: `apps/api` and `apps/web` are empty; no shared packages exist and none may be
  created "solely for theoretical future reuse" (master specification). `docker/README.md`
  already fixes the expected Phase 2 layout (`docker/compose.yml`, `docker/api/Dockerfile`,
  `docker/web/Dockerfile`). Root scripts run `pnpm -r` over `apps/*` and `packages/*`.

## 4. API Application — `apps/api`

### 4.1 Purpose in this phase

Scaffold the NestJS + TypeScript application and establish the base cross-cutting
infrastructure. No business endpoints are implemented in Phase 2; all business endpoints arrive
with their phases (3–13).

### 4.2 Base capabilities

| Capability                 | Requirement                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration              | Environment-driven configuration (`@nestjs/config` or equivalent). `.env` is gitignored; `.env.example` is committed with non-secret defaults only. No secrets in code or config files.                                                          |
| Request validation         | Global `ValidationPipe` (class-validator/class-transformer or equivalent) enabled app-wide: whitelist unknown properties; validated at the boundary. Validation failures map to the canonical error envelope, HTTP 400, code `VALIDATION_ERROR`. |
| Error envelope             | Global exception filter mapping application errors to the canonical envelope (phase 1 §7.6): `error.code`, `error.message`, `error.request_id`, optional `error.details`. Never leak stack traces, DB details, or secrets in responses.         |
| Request IDs                | Every request receives a request ID at ingress (`req_…` scheme, phase 1 §7.8); every response carries `X-Request-Id`; the ID is propagated into logs.                                                                                          |
| Structured logging         | Structured JSON logs carrying the request ID. Log levels configurable via environment. **Secure logging base:** passwords, API keys, webhook secrets, tokens, and full card-like payloads are never logged. Redaction must be in place from day one. |
| Health checks              | Liveness and readiness endpoints (§4.3).                                                                                                                                                                                                       |
| OpenAPI/Swagger            | Swagger UI served from the API reading from the canonical contract (D5).                                                                                                                                                                       |
| Security headers           | Basic API security headers (e.g., Helmet) enabled; security headers for the web application belong to Phase 14 (security baseline mapping).                                                                                                     |
| CORS                       | CORS restricted to configured origins (local default: the web app origin). Env-driven.                                                                                                                                                         |

### 4.3 Health check endpoints

Infrastructure endpoints, **outside** `/api/v1` (they are operational, not business API and are
not part of the OpenAPI contract):

| Endpoint          | Semantics                                                                                        | Success                          | Failure                          |
| ----------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------- |
| `GET /health/live`  | Liveness: the process is up and serving requests.                                                | 200 `{ "status": "ok" }`         | 503                              |
| `GET /health/ready` | Readiness: the process is up **and** its dependencies (PostgreSQL, Redis) are reachable.         | 200 `{ "status": "ok", "checks": { … } }` | 503 with a minimal payload |

Readiness requirements:

- Checks the PostgreSQL connection (via Prisma) and the Redis connection.
- Failure payloads are **minimal and safe**: service name and failing check names only.
  Connection details, URLs, credentials, and stack traces are never exposed; detailed cause is
  logged server-side only.
- Both endpoints are unauthenticated (used by Docker/CI/orchestration) and must not reveal
  internal topology or secrets.

### 4.4 Application structure

The scaffold organizes base infrastructure into small capability modules (e.g., config, logging,
request-id, validation/errors, health, prisma, redis). Domain modules (`auth`, `organizations`,
`projects`, `api-keys`, `customers`, `payments`, `refunds`, `webhooks`) are **not** created yet;
they arrive with their phases. Cross-cutting modules that depend on business events (idempotency,
request-logging, audit-logging, rate limiting) are **not** created in Phase 2; they belong to
Phases 8/11/12/13.

### 4.5 Prisma

- Prisma configured in `apps/api`; PostgreSQL is the datasource (driver/engine: default).
- Standard scripts: `prisma generate`, `prisma migrate dev` (local), `prisma migrate deploy`
  (non-local). Migrations are committed to the repository at `apps/api/prisma/migrations`.
- **Base schema scope (D1, ADR-0011):** the Phase 2 `schema.prisma` contains datasource +
  generator only (no domain models). Domain entities are added by their owning phases via
  migrations, applying the conventions below. This avoids inventing field-level design for
  Phases 3–13 and avoids rework.
- Schema conventions fixed for all later phases (recorded, not modeled, in this phase):
  entity IDs as PostgreSQL `uuid` storing UUIDv7 (ADR-0001); `snake_case` table/column names;
  every record carries `created_at`; mutable records carry `updated_at`; timestamps UTC
  (phase 1 §8); money in integer minor units (ADR-0002) where applicable.

### 4.6 Redis

- Redis reachable and verified by the readiness check.
- BullMQ is **not** wired in Phase 2: no producers, consumers, or queues exist until there are
  business events to process (Phase 10). The BullMQ dependency itself may be added in Phase 10
  (D9).

## 5. Web Application — `apps/web`

### 5.1 Purpose in this phase

Scaffold the Next.js + TypeScript application and create the **routing skeleton** for the public,
authentication, and authenticated areas defined in phase 1 §11. Content is placeholder material;
no features, no auth logic, no data fetching, and no domain logic.

### 5.2 Routing structure (placeholders)

| Area           | Routes (phase 1 §11)                                                                                     | Phase 2 deliverable                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Public         | `/`, `/product*`, `/docs/**`                                                                             | Home, product, and docs placeholder pages. No sensitive/authenticated material. |
| Authentication | `/login`, `/register`                                                                                    | Placeholder pages. **No** login/registration behavior (Phase 3).               |
| Authenticated  | `/dashboard`, `/dashboard/organizations`, `/dashboard/projects`, `/dashboard/projects/[projectId]` and its sub-routes (`api-keys`, `customers`, `payments`, `refunds`, `webhooks`, `logs/requests`, `logs/audit`), `/dashboard/settings` | Route skeleton with placeholder pages under a minimal dashboard shell.          |

Rules for the skeleton:

- Use route groups (e.g., `(public)`, `(auth)`, `(dashboard)`) to give the three areas separate
  layouts without altering URLs.
- Placeholder pages render static, non-sensitive content only.
- **Route protection is not implemented in Phase 2.** Protection requires authentication
  (Phase 3) and the production UI (Phase 14). No redirect logic, no session access, no
  middleware that touches tokens.
- The skeleton must not fetch data from the API and must not implement business rules.

### 5.3 Boundaries

- `apps/web` remains a client of the API: no parallel backend, no domain logic (phase 1 §11).
- No shared packages are created (no concrete reuse need exists yet, master specification).
  Cross-app contracts live in `docs/openapi.yaml`.

## 6. Docker Compose (Local Development)

Per `docker/README.md` (Phase 2 expected layout), provide:

```text
docker/
├── compose.yml
├── api/
│   └── Dockerfile
└── web/
    └── Dockerfile
```

Services and requirements:

| Service    | Purpose                                     | Requirements                                                                                            |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| PostgreSQL | Primary database                            | Named volume for data; version pinned; credentials/env overridable; no secrets hardcoded.               |
| Redis      | Cache/queue infrastructure (BullMQ later)   | Named volume for persistence; version pinned.                                                           |
| API        | `apps/api` development container            | Runs the API; healthcheck against `GET /health/ready`; source mounted for hot reload in dev; port mapped. |
| Web        | `apps/web` development container            | Runs the Next.js dev server; port mapped; buildable via `docker/web/Dockerfile`.                        |

Compose requirements:

- No secrets in `compose.yml` or committed files; secret/default values via `.env` (gitignored)
  with `.env.example` (committed, non-secret defaults).
- The API container healthcheck uses the readiness endpoint; unhealthy API must be visible via
  `docker compose ps`.
- Local-service defaults recorded in `docker/README.md` follow the decision D7 (ports, db name,
  user).

## 7. API Behavior

The Phase 2 API surface is intentionally minimal:

| Concern                | Behavior                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Business endpoints     | **None.** All business endpoints arrive with their phases (3–13); none are stubbed with fake data.                      |
| Health endpoints       | `GET /health/live`, `GET /health/ready` (§4.3).                                                                          |
| Swagger UI             | Served from the API (mount path recorded in D5), rendering the canonical contract.                                       |
| All responses          | Carry `X-Request-Id`. Errors use the canonical envelope (§4.2).                                                          |
| Validation             | Global pipe active; malformed input → 400 `VALIDATION_ERROR` envelope with field details.                                |
| Versioning             | Business API under `/api/v1` (ADR-0005); health endpoints are explicitly outside the versioned/OpenAPI surface.          |

No changes to `docs/openapi.yaml` are expected in this phase: Phase 2 introduces no business
surface. The contract must remain Redocly-lint clean (CI).

## 8. Data Requirements

- PostgreSQL database for local development (name/user via D7); connection through Prisma.
- Prisma base schema and migration workflow (§4.5, D1).
- Redis verified for connectivity (§4.6).
- No domain tables, no seed data, and no fake/seed entities in Phase 2 (D1; seeding strategy is
  deferred to the phases that introduce data).

## 9. Security Requirements (Phase 2 base)

From the security baseline (phase 1 §10) and `AGENTS.md`:

1. **Input validation** — all external input validated at the boundary (global pipe; DTO
   conventions). Active from day one so later phases are safe by default.
2. **Secure logging** — structured logs never contain passwords, API keys, webhook secrets,
   tokens, or sensitive payloads; redaction configured at the base.
3. **Request IDs** — every request/response carries a request ID; IDs never reused as secrets.
4. **Error safety** — responses never leak internals (stack traces, DB details, connection
   strings, secrets); health failure payloads are minimal.
5. **Secrets handling** — no secrets in code, config files, Dockerfiles, or `compose.yml`;
   `.env` gitignored; `.env.example` has non-secret defaults; Docker ignores env files not
   whitelisted.
6. **CORS** — restricted to configured origins (local default: web app origin only).
7. **Headers** — basic security headers on API responses (Helmet or equivalent); web security
   headers are Phase 14.
8. **Public web placeholders** — must not expose authenticated data, internal architecture
   details, or sensitive material (phase 1 §11.1).
9. **No domain authorization** — authorization (RBAC, tenant isolation) is Phase 4+; Phase 2
   introduces no data-bearing endpoints that would require it.

## 10. Acceptance Criteria

1. `apps/api` is a NestJS + TypeScript application in the workspace providing the scripts
   `lint`, `typecheck`, `test`, `test:e2e`, `build`; all pass locally and in CI.
2. `apps/web` is a Next.js + TypeScript application in the workspace providing the same five
   scripts; all pass locally and in CI.
3. The web routing skeleton matches phase 1 §11 (public `/`, `/product`, `/docs`; auth `/login`,
   `/register`; dashboard routes incl. `[projectId]` sub-routes) with placeholder content; no
   auth behavior, no data fetching, no domain logic.
4. PostgreSQL and Redis run locally via `docker compose up` and are reachable from the API;
   `GET /health/ready` reports them.
5. Prisma is configured with a migration workflow (`generate`, `migrate dev`, `migrate deploy`);
   the initial migration is committed; the base schema matches decision D1 and records the
   schema conventions in §4.5.
6. Every API response carries `X-Request-Id`; logs are structured JSON and carry the request ID;
   a validation failure returns the canonical 400 `VALIDATION_ERROR` envelope; generic errors
   return the canonical envelope without internals.
7. `GET /health/live` and `GET /health/ready` behave per §4.3; readiness reflects PostgreSQL and
   Redis; failure payloads expose no internals.
8. Swagger UI is served from the API and renders the canonical contract; `docs/openapi.yaml`
   remains the single source of truth and still passes `pnpm lint:openapi`.
9. `docker/compose.yml` and `docker/api/Dockerfile` + `docker/web/Dockerfile` exist per
   `docker/README.md` layout; healthchecks wired; no secrets in committed files.
10. Repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`,
    `pnpm build`, and the existing CI passes with the Phase 2 apps included.
11. Logs and responses contain no secrets (verified by tests: log redaction asserts absence of
    secret-shaped values in output).

## 11. Testing Requirements

### 11.1 API (`apps/api`)

- **Unit tests:** validation pipe behavior (whitelist, 400 `VALIDATION_ERROR`), error-envelope
  filter (safe response, no internals), logging base (structured output, request-ID presence,
  redaction of secret-shaped values), health service unit logic (dependency failure → not ready).
- **Integration/e2e (`test:e2e`):** supertest against the running application — `GET /health/live`
  and `GET /health/ready` (with real PostgreSQL/Redis via CI service containers, D8);
  `X-Request-Id` present on responses; readiness returns 503 when a dependency is unavailable
  (destroyable connection or dependency stubbing as implementation allows).

### 11.2 Web (`apps/web`)

- **Unit tests:** placeholder pages render; the three route-group layouts render and keep public/
  auth/authenticated areas separated.
- **E2e (`test:e2e`) for Phase 2:** a minimal smoke test (e.g., render the home page and assert
  no authenticated content leaks). Full browser e2e tooling (Playwright or equivalent) is a
  Phase 17 concern and is not introduced in Phase 2 (D2).

### 11.3 Shared

- All checks (lint, typecheck, test, test:e2e, build) must run from the repository root
  (`pnpm -r …`) and in CI.
- Tests must not require secrets; test configuration uses `.env.example`-style defaults.

## 12. Definition of Done

Phase 2 is complete when:

- All roadmap checkboxes listed in §2 are implemented and traced (see §13).
- All acceptance criteria in §10 pass.
- All required checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D9 are confirmed by the product authority (2026-09-17); the architectural policy
  obligations (D1, D5, D9) are recorded as ADR-0011, ADR-0012, and ADR-0013.
- `docs/openapi.yaml` is unchanged in meaning and still lints clean (no parallel contract).
- No security-relevant issue remains open (validation active, logs redacted, no secrets
  committed).
- Phase 3 (Authentication) can start on the established base without re-opening Phase 2
  decisions.

## 13. Traceability (Roadmap → Phase 2)

| Roadmap Phase 2 checkbox                        | Specification reference                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| NestJS backend setup (`apps/api`)               | §4                                                                                                     |
| Next.js web application setup (`apps/web`)      | §5                                                                                                     |
| Public web application structure                | §5.2 (public area)                                                                                     |
| Initial routing for public and authenticated areas | §5.2                                                                                                 |
| PostgreSQL database                             | §4.5, §6, §8                                                                                           |
| Prisma ORM + schema                             | §4.5 (D1)                                                                                              |
| Redis (cache/queues)                            | §4.6, §6 (D9)                                                                                          |
| Docker Compose (local dev)                      | §6 (D7)                                                                                                |
| Request validation (pipes/DTOs)                 | §4.2                                                                                                   |
| Structured logging base                         | §4.2, §9                                                                                               |
| Health check endpoints                          | §4.3, §10                                                                                              |
| OpenAPI/Swagger integration                     | §4.2, §7 (D5)                                                                                          |

## 14. Implementation Considerations

### 14.1 CI

- The existing `ci` job runs `pnpm -r run lint/typecheck/test/test:e2e/build`. Both new apps must
  provide these five scripts or CI fails.
- The API integration/e2e tests need PostgreSQL and Redis: add service containers to the
  `ci` job (D8). This is the only CI change expected in Phase 2; the pipeline itself
  (build/test stages, OpenAPI lint) is untouched.

### 14.2 Environment defaults (D7)

- Locally the API listens on port `3000` and the web app on `3001` (both env-overridable) to
  avoid the default-port collision between `nest start` and `next dev`.
- `.env.example` defines non-secret defaults: `DATABASE_URL` (PostgreSQL in compose), `REDIS_URL`,
  API port, web origin(s) for CORS, log level.
- `docker/README.md` documents local-service defaults (db name, user, ports) consistently.

### 14.3 Tooling (recorded in D3/D2/D6)

- NestJS 11 + Jest (unit) + supertest (e2e); ESLint + prettier for lint; TypeScript strict.
- Next.js with App Router + TypeScript; Vitest for unit; smoke test for `test:e2e` in Phase 2.
- pino (via nestjs-pino or equivalent) for structured JSON logging with redaction.
- @nestjs/terminus (or equivalent) for health checks.

### 14.4 Code conventions inherited

- ESM output; Node 22 and pnpm 12.4.1 (CI parity).
- UUIDv7 utility for generated IDs (ADR-0001) may be introduced as a small shared base utility in
  `apps/api`; it is not required until entities exist but avoids duplicated implementations in
  later phases.
- Modules are named after capabilities, not a "common" grab-bag; cross-cutting base modules are
  small and single-purpose (config, logging, request-id, validation/errors, health, prisma,
  redis).

### 14.5 Anti-goals

- No business endpoints, no stub/fake data, no seed data, no web data fetching.
- No auth, RBAC, projects/keys, customers, payments, refunds, webhooks, idempotency,
  request-log API, audit-log API, rate limiting (Phases 3–13).
- No BullMQ queues (Phase 10; D9).
- No shared packages (no concrete reuse need).
- No production Docker images or deployment config (Phases 21–24).
- No Playwright/browser e2e stack (Phase 17; D2).

## 15. Out of Scope

- Authentication, sessions, passwords (Phase 3).
- Organizations, membership, RBAC (Phase 4).
- Projects, API keys, environments (Phase 5).
- Customers, payments, refunds, idempotency, webhooks, event system implementation
  (Phases 6–10).
- Request/audit log APIs (Phases 11–12).
- Rate limiting (Phase 13).
- Full dashboard UI, security headers for the web app, documentation pages (Phases 14–15).
- Sandbox simulation scenarios (Phase 16).
- Comprehensive e2e/browser testing (Phase 17).
- Production Docker, staging, CI/CD expansions, AWS, observability platform (Phases 20–24).
- Microservices, Kubernetes, real payments, billing, SSO (master specification).

## 16. Decisions (Confirmed)

All decisions below were confirmed by the product authority on **2026-09-17**. The
architecture-level decisions are recorded as ADRs: D1 → ADR-0011, D5 → ADR-0012, D9 → ADR-0013.
The remaining decisions (D2, D3, D4, D6, D7, D8) are recorded here and bind implementation as
stated.

| #   | Decision                                        | Confirmed decision                                                                                                                                                                                                              |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Prisma schema scope in Phase 2                  | Base schema only (datasource + generator, zero domain models); domain entities added by owning phases via migrations (ADR-0011).                                                                                                 |
| D2  | e2e tooling                                     | API: supertest (Nest app) with real PG/Redis via CI service containers. Web: minimal smoke `test:e2e`; Playwright/browser e2e deferred to Phase 17.                                                                              |
| D3  | Logging library                                 | pino + nestjs-pino (structured JSON, redaction).                                                                                                                                                                                 |
| D4  | Health endpoint tooling/paths                   | @nestjs/terminus; `GET /health/live` + `GET /health/ready`; outside `/api/v1`; readiness = PostgreSQL + Redis.                                                                                                                    |
| D5  | OpenAPI/Swagger integration                     | Swagger UI served from the API reading the canonical `docs/openapi.yaml`; **no** generated parallel contract in Phase 2 (ADR-0012).                                                                                              |
| D6  | Web framework/test mode                         | Next.js App Router; Vitest for unit tests.                                                                                                                                                                                       |
| D7  | Local ports and compose defaults                | API `3000`, Web `3001`; db name/user per `.env.example` defaults; documented in `docker/README.md`.                                                                                                                              |
| D8  | CI service containers                           | Add PostgreSQL + Redis service containers to the `ci` job so API e2e runs against real dependencies.                                                                                                                             |
| D9  | BullMQ integration timing                       | Redis connectivity + readiness in Phase 2; BullMQ wiring (queues, workers) deferred to Phase 10 when events exist (ADR-0013).                                                                                                    |

**No business-requirements ambiguity exists in Phase 2**: the phase introduces no business
behavior. The decisions above are technical policy; D1 is the only one with product-visible
consequences (schema completeness).

## 17. Dependencies

- Inputs: Phase 0 skeleton (workspace, CI), Phase 1 artifacts (SPEC/ADR/architecture docs,
  OpenAPI contract), master specification.
- Blocks: Phase 3 (Authentication) and all later phases.
- No dependency on Phase 2 by Phase 1 requirements remains open (phase 1 §19: "no blocking open
  questions remain for Phase 2").