# Phase 1 — Architecture & MVP Specification

|                   |                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase             | 1                                                                                                                        |
| Name              | Architecture & MVP Spec                                                                                                  |
| Status            | Ready for Implementation — all decisions (D1–D10) confirmed and recorded as ADRs; no blocking open questions for Phase 2 |
| Depends on        | Phase 0 (complete)                                                                                                       |
| Blocks            | Phase 2 (Foundation) and all subsequent phases                                                                           |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 1                                                                                 |

---

## 1. Objective

Design and record the system architecture, domain model, API contracts, and MVP boundaries of BrinnPay **before** implementation code is written.

This phase produces architecture artifacts and formal decisions. It does not implement application code, infrastructure, or application features. Those belong to Phase 2 and later.

The architecture defined in this phase is the input for every subsequent phase and must remain consistent with the [master specification](../SPEC.md).

## 2. Scope

Produce and record:

1. Actor identification.
2. Environment definitions.
3. Domain model (entities, relationships, module boundaries).
4. API conventions (naming, versioning, pagination, errors, idempotency).
5. OpenAPI contract (API surface for the MVP).
6. ID strategy decision.
7. Event system design.
8. Security baseline.
9. Web application structure and route boundaries.
10. Public vs authenticated application areas.
11. MVP boundaries and scope confirmation.

The following Phase 1 roadmap items are explicitly **not** part of this phase:

- NestJS / Next.js scaffolding (Phase 2).
- Database schema and Prisma models (Phase 2 and later phases).
- Infrastructure and Docker (Phase 2 and later phases).

## 3. Context

