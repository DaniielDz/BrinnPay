# Phase 11 — Request Logging

| | |
| --- | --- |
| Phase | 11 — Request Logging |
| Status | **Approved — decisions D1–D8 confirmed by product authority (2026-10-01)** |
| Depends on | Phase 2 (request IDs, structured logging base, validation), Phase 4 (capability registry), Phase 5 (session-only project route pattern), Phases 7–9 (environment rule pattern, redaction obligations), Phase 10 (shared project-scope extraction, blocks this phase), Phase 1 (contract, conventions, entity catalog) |
| Blocks | Phase 12 (audit logs — same `logs` surface, capability and viewer patterns), Phase 14 (request-logs viewer item is delivered here), Phase 17 (testing), Phase 18 (security hardening — log redaction review), Phase 20 (observability) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 11 |

## 1. Objective

Make every API request **traceable end to end**:

1. **Verify and complete request-ID propagation** — server-assigned request IDs already flow
   through ingress, the `X-Request-Id` response header, the error envelope, structured stdout
   logs (Phase 2), idempotency replays (Phase 8), and webhook delivery records (Phase 10).
   Phase 11 persists the request ID into a durable record and proves the propagation chain
   with tests.
2. **Persist structured request/response records** — a durable, API-wide `RequestLog` store
   (phase 1 §6.2/§8, `docs/domain-model.md` §5): `request_id` mandatory, project /
   organization / user / API-key scope optional, so public, session, and API-key requests are
   all representable. Metadata only — never bodies, headers, secrets, or query strings.
3. **Expose the contracted read surface** — `GET /projects/{project_id}/logs/requests`
   (`logs.listRequestLogs`, session-only) with cursor pagination.
4. **Deliver the dashboard request-log viewer** — replace the placeholder at
   `/dashboard/projects/[projectId]/logs/requests`.

The Phase 2 stdout logging base (pino, redaction, request IDs) remains the process-wide
observability channel; this phase does **not** build a second logging system. Both
environments stay simulated and no real money is processed.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| Request ID propagation | §4.2 rules 1–3, §5.2 (persist + verify the existing chain) |
| Structured JSON logging | §3 (already delivered by Phase 2 D3 — verified and regression-tested here, not rebuilt) |
| API request/response logs | §4 (capture rules), §5 (persistence), §4.3 (read API) |
| Request log viewer in the dashboard | §7 |

## 2. Scope

In scope:

- A cross-cutting **`request-logging`** capability module in `apps/api` (Phase 2 §4.4
  explicitly deferred it to this phase; `docs/domain-model.md` §3 defines it as
  application-level, not a domain module).
- One committed Prisma migration adding the `request_logs` model (ADR-0011: the owning phase
  adds its schema).
- The contracted `logs.listRequestLogs` operation with session-only authorization, capability
  enforcement, cursor pagination, and the optional environment/request-id filters (D1, D8).
- Extension of the Phase 4 capability registry with a `logs.read` capability (D2).
- Retention and cleanup of persisted records (D5).
- Dashboard request-log viewer replacing the existing placeholder.
- In-place refinement of `docs/openapi.yaml` (ADR-0012): descriptions, and the additive
  `environment` (D1) and optional `request_id` (D8) schema/parameter changes. No new API
  version.

Explicitly **not** extended here: the payment/refund/webhook/idempotency behavior, the event
catalog, rate limiting, audit logging, metrics, or any new resource route beyond the
contracted one.

## 3. Context and current-state findings

**What exists today**

- `apps/api/src/request-id/` assigns a request ID at ingress (`req_…`, server-generated —
  an inbound `X-Request-Id` is never trusted), sets the response header, and is reused by the
  logger's `genReqId`, so every stdout line and the response correlate.
- `apps/api/src/logging/logger.config.ts` (Phase 2 D3): nestjs-pino structured JSON with
  `REDACT_PATHS` covering bodies, `authorization`, `cookie`, `idempotency-key`, API keys,
  tokens, webhook secret ciphertext, and card-like fields; `autoLogging` ignores
  `/health/live` and `/health/ready`.
- The error envelope repeats `error.request_id` (`docs/api-conventions.md` §6/§7); Phase 8
  serves idempotency replays under the **current** request's ID; Phase 10 stores the causing
  `request_id` on webhook delivery rows (phase 10 §4.3.11).