The master specification (`.ai/SPEC.md`) is the source of truth. Key constraints reused here:

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`), PostgreSQL + Prisma, Redis + BullMQ, Docker, REST, OpenAPI.
- The web application is a single Next.js application containing public and authenticated areas.
- The dashboard is a client of the API, not a second backend.
- TEST and LIVE project environments are both simulated; no real money.
- Security principles: strong authentication, RBAC, tenant isolation, secure API key handling, HMAC-SHA256 webhook signatures, rate limiting, secure logging.
- Out of scope for MVP: real payments, microservices, Kubernetes, multi-region, billing, enterprise SSO, CLI, separate documentation application.

The repository currently contains the Phase 0 skeleton only: monorepo workspace, CI workflow, `apps/api` and `apps/web` empty shells. There is no application code to conform to yet.

All architecture decisions that were previously listed as "required" (formerly §18) have been **confirmed** by the product authority and are recorded as ADRs in `.ai/decisions/` (ADR-0001 … ADR-0010). See [Confirmed Decisions](#18-confirmed-decisions).

## 4. Actors

| Actor                      | Definition                                                                                       | MVP product scope                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform administrator     | Internal operator of BrinnPay.                                                                   | **Out of product scope for the MVP.** Operational role only; no platform-admin UI/API in any MVP phase (ADR-0009).                                   |
| Organization owner         | User who creates an organization; full administrative authority.                                 | In scope (role in RBAC, Phase 4).                                                                                                                    |
| Organization administrator | Member with administrative permissions (manage members, projects, keys).                         | In scope (role in RBAC, Phase 4).                                                                                                                    |
| Member                     | Organization member with development/operational permissions.                                    | In scope (role in RBAC, Phase 4).                                                                                                                    |
| Viewer                     | Read-only member.                                                                                | In scope (role in RBAC, Phase 4).                                                                                                                    |
| Developer                  | A member using the API and dashboard to integrate BrinnPay.                                      | In scope; not a separate account type from Member.                                                                                                   |
| End user                   | The developer's customer ("buyer" in the simulated flows), represented by the `Customer` entity. | In scope as an **API-level entity only**. The end user does not have a BrinnPay account and does not access the BrinnPay web application (ADR-0008). |

> **Resolved:** the former ambiguity about the "end user" actor is resolved by ADR-0008 (end user = the developer's simulated `Customer`). The platform-administrator scope is resolved by ADR-0009 (no MVP product functionality).

## 5. Environments

Two distinct environment concepts exist and must not be confused:

### 5.1 Deployment environments

Where BrinnPay itself runs:

| Environment | Purpose                             | Introduced |
| ----------- | ----------------------------------- | ---------- |
| Local       | Developer machines, Docker Compose. | Phase 2    |
| Staging     | Pre-production, mirrors production. | Phase 22   |
| Production  | Public MVP release.                 | Phase 24   |

### 5.2 Project API environments

Environments of a BrinnPay **project**, exposed to developers via API keys:

- `TEST`
- `LIVE`

Both are simulated. No real money is processed in either.

**Representation convention:**

| Context                                  | Representation                       |
| ---------------------------------------- | ------------------------------------ |
| Conceptual model and UI copy             | Uppercase: `TEST`, `LIVE`            |
| API/JSON values (`environment` fields)   | Lowercase: `test`, `live`            |
| API key material                         | Prefix: `sk_test_…`, `sk_live_…` (ADR-0006) |

**Project/environment semantics:**

- A project supports **both** environments. A newly created project has `TEST` and `LIVE` available by default; the MVP introduces no configuration to disable or delete either environment.
- Each environment-scoped operation and resource belongs to **exactly one** environment.
- TEST and LIVE data are never mixed.
- API keys are scoped to exactly one project + environment (ADR-0006).

## 6. Domain Model

### 6.1 Entities and relationships

```text
User 1 ── 0..* OrganizationMember *── 1 Organization
Organization 1 ── * Project
Project 1 ── * ApiKey            (scoped to TEST or LIVE)
Project 1 ── * Customer
Customer 1 ── 0..* Payment
Payment 1 ── 0..* Refund         (partial refunds permitted)
Project 1 ── * WebhookEndpoint
WebhookEndpoint 1 ── * WebhookDelivery
WebhookEvent 1 ── * WebhookDelivery
Project 1 ── * IdempotencyRecord (unique per project + operation_scope + key within retention window)
RequestLog                       (API-wide; optional project/organization/user/api key scope)
Organization 1 ── * AuditLogEntry
Organization 1 ── * Invitation    (member invites, Phase 4)
User 1 ── * RefreshSession        (revocable refresh-token state, Phase 3)
```

### 6.2 Entity catalog

| Entity             | Responsibility                                                  | Notes                                                                                            |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| User               | Account of a BrinnPay user; authentication identity.            | Managed in dashboard and Auth flows.                                                             |
| Organization       | Tenant boundary; owns projects, members, audit entries.         | A registered user automatically obtains a personal/default organization (ADR-0010).              |
| OrganizationMember | Membership of a user in an organization with a role.            | Roles: `owner`, `admin`, `member`, `viewer` (Phase 4).                                           |
| Invitation         | Pending membership invitation.                                  | Provisionally in the model; detail in Phase 4.                                                   |
| Project            | Tenant-owned container for customers, payments, keys, webhooks. | Supports both `TEST` and `LIVE` (both available by default); each environment-scoped operation/resource belongs to exactly one environment. |
| ApiKey             | Credential for API access, scoped to a project environment.     | `sk_test_…` / `sk_live_…`; plaintext shown once at creation; stored hashed (ADR-0006).           |
| Customer           | Developer's customer record.                                    | API-level entity; represents the "end user" actor (ADR-0008).                                    |
| Payment            | Simulated payment operation with a lifecycle.                   | State machine detailed in Phase 7. ID per ADR-0001; amounts per ADR-0002; USD-only per ADR-0003. |
| Refund             | Full or partial refund against a payment.                       | Rules in Phase 9. Amount/currency per ADR-0002/0003.                                             |
| WebhookEndpoint    | Developer-registered destination URL + events subscription.     |                                                                                                  |
| WebhookEvent       | Domain event instance with payload and type.                    | Generated by payment/refund lifecycles; catalog in Phases 7/9/10.                                |
| WebhookDelivery    | One delivery attempt of a WebhookEvent to a WebhookEndpoint.    | Retries, replay in Phase 10.                                                                     |
| IdempotencyRecord  | Stored response keyed by (project, operation_scope, idempotency key). | 24-hour retention (ADR-0004); operation scopes include `payments.create`, `refunds.create`.  |
| RequestLog         | Structured record of an API request/response.                   | Phase 11. API-wide: `request_id` is mandatory; project/organization/user/API key scope is optional, so public and authenticated requests are both representable. |
| AuditLogEntry      | Immutable security/business event record.                       | Phase 12.                                                                                        |
| RefreshSession     | Revocable refresh-session state.                                | Phase 3. Access token is held in memory client-side; the refresh token is exposed to the browser only via an `HttpOnly` cookie. |

> **Conceptual model only.** This catalog defines the domain-level model. It is **not** a definitive Prisma schema: the detailed database schema belongs to Phase 2 (foundation) and to each domain phase. Entities here may be added to, split, or given more detail when their phase is specified.

### 6.3 Module boundaries (modular monolith)

> **Correction (see ADR record set):** the API is **not** organized as a one-to-one mapping of roadmap phases to modules. Roadmap phases define the implementation order and the granularity of feature specs, not architectural boundaries.

The API is organized into **domain and cross-cutting modules aligned with system boundaries and roadmap phases**:

- Domain modules follow business responsibility: `auth`, `organizations`, `projects`, `api-keys`, `customers`, `payments`, `refunds`, `webhooks` (payment/refund/webhook modules own their lifecycle and events).
- **Cross-cutting capabilities** — `idempotency`, `request-logging`, `audit-logging`, rate limiting, request validation, and request IDs — are application-level concerns shared by all modules. They must **not** be artificially coupled to a single roadmap phase or to one domain module.
- Modules follow domain boundaries and responsibility; the roadmap mainly defines the order in which they are built.

A module may be built across multiple roadmap phases (e.g., `payments` is driven by Phase 7 but its events are delivered via Phase 10), and one phase may touch several modules (e.g., Phase 4 spans `organizations` and `auth`).

### 6.4 Boundary rules

- Data access is always scoped by organization (tenant isolation). A user may only access resources of organizations they belong to.
- API-key-authenticated requests are scoped to the project the key belongs to.
- Modules own their persistence and business rules; they may not reach into another module's tables directly (enforced via module services/ports where needed).
- Cross-module communication uses module services or application-level queues, never direct database writes.
- Cross-cutting capabilities are accessible to all modules through shared application infrastructure, not through domain-module dependencies.

## 7. API Conventions

The public API is versioned REST. Conventions defined here bind all endpoint-level phases (3–13).

### 7.1 Base path and versioning

- Versioned via URL prefix: `/api/v1/...` (ADR-0005).
- The version is part of the URL; consumers pin to a version explicitly.
- No breaking changes within a version; breaking changes require a new version with isolated paths.
- First version: `v1` (the only version during the MVP).

### 7.2 Naming

- Resources named as plural nouns (`/customers`, `/payments`).
- Nested resources expressed with path hierarchy where ownership is strict (`/payments/{id}/refunds`).
- Path parameters use `snake_case`; request/response JSON uses `snake_case`.
- Query parameters for filtering/pagination use `snake_case`.
- Endpoint names in OpenAPI follow `operationId` conventions derived from module + action.

### 7.3 Authentication for the API

Two authentication modes exist. They are **not** equivalent and are documented and enforced separately per route:

- **API keys** — `Authorization: Bearer <api_key>` (ADR-0006). A key is scoped to exactly one project + environment; API-key requests can only act within that project/environment scope and never carry organization-management authority.
- **Session** — a short-lived JWT access token for dashboard/user endpoints. Session requests are scoped to the authenticated user's organization memberships and are subject to RBAC.

Resource endpoints (customers, payments, refunds, webhooks) accept either mode, but the effective authorization differs by mode. The web session model is defined in §11.5.

### 7.4 Idempotency

- Critical mutations (payment creation, refund creation) accept an `Idempotency-Key` header.
- The scope of a key is the tuple **(project, operation_scope, idempotency_key)**, where `operation_scope` is the specific idempotent operation (at minimum `payments.create` and `refunds.create`).
- Within the retention window:
  - same project + same operation scope + same key → replay of the original stored response (no re-execution);
  - same project + different operation scope + same key → an independent operation (no collision).
- **After 24 hours**, reuse of the same key is treated as a new operation.
- The 24-hour retention window is a single configurable constant shared by storage and API documentation (ADR-0004).
- Concurrency-safe behavior is required (Phase 8).
- Idempotency behavior is documented and reflected in the OpenAPI contract.

### 7.5 Pagination

- Cursor-based pagination (roadmap Phase 6 requirement).
- List endpoints accept `limit` and `cursor`; responses include a `next_cursor` (nullable) and result metadata.
- Cursor values are opaque to clients; the server derives them from the time-ordered entity IDs (UUIDv7, ADR-0001).
- Clients must not decode, persist for reuse across unrelated lists, or infer ordering guarantees beyond the documented `next_cursor` contract.

### 7.6 Errors

- Consistent JSON error envelope across all endpoints:

```json
{
  "error": {
    "code": "PAYMENT_ALREADY_REFUNDED",
    "message": "Human readable message",
    "request_id": "req_...",
    "details": {}
  }
}
```

- `code` is a stable machine-readable string; `details` is optional structured information (validation fields etc.).
- Every response carries the request ID (see 7.7).
- HTTP status codes follow standard REST semantics (400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 422 business rule violation, 429 rate limited, 5xx server).

### 7.7 Request IDs

- Every request is assigned a request ID at ingress.
- Propagated through logs, error responses, and outbound webhook-delivery records.
- Clients can reference a request ID when reporting issues.

### 7.8 Time, IDs, and format conventions

- All timestamps are UTC, ISO 8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`).
- All entity IDs are UUIDv7 (ADR-0001) and must be treated as **opaque strings** by clients.
- The `ApiKey` credential string (`sk_test_…`/`sk_live_…`, ADR-0006) is **credential material, not an entity ID**; it follows its own scheme. Request IDs and event envelopes follow the examples in §7.6/§9.5.
- Monetary amounts: decimal strings in the API paired with a currency code; integer minor units internally (ADR-0002):

```json
{ "amount": "10.00", "currency": "usd" }
```

## 8. Data Requirements (domain level)

Detailed schemas belong to Phase 2 and per-feature phases. Domain-level requirements decided here:

- **IDs**: UUIDv7 for all entity IDs (ADR-0001); stored as PostgreSQL `uuid`; exposed to the API as opaque strings.
- **Money**: amounts stored as integers in the smallest minor unit of the currency to avoid floating-point errors; the API exposes decimal strings (ADR-0002). Example: `{ "amount": "10.00", "currency": "usd" }` → `amount_minor = 1000`.
- **Currency scope**: USD only in the MVP; `currency` field remains on payments/refunds for forward compatibility; validation rejects non-`usd` values (ADR-0003).
- **API keys**: plaintext material generated once with environment prefix (`sk_test_…`/`sk_live_…`), displayed once, only a hash stored; hashes unique per project environment; keys never logged (ADR-0006). Detailed scheme in Phase 5.
- **Idempotency**: database-level uniqueness constraint on (project, operation_scope, key) for active records; 24-hour retention window; keys reusable as new operations after expiry (ADR-0004). Phase 8 details TTL/cleanup mechanics.
- **Request logs**: API-wide observability records; `request_id` is mandatory, while project/organization/user/API key scope is optional, so unauthenticated and organization-level requests (e.g., `/auth/*`, `/organizations`) are representable (Phase 11).
- **Audit logs**: append-only; entries are never updated or deleted.
- **Timestamps**: UTC; every persistent record carries `created_at`; mutable records carry `updated_at`.
- **Environments**: all project data is tagged with exactly one environment; conceptually `TEST`/`LIVE`, represented in the API as `test`/`live` (§5.2). A project supports both; TEST and LIVE data is never mixed.