- `docs/openapi.yaml` already declares `logs.listRequestLogs` (SessionAuth **only**), the
  `RequestLog` schema (required: `id`, `request_id`, `method`, `path`, `status_code`,
  `created_at`; nullable `project_id`, `organization_id`, `user_id`, `api_key_id`; optional
  `duration_ms`) and `RequestLogList`; tag `logs` covers Phases 11–12. The operation takes
  `ProjectId`, `Environment`, `Limit`, `Cursor`.
- `docs/api-conventions.md` §3 lists `logs/*` as **session-only**; §9 requires `request_id`
  mandatory with optional tenant scope so public requests are representable.
- `apps/api/prisma/schema.prisma` has **no** request-log model and no migration provides one.
- `organizations/roles.ts` has **no** logs capability — yet `ProjectRbacGuard` routes require
  `@RequireCapability`, so the route cannot be declared without extending the registry.
- The session-only project-route precedent is the Phase 5 api-keys controller
  (`SessionAuthGuard + ProjectRbacGuard`); dual-mode routes use the Phase 10 shared
  `ProjectAccessGuard`. The shared cursor helper (`organizations/cursor.ts`) paginates
  **ascending by UUIDv7** (Phase 6/7/10 pattern).
- The dashboard page at `/dashboard/projects/[projectId]/logs/requests` is a placeholder whose
  text says "Request logging arrives in Phase 11".
- `forbidNonWhitelisted` validation rejects undeclared query parameters (400), and the global
  prefix is `api/v1` with health excluded; Swagger UI mounts at `swaggerPath` (default
  `docs`), outside the API prefix.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | The contract's `Environment` parameter on `logs.listRequestLogs` has no stated requiredness (unlike `customers.list`, which spells out the Phase 7 D1 400-rule), and the `RequestLog` schema has **no** `environment` field — so an environment filter cannot work without recording environment on the record. | D1 — record a nullable `environment` and treat the parameter as an **optional equality filter**; the required-in-session variant is explicitly rejected. |
| F2 | No capability exists for reading request logs; every project route must declare one. | D2 — add `logs.read`; matrix confirmed below. |
| F3 | Two roadmap checkboxes (structured logging, request-ID propagation) were largely delivered by Phases 2/8/10. | §3/§4.2 — this phase verifies them with regression tests and adds persistence; it does not rebuild them. |
| F4 | Persisting a row per request synchronously would couple request latency and availability to the log store. | D3 — best-effort write **after** the response; a failed write is logged and dropped, never surfaced to the caller. |
| F5 | The store is API-wide (auth, org, and public requests included), but the only contracted surface is project-scoped; non-project records have no v1 endpoint. | §4.3/§11 — deliberate, per the contract's own description ("Non-project requests exist in the log store but are not exposed by this project-scoped endpoint"). No new endpoint is invented. |
| F6 | The logs route is session-only, unlike the dual-mode domain resources — API keys must never read logs. | §4.3 — Phase 5 api-keys pattern (session-only project route); an `sk_…` bearer on this route is 401. |
| F7 | Ordering is unspecified in the contract; the shared cursor helper is ascending, while log viewers conventionally show newest first. | D4 — ascending, consistent with every existing list and the Phase 10 events/deliveries precedent. |
| F8 | Retention is unspecified; one row per request grows without bound. | D5 — configurable retention with a periodic cleanup job (Phase 10 D9 pattern). |
| F9 | `path` is ambiguous ("Request path.") — with or without the query string — and the content allowlist must be stated so nobody stores more than the contract fields. | D6 — metadata allowlist; path **without** query string. |
| F10 | Which surfaces count as "API request/response logs"? Health probes, Swagger UI asset traffic, and CORS preflights are process noise, not API calls. | D7 — persist requests whose path is under the `/api/v1` prefix; stdout logging stays process-wide. |
| F11 | `docs/api-conventions.md` §7 says clients can reference a request ID when reporting issues, but the list offers no way to find one. | D8 — optional, additive `request_id` filter (Phase 10 D15 precedent). |

## 4. API application — `apps/api`

### 4.1 Module purpose and boundaries

A cross-cutting `request-logging` capability owns three responsibilities:

1. **Capture** — assembling the record's allowlisted fields from the request context after the
   response has been produced.