## 9. Event System Design

### 9.1 Ownership

The event system is split across phases by responsibility:

- **Phase 1 defines only:** the general event model, naming conventions, the outbound envelope, and general signing requirements.
- Payment event catalog → **Phase 7** (payment lifecycle).
- Refund event catalog → **Phase 9** (refund lifecycle).
- Webhook delivery/event behavior (retries, replay, delivery records) → **Phase 10**.

Phase 1 does **not** enumerate the full event catalog. Event types are added where their lifecycle is specified (Phases 7/9/10) and must be named, unique, and documented before delivery.

### 9.2 Purpose

- Outbound webhook events to developer endpoints (Phase 10).
- Internal queued work (webhook delivery, future background processing).
- Auditability of business lifecycle transitions.

### 9.3 Model

- Events are discrete, immutable records with a type, payload, timestamp, and originating scope (project + environment).
- Internal queues use Redis + BullMQ (per master architecture).
- Webhook delivery is derived from events: each WebhookEndpoint subscribes to event types; each matching event produces a WebhookDelivery.

### 9.4 Naming convention

`<resource>.<past-tense-verb>` — e.g., `payment.succeeded`, `payment.failed`, `refund.succeeded`, `refund.failed`.

The full catalog is defined in Phases 7/9/10; Phase 1 fixes only the convention.

### 9.5 Event envelope (outbound)

```json
{
  "id": "0192f2a0-0000-7000-8000-000000000001",
  "type": "payment.succeeded",
  "created_at": "2026-01-01T00:00:00.000Z",
  "data": {},
  "environment": "test",
  "project_id": "0192f2a0-0000-7000-8000-00000000000a"
}
```

`id` and `project_id` are UUIDv7 entity IDs (ADR-0001), shown here as opaque placeholders.

Signing: outbound webhook payloads are signed with HMAC-SHA256 using the endpoint secret (master specification). Delivery/retry/replay semantics are detailed in Phase 10.

## 10. Security Baseline

The security baseline is established now; detailed implementation lands in the relevant phases.

| Area             | Requirement                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords        | **Argon2id is the required/default algorithm**; bcrypt permitted only as a documented exception requiring an explicit Phase 3 decision (ADR-0007). Phase 3.                                  |
| Sessions         | Short-lived JWT access tokens + revocable refresh sessions. Web: access token held in memory; refresh token exposed to the browser only via an `HttpOnly` cookie (Secure in secure/production environments, `SameSite` configured to minimize CSRF). §11.5. |
| API keys         | Prefixed format `sk_test_…`/`sk_live_…`; stored hashed only; shown once at creation; scoped to (project, environment); never logged (ADR-0006).                                              |
| Authorization    | RBAC with roles `owner`, `admin`, `member`, `viewer`; enforced per route and per resource.                                                                                                   |
| Tenant isolation | All queries and mutations scoped by organization; IDOR prevention is a first-class test concern. ID opacity (ADR-0001) is not a security control — authorization never relies on ID secrecy. |
| Webhooks         | HMAC-SHA256 signatures with endpoint secret; secrets never logged or returned.                                                                                                               |
| Rate limiting    | IP-based and API-key-based; applied to auth endpoints from Phase 3, to all API routes by Phase 13.                                                                                           |
| Input validation | All external input validated at the boundary (NestJS pipes/DTOs).                                                                                                                            |
| Logs             | Structured; secrets, passwords, API keys, webhook secrets, and tokens never written to logs.                                                                                                 |
| Headers          | Security headers on web responses (CSP, HSTS in production, etc.).                                                                                                                           |
| Errors           | Error responses never leak internals (stack traces, db details, secrets).                                                                                                                    |

## 11. Web Application Structure

Single Next.js application (`apps/web`) per the master specification. Route boundaries are defined now; the UI implementation is Phase 14.

`apps/web` is a **client of the API**: it contains no parallel backend and no domain/business logic. All business rules belong to the backend (`apps/api`); the web application consumes the documented API contracts only.

### 11.1 Public area (unauthenticated)

- `/` — home / product overview.
- `/product` and product detail pages.
- `/docs/**` — documentation and integration guides (Phase 15).
- Marketing/legal pages as required later.

Public routes must not expose authenticated data, internal architecture specifics, or any sensitive material.

### 11.2 Authentication area

- `/login`
- `/register`

Session-related flows as defined in Phase 3. These routes redirect authenticated users away from the auth pages.

### 11.3 Authenticated area (requires authentication + authorization)

- `/dashboard` — overview.
- `/dashboard/organizations` — organization management and member/role management.
- `/dashboard/projects` — project list and management.
- `/dashboard/projects/[projectId]` — project shell with environment selector (`TEST`/`LIVE`).
- `/dashboard/projects/[projectId]/api-keys`
- `/dashboard/projects/[projectId]/customers`
- `/dashboard/projects/[projectId]/payments`
- `/dashboard/projects/[projectId]/refunds`
- `/dashboard/projects/[projectId]/webhooks`
- `/dashboard/projects/[projectId]/logs/requests`
- `/dashboard/projects/[projectId]/logs/audit`
- `/dashboard/settings` — account settings.

### 11.4 Route protection rules

- Authenticated routes reject unauthenticated visitors (redirect to `/login`).
- **Authenticated routes require authentication + authorization.**
- Organization-scoped pages enforce membership; **project-scoped routes validate project access within the organization** before rendering any data.
- Role-based UI restrictions match the RBAC model (e.g., viewer sees read-only interfaces).
- Data displayed is fetched from the API under the user's session; the web application never bypasses API-level authorization.

### 11.5 Web session model