2. **Persistence** — writing and retaining `request_logs` rows (D3, D5).
3. **Read surface** — the contracted `logs.listRequestLogs` operation.

Boundaries (`docs/domain-model.md` §3/§4): domain modules (`payments`, `webhooks`, …) never
write request-log rows and never touch `request_logs`; capture is driven by the application
request lifecycle, not by domain services. The capability reads nothing beyond request
context already resolved by the guards. Structured stdout logging (Phase 2) and audit logging
(Phase 12) are separate concerns; this module does not replace either.

### 4.2 Record rules (domain rules)

1. **One record per request.** Every request whose path is under the `/api/v1` prefix
   (D7) produces exactly one record — including unauthenticated and failed requests
   (400/401/403/404/429/5xx). Excluded surfaces (D7) produce no record. A record may become
   visible to the list endpoint slightly after the caller received its response (it is
   written after the response is sent); that visibility lag is accepted, not a defect.
2. **Request IDs are server-assigned.** The stored `request_id` equals the `X-Request-Id`
   header of that very response and the `error.request_id` of an error response. Inbound
   `X-Request-Id` values are never trusted or echoed. IDs are never reused as secrets
   (phase 1 §7.7).
3. **Propagation chain.** The same request ID appears in the structured stdout log lines of
   the request, in the error envelope, in the idempotency record's replayed response (served
   under the current request's ID, phase 1 §7.4), and in any webhook-delivery rows the request
   caused (phase 10 §4.3.11).
4. **Metadata allowlist only (D6).** A record stores exactly the contract's fields plus the
   D1 `environment`: `method`, `path` (no query string), `status_code`, `duration_ms`,
   `created_at`, `request_id`, and the scope ids. Never headers, never request or response
   bodies, never query strings, never tokens, never `Idempotency-Key` values, never raw API
   keys. Records are built from an explicit field allowlist, not by redacting a larger
   payload.