How the session is handled in `apps/web` (architecture fixed now; exact durations, rotation, and cookie domain details belong to Phase 3):

**Access token**

- Short-lived JWT used to call the API.
- **Never** stored in `localStorage` or `sessionStorage`.
- Held in memory for the duration of the active session; re-obtained via refresh when needed.

**Refresh token**

- Revocable; refresh-session state is persisted server-side (`RefreshSession`).
- Exposed to the browser **only** as an `HttpOnly` cookie — never readable by browser JavaScript.
- `Secure` in secure/production environments; `SameSite` configured to minimize CSRF.

**Logout**

- Revokes/invalidates the corresponding refresh session server-side and clears the cookie.

Public routes never read or display session material; authenticated routes only request session tokens through the defined auth flow.

## 12. MVP Boundaries

The MVP scope is defined by the master specification (MVP section) and the roadmap phases 2–26.

Confirmed app-level boundaries:

- One modular monolith API, one web application, one PostgreSQL database, one Redis instance, one Docker-based deployment topology.
- No microservices, Kubernetes, multi-region, or real payment processing.
- **No platform-admin product functionality** in any MVP phase (ADR-0009).
- **No end-user (customer-facing) product area** — the end user is the developer's simulated `Customer`, API-level only (ADR-0008).
- **USD-only** currency scope (ADR-0003).
- No multi-currency simulation, exchange rates, or cross-currency logic.

Each roadmap phase keeps its own detailed specification; this phase only sets the boundaries that all phases share.

## 13. Implementation Considerations

### 13.1 Artifacts to produce

This phase's deliverables are documents and a machine-readable contract, not code:

- **ADR records** for every confirmed decision — `.ai/decisions/adr-0001…0010` (created; see §18).
- **Domain model document** capturing §6 (entities, relationships, module boundaries).
- **OpenAPI contract** at `docs/openapi.yaml` — the canonical, single contract of the project.
- **API conventions document** (§7) and **security baseline** (§10).
- **Web application structure/routes document** (§11).

### 13.2 OpenAPI contract

- **Canonical location and single source of truth:** `docs/openapi.yaml`.
- Describes the `v1` API surface at `/api/v1` (ADR-0005) covering the full MVP resource surface (auth, organizations, projects, api keys, customers, payments, refunds, webhooks, idempotency, logs).
- Sufficiently complete to guide Phases 2–13. Detailed behavior of payments, refunds, and webhooks is **not** required beyond their structural contracts; those endpoints are refined in-place by their domain phases (7/9/10).
- Later phases may extend or refine `docs/openapi.yaml` but must not create parallel, incompatible contracts.
- Validated with an OpenAPI linter (e.g., Redocly CLI or equivalent) in local checks/CI.

### 13.3 Traceability

Every Phase 1 roadmap checkbox maps to an artifact or decision:

| Roadmap Phase 1 checkbox                                 | Artifact / decision                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Actors identification                                    | §4 + ADR-0008 (end user), ADR-0009 (platform admin)                   |
| Environment definitions                                  | §5                                                                    |
| Domain model (entities, relationships, boundaries)       | §6                                                                    |
| API conventions (naming, versioning, pagination, errors) | §7 + ADR-0005 (versioning)                                            |
| OpenAPI contract                                         | §13.2, deliverable `docs/openapi.yaml`                                |
| ID strategy (UUIDs, CUIDs, or ULIDs)                     | ADR-0001 + §8                                                         |
| Event system design                                      | §9                                                                    |
| Security baseline                                        | §10 + ADR-0006 (API keys), ADR-0007 (passwords)                       |
| Web application structure and route boundaries           | §11                                                                   |
| Public vs authenticated application areas                | §11.1–11.4                                                            |
| MVP boundaries and scope                                 | §12 + ADR-0003 (currency), ADR-0008, ADR-0009, ADR-0010 (default org) |

### 13.4 General considerations

- **Ordering:** the OpenAPI contract depends on versioning, naming, error, and pagination decisions (§7), all of which are now confirmed.
- **Consistency rule:** phase specifications produced later must not contradict the decisions recorded here without an explicit ADR amendment (master specification §"Source of Truth").
- **Config-driven policy:** the idempotency retention window (ADR-0004) is a single shared constant so documentation and implementation cannot drift apart.

## 14. Testing Requirements

This phase ships no runtime code, so functional unit/integration tests do not apply. Verification instead targets the artifacts:

- OpenAPI contract (`docs/openapi.yaml`) passes schema validation/linting with zero errors.
- ADRs exist for every confirmed decision (§18) and are internally consistent (decision + rationale + consequences).
- Domain model document is consistent with the master specification's core concepts and the API conventions.
- Route structure matches the master specification's public/authenticated separation.
- A traceability cross-check shows that all externally exposed domain entities have a corresponding API representation in the OpenAPI contract, and that no OpenAPI resource lacks a domain-model entity. Infrastructure-only entities (e.g., `IdempotencyRecord`, `RefreshSession`) do not require public API resources and are explicitly marked as internal.
- No blocking decisions remain; items deferred to later phases are explicitly listed as deferred (§19), not silently dropped.

## 15. Acceptance Criteria

1. All actors are documented and their MVP scope is unambiguous: platform administrator (ADR-0009) and end user (ADR-0008) are resolved; org roles (owner, admin, member, viewer) are identified.
2. Deployment environments (local/staging/production) and project API environments (TEST/LIVE) are formally distinguished and documented.
3. Domain model document exists: entities, relationships, module boundaries, and boundary rules; module boundaries follow **domain responsibility and cross-cutting capability**, not a one-to-one phase mapping (§6.3).
4. ID strategy decision recorded as ADR-0001 (UUIDv7, opaque API IDs).
5. API conventions document exists: base path/versioning (ADR-0005), naming, auth modes, idempotency with 24h retention (ADR-0004), cursor pagination, error envelope, request IDs, time/money/format conventions (ADR-0002).
6. OpenAPI contract exists at `docs/openapi.yaml`, describes `/api/v1`, validates with zero errors, covers the full MVP resource surface, and is the single canonical contract (§13.2).
7. Event system design exists: ownership split across Phases 1/7/9/10 (§9.1), purpose, model, naming convention, outbound envelope, HMAC signing requirement.
8. Security baseline covers authentication (ADR-0007), API keys (ADR-0006), RBAC, tenant isolation, webhook signing, rate limiting, validation, logging, and error safety.
9. Web application structure documented with public, authentication, and authenticated areas; route protection defined; `apps/web` confirmed as an API client with no parallel backend (§11).
10. MVP boundaries confirmed against the master specification; out-of-scope items (platform admin functionality, end-user self-service, multi-currency, microservices) are explicit (§12).
11. All confirmed decisions (D1–D10) are recorded in ADRs (§18) and referenceable.
12. No later-phase dependency is blocked by an unaddressed ambiguity from this phase; deferred items are explicitly listed (§19).

## 16. Definition of Done

This phase is complete when:

- All deliverables in §13 exist, are reviewed, and pass the artifact validations in §14.
- All decisions D1–D10 have been confirmed by the product authority and recorded as ADRs (`.ai/decisions/adr-0001…0010`).
- The master specification and roadmap are consistent with the architecture artifacts (no contradictions; see §19 verification).
- The OpenAPI contract lints clean.
- Phase 2 (Foundation) can be started without re-opening architecture decisions made here.

## 17. Out of Scope

- Any application source code, database schema, or Prisma models (Phases 2+).
- Infrastructure, Docker files, CI changes beyond artifact validation (Phases 2+).
- Detailed endpoint behavior of payments, refunds, webhooks, logs, rate limiting (Phases 7–13).
- Authentication/authorization implementation (Phase 3/4).
- Web application implementation (Phase 14).
- Platform-admin UI/API (ADR-0009).
- End-user (customer-facing) product area (ADR-0008).
- Multi-currency simulation, rates, exchange logic (ADR-0003).
- Microservices, Kubernetes, multi-region, real payment processing, billing, SSO (per master specification).

## 18. Confirmed Decisions

All decisions previously opened in this specification have been **confirmed** and recorded as ADRs:

| #   | Decision               | Confirmed outcome                                                                                                                              | ADR      |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | ID strategy            | **UUIDv7**; stored as PostgreSQL `uuid`; opaque API strings                                                                                    | ADR-0001 |
| D2  | Money representation   | **Integer minor units** internally; **decimal strings** in the API                                                                             | ADR-0002 |
| D3  | MVP currency scope     | **USD only**; `currency` field kept for forward compatibility                                                                                  | ADR-0003 |
| D4  | Idempotency retention  | **24 hours**; key scope = (project, operation_scope, key); replay within window returns original response; reuse after expiry is a new operation | ADR-0004 |
| D5  | API versioning         | **`/api/v1` URL prefix**; no breaking changes within a version                                                                                 | ADR-0005 |
| D6  | API key format         | **`sk_test_…` / `sk_live_…`**; shown once; stored hashed; never logged; detailed scheme in Phase 5                                             | ADR-0006 |
| D7  | Password hashing       | **Argon2id required/default**; bcrypt permitted only as a documented exception via an explicit Phase 3 decision                                 | ADR-0007 |
| D8  | End user actor         | = developer's simulated **`Customer`**; no BrinnPay account; no dashboard access                                                               | ADR-0008 |
| D9  | Platform administrator | **No MVP product functionality**; no UI/API in any MVP phase                                                                                   | ADR-0009 |
| D10 | Organization default   | Registered user **automatically obtains a personal/default organization** at onboarding (direction confirmed; mechanics deferred to Phase 3/4) | ADR-0010 |

## 19. Open Questions and Deferred Items

**Resolved.** The open questions previously recorded in this specification are resolved by the confirmed decisions:

1. **Multi-currency** → resolved: USD-only for MVP (ADR-0003).
2. **Idempotency retention** → resolved: 24-hour retention window with key scope = (project, operation_scope, key) (ADR-0004).
3. **Webhook event catalog ownership** → resolved: payment events → Phase 7, refund events → Phase 9, delivery/behavior → Phase 10; Phase 1 defines only the general model, naming conventions, envelope, and signing requirements (§9.1).
4. **Organization default** → resolved at the direction level: auto-created personal/default organization on onboarding (ADR-0010); detailed mechanics belong to the Phase 3/4 specifications.
5. **OpenAPI artifact location** → resolved: `docs/openapi.yaml`, single canonical contract (§13.2).

**Deferred to later phases (non-blocking, explicitly owned):**

| Deferred item                                                                   | Owned by                 |
| ------------------------------------------------------------------------------- | ------------------------ |
| Detailed API key scheme (length, charset, hashing, lookup)                      | Phase 5                  |
| Idempotency operation-scope catalog beyond `payments.create`/`refunds.create`, TTL/cleanup mechanics | Phase 8  |
| Organization-default mechanics (timing, naming, transactionality, default role) | Phase 3/4 specifications |
| Payment event catalog                                                           | Phase 7                  |
| Refund event catalog                                                            | Phase 9                  |
| Webhook delivery/retry/replay behavior                                          | Phase 10                 |
| Detailed endpoint behavior of all domain resources                              | Respective phases 3–13   |
| Definitive Prisma schema                                                        | Phase 2 + domain phases  |

**No blocking open questions remain for Phase 2.**

### Consistency verification (Master SPEC / ROADMAP / Phase 1)

- ID strategy: neither SPEC.md nor ROADMAP fixes an ID scheme; ADR-0001 is additive. Consistent.
- Money/currency: not specified elsewhere; ADR-0002/0003 are additive and align with the roadmap's payments/refunds phases. Consistent.
- Roadmap Phase 3 "Password hashing (bcrypt/argon2)": lists candidates; ADR-0007 fixes Argon2id as the required/default algorithm, with bcrypt permitted only as a documented exception requiring an explicit Phase 3 decision. Compatible — no contradiction.
- Roadmap Phase 1 "Actors identification": resolved by §4 + ADR-0008/0009. Consistent with SPEC.md, which defines no platform-admin or end-user product area.
- Web application: SPEC.md and Phase 1 §11 agree on a single Next.js app with public + authenticated areas and API-client role. Consistent.
- Roadmap Phase 8 Idempotency: "key support, DB constraints, transaction safety" — consistent with ADR-0004 (key scope = project + operation_scope + key; retention window does not change constraint semantics for active records).
- Roadmap Phase 5 (key rotation, revocation) — consistent with ADR-0006 (keys shown once, hashed storage forces rotation as the recovery path).
- Module boundaries §6.3: no statement in SPEC.md or ROADMAP contradicts domain/cross-cutting module organization.

## 20. Dependencies

- Blocks: Phase 2 (Foundation), every later phase.
- Inputs: Phase 0 artifacts (AGENTS.md, SPEC.md, ROADMAP.md, CI), master specification, ADR-0001…0010 (this phase).