5. **Scope is optional and contextual.** Each scope column is populated from the context
   resolved before the response was produced, and stays `null` when unknown:

   | Request | `project_id` | `organization_id` | `user_id` | `api_key_id` | `environment` |
   | --- | --- | --- | --- | --- | --- |
   | API-key mode, project route | ✓ | ✓ | null | ✓ | ✓ (from the key) |
   | Session, project route | ✓ | ✓ | ✓ | null | when the request carried a validated environment (D1) |
   | Session, organization route | null | ✓ | ✓ | null | null |
   | Session, auth/user route (`/auth/*`) | null | null | ✓ when authenticated within the request | null | null |
   | Unauthenticated / rejected before scope resolution (401, unknown project, or a non-member's 404 — indistinguishable per §4.3) | null | null | null | null | null |
   | Failed after partial resolution by a member (403 missing capability, 404 on a sub-resource) | populated to the point of failure | | | | |

   A non-member's 404 must be null-scoped exactly like an unknown project: guards attach the
   project context only **after** membership resolves, so an authenticated outsider can never
   write rows carrying a foreign `project_id`/`organization_id` into another tenant's log.

6. **Immutability.** Records are never updated after creation. They are removed only by
   tenant cascade (project/organization deletion) or by retention expiry (D5). The
   database-level `ON DELETE SET NULL` on the actor columns (`user_id`, `api_key_id`) is not
   an update within the meaning of this rule: deleting a user or key nulls the reference
   without altering the record's content, and no application code path ever updates a row.
7. **Loss semantics (D3).** Persistence is best-effort and runs after the response: a write
   failure is logged as an error and the record is dropped; it must never delay, modify, or
   fail the originating request, and it must not change API readiness (Phase 2 D9).
8. **Self-logging is normal.** The `logs.listRequestLogs` request itself produces a record
   like any other; this is not recursion and requires no special case.

### 4.3 API behavior and authorization

`GET /projects/{project_id}/logs/requests` — **session-only**, exactly like the Phase 5
api-keys surface: `SessionAuthGuard` + `ProjectRbacGuard` + `@RequireCapability
({ capability: 'logs.read' })`. The dual-mode `ProjectAccessGuard` is deliberately **not**
used: an API key never carries management/observability authority (phase 1 §7.3, F6).

| Aspect | Behavior | Result |
| --- | --- | --- |
| Authorization | Malformed/unknown `project_id` or non-member → 404 (existence never disclosed); member without `logs.read` → 403; missing/invalid/expired session or an `sk_…` bearer → 401. | As stated. |
| Query parameters | `project_id` (path), `environment` (optional filter, D1), `request_id` (optional exact filter, D8), `limit` (default 20, max 100), `cursor` (opaque). Undeclared parameters are rejected by the global validation pipe. | 200 / 400 / 401 / 403 / 404 / 429. |
| `environment` (D1) | Optional. Present → only records whose `environment` equals the value (records with `environment = null` are excluded). Absent → all of the project's records. Invalid value → 400 field error. There is **no** 400 for a *missing* environment (the contract states no requiredness for this operation — F1). | 200 / 400. |
| `request_id` (D8) | Optional exact match within the addressed project; malformed value → 400 field error; no match → empty `data` with `has_more: false` (never 404). | 200 / 400. |
| Pagination | Cursor-based, ascending by UUIDv7 (D4), `{ data, next_cursor, has_more }`, stable and non-overlapping under filtering. | 200; 400 malformed cursor/limit. |
| Response body | The contracted `RequestLogList` projection only — the allowlisted fields of §4.2 rule 4. Never secrets, headers, bodies, or query strings. | 200. |
| Idempotency / rate limiting | GET — no `Idempotency-Key`. Rate limits are Phase 13's; this phase adds none (429 stays declared). | — |
| Contract | Refine `docs/openapi.yaml` in place (ADR-0012): document environment semantics, ordering, retention, and the optional filters; add the nullable `environment` property and the optional `request_id` parameter. Lint must stay clean; no new API version. | — |

Errors use the canonical envelope only: `VALIDATION_ERROR` (400) with `details.fields`,
`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `RATE_LIMITED` (429, Phase 13).
No new error code is introduced.

### 4.4 Authorization model (D2)

Extend the Phase 4 capability registry (single source of truth:
`organizations/roles.ts`) with `logs.read`:

| Capability | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| `logs.read` (request logs of a project) | ✓ | ✓ | ✓ | ✓ |

Rationale: request logs contain metadata only (no bodies, no secrets — §4.2 rule 4), so they
follow the read-for-every-role pattern of Phases 5–10 (projects, api-keys, customers,
payments, refunds, webhooks). The alternative (owner/admin only, like `invitations.read`) is
recorded as rejected in D2. API-key mode never evaluates capabilities on this route because
API keys are rejected with 401 before authorization (F6).

## 5. Persistence, capture, and retention

### 5.1 Data model (WHAT must be durable)

One table, one committed migration (ADR-0011), `snake_case`, UUIDv7 PK (ADR-0001):

| Column | Notes |
| --- | --- |
| `id` | PK, UUIDv7. |
| `request_id` | NOT NULL; the `req_…` value assigned at ingress; indexed for operational lookup. |
| `project_id` | Nullable FK → `projects.id`, `ON DELETE CASCADE`. |
| `organization_id` | Nullable FK → `organizations.id`, `ON DELETE CASCADE`. |
| `user_id` | Nullable FK → `users.id`. |
| `api_key_id` | Nullable FK → `api_keys.id` (keys are soft-revoked and only hard-removed with their project, so no orphaning occurs). |
| `environment` | Nullable `test`/`live` (D1), app-validated. |
| `method` | App-validated member of the contract enum. |
| `path` | Bounded length (aligned with existing URL bounds); **without** query string (D6). |
| `status_code` | Integer HTTP status of the response. |
| `duration_ms` | Nullable integer — ingress to response completion. |
| `created_at` | UTC. |

- Indexes serve the project-scoped cursor scan and the D1/D8 filters — e.g.
  `(project_id, id)` and support for the environment/request-id predicates — and the
  retention cutoff (UUIDv7 `id` or `created_at`, whichever the cleanup uses).
- **Tenant lifecycle:** deleting a project or an organization removes its request-log rows;
  no row may reference a deleted tenant. Records with all-null tenant scope (public/auth
  traffic) are retained until retention expiry only.
- The record is written from the field allowlist of §4.2 rule 4; the table has no column
  capable of holding a body, header, or secret — absence is the control.

### 5.2 Write path (D3)

- The record is assembled and written **after the response has been produced**, from context
  the guards already resolved (session user/membership/project, API-key context, validated
  environment, response status, monotonic timing).
- The write is **best-effort**: any failure is logged (with the request ID, without payload)
  and swallowed. It never re-enters the response path, never retries inline, and never
  affects readiness.
- No queue is required for this data: request logs are observability records whose loss on a
  failed write is acceptable, unlike webhook events (phase 10 D2) which drive delivery. If a
  queue is ever used, that is a later architectural decision, not an MVP requirement.

### 5.3 Exclusions (D7)

- **Persisted:** every request whose path starts with the global API prefix (`/api/v1/`),
  whatever its outcome — including 400/401/403/404/429/5xx and unauthenticated traffic.
- **Not persisted:** everything outside the API prefix — health probes
  (`/health/live`, `/health/ready`, already ignored by stdout auto-logging), the Swagger UI
  surface (`swaggerPath`, default `docs`) and its asset traffic, CORS preflight `OPTIONS`,
  and any other non-API path.
- **Stdout logging is unaffected:** the Phase 2 pino channel remains process-wide (it is the
  Phase 20 shipping source); persistence is narrower by design. The two channels share the
  request ID so they can be correlated.

### 5.4 Retention and cleanup (D5)

- Configurable retention, **default 30 days** (aligned with webhook event retention, phase 10
  D9), loaded through the existing configuration pattern (`configuration.ts`).
- A periodic cleanup job removes expired rows efficiently; after expiry a record is simply
  gone (there is no retrieve-by-id operation, so no 404 surface to define).
- Retention must be documented for developers in Phase 15 alongside the request-ID guidance.

## 6. Data and event requirements summary

- **One new table** via one committed migration; no changes to any domain table.
- **Contract refinements in place** (ADR-0012): operation description (environment semantics,
  ordering, session-only authority, retention), additive nullable `environment` on
  `RequestLog`, optional `request_id` query parameter (D8). Nothing breaking; no version bump.
- **Capability registry:** one added capability (`logs.read`) with the D2 matrix.
- **Configuration:** a `requestLogging` section (retention; no endpoint thresholds) following
  the existing env-driven pattern.
- No events are emitted by this capability; request logging is not part of the webhook event
  catalog and must not be (phase 10 §4.2 keeps the catalog closed).

## 7. Web application

Replace the placeholder at `/dashboard/projects/[projectId]/logs/requests` with an
API-backed, read-only viewer using the existing project shell:

- **List:** cursor-paginated records for the addressed project showing timestamp, method,
  path, status code, duration, environment, actor (user vs. API key, from the nullable scope
  columns), and the request ID (selectable/copyable for issue reporting, per
  `docs/api-conventions.md` §7).
- **Filters:** the environment control (D1 semantics — when set, environment-less records are
  not shown) and an exact request-ID lookup (D8) that resolves to a single
  record or an explicit empty state.
- **States:** empty, loading, and error states handled; pagination follows the cursor
  contract; no client-side accumulation of the full log.
- **Authority:** the page renders only for holders of `logs.read`; the **API** remains the
  authority — the UI must not fetch without a session, must not cross projects via direct
  URLs or stale state, must not display data the API would refuse (404/403 surfaced as the
  appropriate empty/error state), and must never attempt to write or delete logs (no such
  operation exists).
- The audit-log placeholder (`…/logs/audit`) remains untouched — Phase 12.

## 8. Security requirements

- **No secret material at rest, ever.** Records are an allowlist projection (§4.2 rule 4):
  no bodies, no headers, no query strings, no `Authorization`/`Cookie` values, no
  `Idempotency-Key` (phase 8 §6.6), no API-key plaintext (ADR-0006), no webhook secrets
  (phase 10 D8), no passwords. Regression tests must prove this for sensitive flows
  (login, key creation, payment creation with an idempotency key, endpoint creation).
- **Session-only authority.** API keys cannot read request logs (401); the route never
  accepts `sk_…` credentials.
- **Capability before disclosure:** `logs.read` is evaluated before any record is read or
  returned.
- **Tenant isolation / IDOR:** rows are returned only for the addressed project; membership
  and capability are verified with the established 404 (unknown/non-member project) and 403
  (missing capability) non-disclosure semantics; opaque IDs are never treated as a control.
  Cross-project records are unreachable by cursor manipulation (cursors are constrained to
  the authorized project's rows).
- **Tenant cascade:** project/organization deletion removes rows; no orphaned tenant data
  remains queryable.
- **Secure logging of the capability itself:** write failures log the request ID and the
  error class only — never the record payload, never headers.
- **Server-assigned request IDs:** inbound `X-Request-Id` is ignored; clients cannot poison
  correlation or collide records.
- **Input validation:** `environment` (enum), `request_id` (scheme/format), `limit` (1–100),
  `cursor` (opaque, server-derived) at the boundary; parameterized queries only (Prisma).
- **Rate limiting** of the logs route is Phase 13 (429 declared); no ad hoc limits here.
- An explicit **security review** of redaction completeness, tenant isolation, and
  session-only enforcement is required before sign-off (AGENTS.md).

## 9. Acceptance criteria

1. All four Phase 11 roadmap checkboxes (request-ID propagation, structured JSON logging,
   API request/response logs, dashboard viewer) are implemented and traced to §2, and
   `docs/openapi.yaml` reflects the confirmed behavior and lints clean.
2. Every request under `/api/v1` produces exactly one `request_logs` row carrying the
   server-assigned `request_id`, method, path (no query string), status code, duration, and
   timestamp; health probes, Swagger UI traffic, and CORS preflights produce none.
3. The stored `request_id` equals the `X-Request-Id` header of that response and the
   `error.request_id` of an error response; the same ID appears in that request's stdout log
   lines and in any webhook-delivery rows it caused.
4. Scope columns follow the §4.2 rule 5 table in both auth modes, including partial scope on
   403/404 and null scope on 401; API-key requests record `api_key_id` and the key's
   environment.
5. A forced persistence failure (log store unavailable) never changes the response status,
   body, or header of the originating request, is logged as an error, and does not affect
   readiness.
6. No persisted record or log line from the sensitive flows listed in §8 contains a secret,
   body, header, or query string — asserted by tests.
7. `GET /projects/{project_id}/logs/requests`: API-key bearer → 401; missing/invalid session →
   401; unknown/foreign project → 404; member without `logs.read` → 403; members/viewers →
   200 under the confirmed matrix.
8. Pagination returns stable, non-overlapping ascending pages (default 20, max 100);
   malformed `limit`/`cursor` and undeclared parameters → 400; an invalid `environment` or
   `request_id` value → 400 field error.
9. D1 semantics hold: an absent environment returns records of both environments plus
   environment-less records; a present environment returns only matching records; a filter
   never returns another project's rows.
10. D8: an exact `request_id` lookup within the project returns that single
    record or an empty page, never 404, and cannot address another project's record.
11. Rows older than the configured retention are removed by the cleanup job; deleting a
    project or organization removes its rows and leaves no orphans.
12. Structured stdout logging still satisfies the Phase 2 contract (JSON, request IDs,
    status/duration, redaction) — verified by regression tests, with no behavior change
    required beyond fixing gaps if found.
13. The dashboard viewer replaces the placeholder: paginated project-scoped list, environment
    and request-ID filtering per the confirmed decisions, copyable request ID, empty/loading/
    error states, read-only for every role holding `logs.read`, and direct-URL isolation
    (another project's ID yields the API's 404, rendered without leaking data).
14. Repository checks required by AGENTS.md pass: lint, typecheck, unit tests, relevant
    integration/e2e tests, build — plus OpenAPI validation in CI.

## 10. Testing requirements

- **Unit**
  - record assembly from each auth/failure context (the §4.2 rule 5 table, row by row);
  - path sanitization (query string stripped, bounded length) and method/status/duration
    capture;
  - exclusion rule (API prefix vs. health/swagger/preflight);
  - `environment` capture rules (key-derived vs. validated session value vs. null);
  - capability matrix (`logs.read`), session-only guard behavior (API-key token → 401);
  - cursor construction/decoding under D4 ordering, filter + cursor stability;
  - retention cutoff calculation; redaction/allowlist invariants (a payload-shaped object can
    never widen the stored fields).
- **Integration (real PostgreSQL)**
  - migration, columns, nullability, FKs, indexes, and cascade deletes (project and
    organization);
  - end-to-end capture for representative routes in both modes: 201 create, 200 list,
    400 validation, 401 unauthenticated/unknown project, 403 missing capability, 404
    foreign project, and an unauthenticated public request (null scope);
  - stored `request_id` ↔ response header ↔ error envelope correlation on a failing request;
  - persistence failure injection (log write throws) → response unaffected, error logged;
  - list endpoint: pagination boundaries, both filters, isolation (project A's rows never
    appear for project B, cursor included), retention cleanup.
- **E2E (API)**
  - full status table of §4.3 under session auth; API-key bearer rejected with 401; 404/403
    non-disclosure; limit/cursor edges; undeclared-parameter 400.
  - **Secret-leak regression:** perform login, API-key creation, idempotent payment creation,
    and webhook-endpoint creation; assert no persisted request-log row and no stdout line
    contains the password, key plaintext, `Idempotency-Key`, or signing secret.
- **Web**
  - viewer renders the confirmed columns; pagination; environment/request-ID filters and
    their empty states; copyable request ID; read-only rendering; direct-URL project
    isolation; loading/error states.
- Tests run deterministically with no real credentials and no secret logging; repository
  checks and OpenAPI lint must pass (AGENTS.md).

## 11. Out of scope

- **Audit logs** (Phase 12): security/business events, the org-scoped
  `/organizations/{organization_id}/logs/audit` surface, and its viewer.
- **Any endpoint for non-project records** — auth, organization, and public request records
  are stored (API-wide, phase 1 §8) but deliberately unexposed in v1; adding a surface would
  be a contract change.
- **Rate limiting** of the logs route (Phase 13); metrics, dashboards, log shipping, and
  alerting (Phase 20).
- **Persisting request/response bodies or headers** in any form, including redacted bodies —
  not in this phase and not in any later phase without an explicit architectural decision.
- **Trusting or echoing client-supplied request IDs.**
- **Live tail / streaming / WebSocket log views, export (CSV/JSON), full-text search,
  free-text filtering, and sorting controls** beyond the confirmed filters and cursor order.
- **New list filters** beyond `environment` and the D8 `request_id` (e.g. `method`,
  `status_code`, date ranges) — contract additions needing their own decision.
- **Background-job/worker logging** (the webhook worker performs no HTTP requests); worker
  observability is Phase 20.
- **Changes to stdout logging behavior** beyond fixing gaps against the Phase 2 contract, and
  any change to payment/refund/webhook/idempotency domain rules.
- SDKs, CLI tooling, and public developer documentation pages (Phase 15 covers documentation;
  this phase only supplies the retention/propagation facts it needs).

## 12. Decisions (D1–D8 — all confirmed 2026-10-01)

Every decision below was put to the product authority and **confirmed as recommended**. They are
now binding requirements of this phase, not proposals. The alternative column is retained to record
what was rejected and why, so the reasoning survives future change requests.

| # | Decision | Confirmed position | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Environment on records and in the list filter | Persist a nullable `environment` (API-key requests: always from the key; session requests: when the request carried a validated environment). The contract's `environment` parameter is an **optional equality filter**; absent → all records; invalid → 400. No required-in-session 400-rule (the contract states none for this operation — F1). | Apply the Phase 7 D1 rule (required under session auth, 400 when missing): rejected because the contract never states it here, and because environment-less records (project retrieve/update, api-keys list, the logs list itself) would be unfilterable — no environment value ever matches them. Ignoring the parameter outright: rejected as misleading dead surface. |
| D2 | `logs.read` capability matrix | All four roles read request logs (metadata-only content; consistent with every project read surface of Phases 5–10). API keys are rejected before capability evaluation (session-only route). | Owner/admin only (the `invitations.read` precedent): rejected because logs contain no secrets or bodies and are a routine debugging surface for all team roles; deferring the matrix decision: rejected — the guard cannot be wired without a capability. |
| D3 | Persistence write path | Best-effort write **after** the response; failure logged and dropped; never delays/modifies/fails a request; no queue. | Synchronous pre-response insert: rejected — couples latency and availability of every request to the log store. BullMQ queue: rejected — adds Redis coupling and delivery machinery for data whose loss is explicitly acceptable (contrast phase 10 D2, where events drive delivery). |
| D4 | List ordering | Ascending by UUIDv7 via the shared cursor helper — consistent with every existing list and the Phase 10 events/deliveries decision. | Newest-first: better for tailing recent traffic, but diverges from all other lists, needs a cursor-helper variant, and was already rejected for the Phase 10 log-like surfaces; retained as the alternative if product prioritizes viewer UX over consistency. |
| D5 | Retention | Configurable, default **30 days**, periodic cleanup job; documented in Phase 15 (aligned with webhook-event retention, phase 10 D9). | Retain forever: rejected — one row per request grows without bound. No cleanup at all: rejected — makes the table an operational liability. A shorter default (7 days): viable amendment, nothing downstream depends on 30. |
| D6 | Recorded content | Explicit field allowlist (§4.2 rule 4); `path` **without** query string; bounded path length; nothing capable of holding secrets is stored. | Path including query string: rejected — query values (e.g. `search` free text) are user-supplied, the redaction set does not cover query parameters, and debug value is low. Storing redacted bodies/headers: rejected outright (§8). |
| D7 | Persisted surface | Every request under the `/api/v1` prefix, whatever its outcome; nothing outside it (health, Swagger UI, CORS preflight). Stdout logging stays process-wide. | Persist everything the process serves: rejected — orchestrator health probes and browser asset traffic drown the store. A configurable path denylist: rejected — premature configurability for a fixed topology. |
| D8 | Lookup by request ID | Add optional exact `request_id` filter on `logs.listRequestLogs` (additive, backward-compatible; mirrors the Phase 10 D15 precedent) so the conventions' "reference a request ID when reporting issues" flow works from the dashboard. | Keep the contract exactly as written (no filter): rejected — without it, finding one request requires paging through the whole window. A general free-text search: rejected — out of scope and unbounded. |

## 13. Architectural decisions to record

To be authored in `.ai/decisions/` during implementation, continuing the existing series:

- **Request-log persistence model**: post-response best-effort write, loss semantics,
  metadata allowlist, prefix-scoped capture, retention (D3, D6, D7, D5).
- **Request logs as observability, not domain data**: API-wide entity with a
  project-scoped-only v1 surface, session-only authority, no events, no bodies (F5, D1).

## 14. Implementation considerations (not new requirements)

- Reuse the Phase 5 session-only project-route pattern (`SessionAuthGuard` +
  `ProjectRbacGuard` + `@RequireCapability`) rather than the dual-mode
  `ProjectAccessGuard`; there is no API-key mode on this route by design (F6).
- Capture context already exists on the request (`request.authUser`, `request.project`,
  `request.organizationMembership`, `request.apiKey`); avoid re-querying the database for
  scope resolution, and never read headers/bodies to build a record.
- Hook the write after response completion (the same lifecycle seam pino uses for its
  response log), keeping it outside the request/response path (D3).
- Extend `configuration.ts` with a small `requestLogging` section (retention, optional
  cleanup interval) following the existing env-driven pattern.
- Schedule cleanup alongside the existing periodic maintenance introduced in Phase 10 rather
  than creating a new job runner; do not couple API readiness to cleanup health.
- Add the capability and matrix row in `organizations/roles.ts` (single source of truth);
  derive nothing from string literals in the controller.
- Refine `docs/openapi.yaml` in place and keep it the single source of truth (ADR-0012); the
  dashboard consumes only this contract — no web-only endpoints.
- Keep the viewer a pure API client (phase 1 §11.4): no business logic, no client-side
  policy, no persistence of log data beyond the current view.
- Do not modify application source as part of specification work.

## 15. Definition of done

The phase is complete only when:

1. Decisions D1–D8 have been confirmed (or formally amended) by the product authority, and
   the implementation matches the confirmed specification.
2. All acceptance criteria in §9 are satisfied and traced to the roadmap checkboxes.
3. Tests pass: unit, integration (real PostgreSQL), e2e API, and web viewer tests of §10 —
   including the secret-leak regression and the persistence-failure guarantee.
4. Repository-required checks pass: lint, typecheck, unit tests, relevant integration/e2e
   tests, build, and OpenAPI validation.
5. The security requirements of §8 have been explicitly reviewed (redaction completeness,
   tenant isolation, session-only authority, cursor non-disclosure), with no known critical
   issue remaining.
6. `docs/openapi.yaml` reflects the confirmed behavior and lints clean; the phase's
   architectural decisions are recorded in `.ai/decisions/`; retention and request-ID
   propagation facts needed by Phase 15 documentation are handed over.
