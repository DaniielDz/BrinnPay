# Phase 12 — Audit Logs

| | |
| --- | --- |
| Phase | 12 — Audit Logs |
| Status | **Approved — D1–D13 confirmed by the product authority on 2026-10-02 exactly as proposed (D2 accepted: `api_key.*` and `customer.*` extensions included; D3 = all four roles via `logs.read`). This specification is ready for implementation.** |
| Depends on | Phase 2 (migration workflow, validation, structured logging), Phase 3 (auth flows are audit subjects; auth rate limiting bounds failed-login volume), Phase 4 (`OrgRbacGuard`, capability registry, cursor helper, 404/403 semantics, D9 deletion obligation), Phase 5 (API keys, session-only project routes, deferred key-event auditing), Phase 6 (customer CRUD), Phase 7 (payment state machine and its Phase 12 coordination obligation), Phase 8 (idempotency replay semantics), Phase 9 (refund lifecycle), Phase 10 (in-transaction event-port pattern, worker topology — blocks this phase), Phase 11 (`logs.read` capability, viewer and cursor patterns — blocks this phase), Phase 1 (contract, domain model, append-only rule) |
| Blocks | Phase 14 (the dashboard audit-viewer item is delivered here), Phase 15 (action catalog and lifecycle facts must be handed over for documentation), Phase 17 (testing), Phase 18 (security hardening — immutability and tenant-isolation review), Phase 20 (observability) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 12 |

## 1. Objective

Provide an **immutable, organization-scoped audit trail** that answers *who did what, to which resource, when* for security-relevant and business-relevant events:

1. **Security event logging (auth, access)** — authentication outcomes and access-control
   changes (Phase 3 coordination obligation: "Phase 12 records auth security events").
2. **Business event logging (payments, refunds)** — the payment lifecycle (Phase 7
   obligation: "record payment lifecycle transitions in audit logs") and refunds.
3. **Audit log API** — the already-contracted `GET /organizations/{organization_id}/logs/audit`
   (`logs.listAuditLogs`, SessionAuth) with cursor pagination.
4. **Dashboard audit-log viewer** — replace the placeholder at
   `/dashboard/projects/[projectId]/logs/audit`.

The audit trail is deliberately **distinct** from the two existing observability channels:

| Channel | Scope | Granularity | Purpose |
| --- | --- | --- | --- |
| Stdout structured logs (Phase 2) | Process-wide | Per log line | Operational observability |
| `request_logs` (Phase 11) | API-wide | Per HTTP request | Request tracing/debugging |
| `audit_log_entries` (Phase 12) | Per organization | Per catalog action | Security/business accountability |

Audit entries are **not** webhook events: they are never queued, signed, delivered, or
replayed, and the Phase 10 webhook event catalog stays closed. Both environments remain
simulated and no real money is processed.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| Security event logging (auth, access) | §5.2, §5.3 (catalog), §4.2 (record rules) |
| Business event logging (payments, refunds) | §5.4 (catalog), §6.2 (write path) |
| Audit log API | §4.3 (behavior/authorization), §6.1 (data model) |
| Audit log viewer in the dashboard | §8 |

## 2. Scope

In scope:

- A cross-cutting **`audit-logging`** capability module in `apps/api`
  (`docs/domain-model.md` §3 names it explicitly as an application-level, not domain, module).
- One committed Prisma migration adding the audit-entry table (ADR-0011: the owning phase
  adds its schema).
- The **action catalog** (§5) and the recording rules that govern every entry.
- The contracted `logs.listAuditLogs` operation: session-only authorization, capability
  enforcement, cursor pagination (D3, D10).
- Contractual refinements of `docs/openapi.yaml` in place (ADR-0012): operation
  semantics, the documented action catalog, and the additive D6 fields. No new API version.
- The dashboard audit viewer replacing the existing placeholder (D12).
- Discharge of the coordination obligations recorded by Phases 3, 4, 5, 6, 7 and 8 (§7).

Explicitly **not** extended here: payment/refund/webhook/customer domain rules, the webhook
event catalog, rate limiting, metrics, retention cleanup (D9), and any endpoint beyond the
contracted one.

## 3. Context and current-state findings

**What exists today**

- `docs/openapi.yaml` already declares `logs.listAuditLogs` (SessionAuth **only**, parameters
  `OrganizationId`, `Limit`, `Cursor`), the `AuditLogEntry` schema (required: `id`,
  `organization_id`, `actor_type`, `action`, `resource_type`, `created_at`; nullable
  `actor_id`, `resource_id`; optional `data`) and `AuditLogEntryList`. Tag `logs` covers
  Phases 11–12. The operation description is a single sentence — ordering, capability,
  scope, and semantics are undocumented.
- `docs/domain-model.md` §1/§2/§5: `Organization 1 ── * AuditLogEntry`, entity
  "Immutable security/business event record — Phase 12", API traceability row for
  `GET /organizations/{organization_id}/logs/audit`.
- `docs/api-conventions.md` §3: `logs/*` is **session-only**; §9: "Audit logs: append-only;
  entries are never updated or deleted" (same rule in phase 1 §8).
- `apps/api/prisma/schema.prisma` has **no** audit model and no migration provides one.
- `organizations/roles.ts` has `logs.read` (Phase 11, all four roles) but no audit-specific
  capability; every org route must declare a capability, so the route cannot be wired
  without a decision (D3).
- The Phase 4 org-route precedent is `SessionAuthGuard + OrgRbacGuard` +
  `@RequireCapability` (the `RBAC()` decorator factory in `organizations.controller.ts`),
  with non-member → **404** and member-without-capability → **403** semantics (Phase 4 D1).
- The cross-cutting write precedent is Phase 10's `WebhookEventPort`: the emitter owns the
  UUIDv7 id and persists inside its own transaction (`INSERT … ON CONFLICT DO NOTHING`).
  The Phase 11 `request-logging` module is the precedent for a cross-cutting capability
  with its own read controller and viewer.
- Actor/environment sources already exist on the request context (`authUser`,
  `organizationMembership`, `apiKey`) and in the domain rows (payment creator, project →
  organization mapping), so scope resolution needs no new queries beyond the auth fan-out
  (D4).
- Auth endpoints are already rate-limited (Phase 3 `AuthRateLimitGuard`), which bounds the
  row volume a failed-login flood can produce.
- The dashboard page at `/dashboard/projects/[projectId]/logs/audit` is a placeholder whose
  text says "Audit logging arrives in Phase 12" (Phase 11 left it untouched by design).
- `forbidNonWhitelisted` validation rejects undeclared query parameters (400).

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | No audit persistence or module exists; the contract and domain model only reference it. | §6 — one table, one migration, one capability module (ADR-0011). |
| F2 | The contract's operation description documents none of: ordering, capability, scope across projects, or the action vocabulary — while `action` is an open `string`. | §4.3, §5.1, D1 — refine the description in place and document the catalog there; keep `action` a string so catalog growth is non-breaking. |
| F3 | `AuditLogEntry` has no `project_id`/`environment`, yet every business event is project- and environment-scoped and the read surface is organization-wide (an org with two projects and TEST/LIVE data would show unattributable rows). | D6 — add nullable, additive `project_id` and `environment` properties (Phase 11 D1 precedent); rejected alternative is hiding them in free-form `data`. |
| F4 | No capability exists for reading audit logs; every guarded route must declare one, and the four roles split naturally between "all roles" (Phase 11 precedent) and "owner/admin only" (`invitations.read` precedent). | D3 — reuse `logs.read` for all four roles; alternative recorded. |
| F5 | The contracted surface is **organization**-scoped, but the dashboard route and nav link are **project**-scoped (`…/projects/[projectId]/logs/audit`). | D12 — keep the existing route (phase 1 §11.3 lists it), resolve `project → organization_id` in the viewer, and label the view as organization-wide; relocating it is a Phase 14 alternative. |
| F6 | The contract requires `organization_id NOT NULL`, but authentication events (register/login/login-failure/logout) happen before any tenant context exists — and a user may belong to several organizations. | D4 — membership fan-out: one entry per organization the user is a member of at event time; zero memberships → zero entries. |
| F7 | Failed login for an **unknown email** has neither a user nor an organization to attach, and the contract has no platform/global scope. | D4 — record no entry (the attempt is still bounded by Phase 3 auth rate limits and visible in request/stdout logs); alternatives recorded as rejected. |
| F8 | `actor_type` is the fixed enum `[user, api_key]`, but `payment.succeeded`/`payment.failed` are applied by the worker sweep or read-time catch-up with no live actor. | D5 — attribute background transitions to the payment's original creator (stable across all triggers); adding a `system` enum value is rejected. |
| F9 | Phase 1 says audit entries are "never updated or deleted", but Phase 4 D9 and Phase 5 recorded obligations requiring organization deletion to interact with audit rows, and FK `SET NULL` actions would rewrite rows. | D8/D9 — no application update path plus a DB-level UPDATE block; `organization_id` is the only FK (`ON DELETE CASCADE`); actor/resource/project ids are stored as plain values with **no FK** so no action ever rewrites a row; no retention cleanup. |
| F10 | Idempotent replays (Phase 8) re-serve a committed response; a naive hook would double-record. | §4.2 rule 6 — replay/rollback write no entry; the entry shares the original transaction. |
| F11 | Ordering and filters are unspecified in the contract (same gap Phase 11 resolved with D4/D8). | D10/D11 — ascending by UUIDv7 via the shared cursor helper; no new filters in v1. |
| F12 | The roadmap enumerates "(payments, refunds)" for business events, while prior phases recorded anticipations for **key events** (Phase 5) and **customer operations** (Phase 6). | D2 — catalog extensions confirmed (2026-10-02), explicitly flagged as beyond the roadmap's literal wording. |

## 4. API application — `apps/api`

### 4.1 Module purpose and boundaries

A cross-cutting `audit-logging` capability owns three responsibilities:

1. **Capture** — resolving organization/actor/resource scope and assembling the entry from
   the per-action allowlist (§5).
2. **Persistence** — writing `audit_log_entries` rows atomically with the audited change
   (§6.2).
3. **Read surface** — the contracted `logs.listAuditLogs` operation (§4.3).

Boundaries (`docs/domain-model.md` §3/§4): domain modules (`auth`, `organizations`,
`payments`, `refunds`, `api-keys`, `customers`) **trigger** audit capture through an
injectable application-level port/service — they never build rows by hand, never reach
into the audit table directly, and never decide catalog membership. The capability reads
only context the guards and the domain rows already resolve. Request logging (Phase 11),
stdout logging (Phase 2), and webhook events (Phase 10) are separate concerns that this
module does not touch.

### 4.2 Record rules (domain rules)

1. **Event-driven, not request-driven.** An entry is written **only** when a §5 catalog
   action commits. Ordinary requests — GETs, list calls, validation failures (400),
   unauthenticated traffic (401), not-found (404), rate-limited (429) — produce no audit
   entry. In particular, the audit list request itself produces a request-log row (Phase 11)
   but **no** audit row.
2. **Exactly one entry per committed action instance**, except the D4 auth fan-out (one
   entry per organization the acting user is a member of at that moment, typically one).
   Entries carry emitter-owned UUIDv7 ids (ADR-0001), so a retried write inside the same
   transaction is a no-op rather than a duplicate (Phase 10 §4.3.5 idempotence pattern).
3. **Organization scope is mandatory and singular** (the contract requires
   `organization_id`). Resolution order: the addressed organization (access-control events)
   → the resource's project's organization (business events) → the acting user's
   memberships (auth events, D4). No platform-global or null-organization row may ever be
   written; the contract cannot represent one and this phase does not extend it.
4. **Actor is always representable.** Session-driven actions → `actor_type: user` with the
   session user's id; API-key-driven actions → `actor_type: api_key` with the key's id
   (never the plaintext, ADR-0006/ADR-0014); background transitions → the payment's
   original creator (D5). `actor_id` is a UUID value or null; it is never a secret.
5. **Action and resource come from the closed catalog (§5).** `action` uses the
   `<resource>.<past-tense-verb>` style of phase 1 §9.4 (naming only — the catalog is
   independent of the webhook catalog). Every MVP action carries a `resource_type` and a
   `resource_id`; the contract's nullability exists for future actions and is unused here.
   New action values may be added only by amending §5 — never ad hoc from a controller.
6. **Idempotency and failure (Phase 8).** A replayed response writes **no** entry (the
   original committed success already wrote one); a rolled-back or rejected operation
   writes no entry; an entry and its audited change commit or roll back together (§6.2).
7. **`data` is an explicit per-action allowlist (D13)** — bounded scalars only
   (ids, enum/role/status values, monetary amounts per ADR-0002, the optional
   `request_id` correlation key). It **never** contains: passwords, API-key plaintext,
   tokens/session material, webhook secrets, `Idempotency-Key` values, headers, request or
   response bodies, emails, free-text user input (e.g. refund `reason`), IP addresses, or
   user agents. Entries are built from the allowlist, never by redacting a larger payload;
   `data` is omitted entirely when empty.
8. **Correlation.** For request-driven actions the entry's `data.request_id` carries the
   server-assigned request id of the triggering request (phase 1 §7.7), linking the entry
   to the Phase 11 request-log row and the `X-Request-Id` of that response. Background
   actions (D5) carry no `request_id`.
9. **Immutability.** Entries are never updated after creation; deletion happens only
   through tenant cascade (D9). There is no update or delete operation in the API, no
   application code path that issues one, and the database rejects `UPDATE` outright (D8).
10. **Not events.** Entries are never enqueued, signed, delivered, retried, replayed, or
    emitted through the Phase 10 seam; the webhook event catalog stays exactly as closed as
    phase 1 §9.1 requires.

### 4.3 API behavior and authorization

`GET /organizations/{organization_id}/logs/audit` — **session-only**, following the Phase 4
org-route pattern: `SessionAuthGuard + OrgRbacGuard` + `@RequireCapability` with the
capability chosen by D3. API-key mode does not exist on this route (`docs/api-conventions.md`
§3: `logs/*` is session-only), so an `sk_…` bearer is rejected before authorization.

| Aspect | Behavior | Result |
| --- | --- | --- |
| Authorization | Missing/invalid/expired session or an `sk_…` bearer → 401; malformed or foreign `organization_id` (existence never disclosed) → 404; member without the audit-read capability → 403 (under the confirmed D3 matrix this branch is unreachable through legitimate roles and is proven at guard-unit level; under the owner/admin alternative it is exercised by member/viewer e2e). | As stated. |
| Query parameters | `organization_id` (path), `limit` (default 20, max 100), `cursor` (opaque). Undeclared parameters are rejected by the global validation pipe. | 200 / 400 / 401 / 403 / 404 / 429. |
| Ordering | Ascending by UUIDv7 (D10) via the shared cursor helper — consistent with every existing list (Phases 6/7/10/11). | 200. |
| Pagination | Cursor-based `{ data, next_cursor, has_more }`, stable and non-overlapping; cursors are constrained to the addressed organization's rows. | 200; 400 malformed cursor/limit. |
| Filters | None beyond pagination (D11). | — |
| Response body | The contracted `AuditLogEntryList` projection only — the fields of §6.1 (plus the confirmed D6 properties). No internal column, no secret, no free text beyond allowlisted scalars. | 200. |
| Idempotency / rate limiting | GET — no `Idempotency-Key`. Rate limits are Phase 13's; this phase adds none (429 stays declared). | — |
| Contract | Refine `docs/openapi.yaml` in place (ADR-0012): document session-only authority, the D3 capability, organization-wide scope (covering all of the org's projects and both environments), ascending ordering, append-only lifecycle, and the §5 action vocabulary on the `action` property; add the confirmed D6 properties. Lint must stay clean; no new API version. | — |

Errors use the canonical envelope only: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404), `RATE_LIMITED` (429, Phase 13). No new error code.

### 4.4 Authorization model (D3)

Extend/consult the Phase 4 capability registry (single source of truth:
`organizations/roles.ts`). Confirmed position (D3) — reuse the existing capability:

| Capability | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| `logs.read` (request logs **and** audit logs of scope) | ✓ | ✓ | ✓ | ✓ |

Rationale: entries contain no secrets and no free text by construction (§4.2 rule 7), the
`logs` tag already unifies both surfaces (Phase 11 header: "same `logs` surface, capability
and viewer patterns"), and every read surface of Phases 5–11 is open to all roles. The
rejected alternative — a new `logs.audit.read` limited to owner/admin (the
`invitations.read` precedent, because audit is a security surface) — is recorded in D3 and
remains available if product prefers admin-only visibility.

## 5. Audit action catalog

### 5.1 Conventions

- Naming: `<resource>.<past-tense-verb>` (phase 1 §9.4 style). The audit catalog is
  **independent** of the webhook event catalog — a shared name (e.g. `payment.succeeded`)
  denotes the same business milestone observed by two different systems; neither drives
  the other.
- The catalog is closed for implementation: only the values below may be written. Growing
  it requires amending this specification (and the OpenAPI description), which is a
  non-breaking contract change because `action` remains an open string (F2).
- `resource_type` values used by this catalog: `user`, `member`, `invitation`, `api_key`,
  `payment`, `refund`, plus `customer` (D2 confirmed).

### 5.2 Security events — authentication (D1)

Org scope for all four: **D4 membership fan-out**. Actor: the authenticating user.

| Action | Trigger | Resource | `data` allowlist |
| --- | --- | --- | --- |
| `user.registered` | Registration commits (user + default organization + membership, Phase 3/ADR-0010). Written inside the registration transaction. | `user` (id) | `request_id` |
| `user.logged_in` | Login succeeds (a refresh session is created). | `user` (id) | `request_id` |
| `user.login_failed` | Login is rejected **and** the presented email resolves to an existing account (wrong password). Unknown email → **no entry** (D4/F7). | `user` (id) | `request_id` |
| `user.logged_out` | Logout succeeds (a valid refresh session is revoked). Rejected logout (401) records nothing — there is no authenticated actor. | `user` (id) | `request_id` |

Deliberately excluded: token refresh (high frequency, no distinct security meaning in the
MVP), failed logout, and any attempt to record the presented email (D13).

### 5.3 Security events — access control (D1)

Org scope: the addressed organization (single entry, no fan-out). Actor: the session user
performing the change (self-removal/self-demotion records the member as their own actor).

| Action | Trigger | Resource | `data` allowlist |
| --- | --- | --- | --- |
| `invitation.created` | Invitation created (Phase 4 `invitations.create`). | `invitation` (id) | `role`, `request_id` |
| `invitation.canceled` | Invitation canceled (idempotent re-cancel records nothing — no state change). | `invitation` (id) | `role`, `request_id` |
| `member.joined` | Invitation accepted; membership created. | `member` (user id) | `role` (granted), `invitation_id`, `request_id` |
| `member.role_changed` | Member role updated (Phase 4 `members.update`). | `member` (user id) | `previous_role`, `new_role`, `request_id` |
| `member.removed` | Member removed by an admin or by self-removal (Phase 4 `members.remove`). | `member` (user id) | `role` (at removal), `request_id` |

Interpretation of "access" (D1): these are **access-control changes** — who holds which
role in the tenant. Per-request authorization denials (403/404) are deliberately **not**
mirrored into the audit trail; every such response is already persisted by Phase 11
request logs with actor and project scope, and duplicating them would double-write noise
without adding information.

### 5.4 Business events — payments and refunds (D1)

Org scope: the resource's project's organization. Actor: the creator of the resource —
the session user or the API key that created it; for background transitions the **original
creator** (D5).

| Action | Trigger | Resource | `data` allowlist |
| --- | --- | --- | --- |
| `payment.created` | Payment committed with status `pending` (Phase 7 catalog `payment.created`), in the same transaction as the webhook event. | `payment` (id) | `amount`, `currency`, `request_id` |
| `payment.succeeded` | `processing → succeeded` edge applied — by read-time catch-up or the worker sweep (Phase 10 D3), attributed per D5; no `request_id` when background. | `payment` (id) | `amount`, `currency`, `request_id` (only when request-driven) |
| `payment.failed` | `processing → failed` edge applied (same attribution rules). | `payment` (id) | `amount`, `currency`, `failure_code` (nullable; catalog arrives with Phase 16), `request_id` (when request-driven) |
| `refund.created` | Refund committed (Phase 9: synchronously `succeeded`), in the same transaction as `refund.created` webhook event. | `refund` (id) | `payment_id`, `amount`, `currency`, `request_id` |

Deliberately excluded: an entry for the intermediate `pending → processing` edge — Phase 7
D10 established there is no `payment.processing` event because the edge has no business
significance, and the audit trail follows that judgment (D1). Phase 9 D2 likewise forbids
inventing refund transitions: refunds are created succeeded, so `refund.created` is the
only refund action.

`amount`/`currency` follow ADR-0002/ADR-0003 (decimal string + lowercase code as in the
API projection). Environment and project attribution come from the D6 columns (or D6's
fallback placement in `data`).

### 5.5 Coordination extensions (D2 — beyond the roadmap's literal wording)

The roadmap parenthetical names only "(payments, refunds)" for business events, yet two
prior phases recorded explicit anticipations that this phase is expected to discharge.
These five actions were **confirmed as part of D2 (2026-10-02)** despite extending the
roadmap's literal scope:

| Action | Trigger | Resource | `data` allowlist |
| --- | --- | --- | --- |
| `api_key.created` | API key generated (Phase 5 — anti-goal deferred "audit logging of key events" to Phase 12). Session-only route, so actor is always a user. | `api_key` (id) | `request_id` (+ project/environment per D6) |
| `api_key.revoked` | API key revoked (soft-revoke, Phase 5). | `api_key` (id) | `request_id` (+ project/environment per D6) |
| `customer.created` | Customer committed (Phase 6 anticipated "customer operations will appear in request and audit logs"). | `customer` (id) | `request_id` (+ project/environment per D6) |
| `customer.updated` | Customer updated. Changed field values are **not** echoed (D13). | `customer` (id) | `request_id` (+ project/environment per D6) |
| `customer.deleted` | Customer deleted. | `customer` (id) | `request_id` (+ project/environment per D6) |

Had D2 been rejected, the Phase 6 coordination note would have become stale and required
reconciliation, and Phase 5's key-event anticipation would have remained unfulfilled —
that cost was part of the D2 decision, which is now settled in favor of inclusion.

### 5.6 Recording rules (how scope and actors are resolved)

1. **Single-organization actions** (§5.3, §5.4, §5.5): exactly one entry for the resolved
   organization.
2. **Auth fan-out (D4)**: for §5.2 actions, write one entry per organization the acting
   user is a member of **at the time of the event** (a query of their memberships —
   typically one via ADR-0010, possibly several, possibly **zero** after the user deletes
   their last organization, which yields no entries rather than an invalid row).
3. **Actor resolution**: from the already-resolved request context (`authUser`,
   `apiKey`) — never re-derived from headers or bodies; background transitions use the
   payment row's creator (D5).
4. **Exactly-once**: the entry id is emitter-owned (UUIDv7) and the insert shares the
   audited change's transaction (§6.2); concurrent retries converge on one row.

## 6. Persistence, write path, and lifecycle

### 6.1 Data model (WHAT must be durable)

One table, one committed migration (ADR-0011), `snake_case`, UUIDv7 PK (ADR-0001):

| Column | Notes |
| --- | --- |
| `id` | PK, UUIDv7. |
| `organization_id` | NOT NULL FK → `organizations.id`, **`ON DELETE CASCADE`** (D9 — discharges the Phase 4 D9 and Phase 5 obligations). |
| `actor_type` | App-validated member of the contract enum (`user` / `api_key`). |
| `actor_id` | Nullable UUID **value with no FK** (D8) — historical attribution that survives actor deletion without ever rewriting the row. |
| `action` | App-validated member of the §5 catalog. |
| `resource_type` | App-validated member of the §5 vocabulary. |
| `resource_id` | Nullable UUID value, no FK (resources such as memberships are deleted while the trail must persist). |
| `project_id` | Nullable UUID value, no FK (D6 — present when the action is project-scoped). |
| `environment` | Nullable app-validated `test` / `live` (D6 — present for project-scoped actions). |
| `data` | Nullable `jsonb`; only the per-action allowlisted scalars of §5. |
| `created_at` | UTC. |

- Indexes: `(organization_id, id)` serves the contract's cursor scan; no retention-cutoff
  index exists because there is no cleanup (D9); filter indexes appear only if D11 is
  amended.
- **Exactly one FK exists** (`organization_id`, cascade delete). Because there is no
  `ON DELETE SET NULL` anywhere, the database never rewrites an entry — the immutability
  rule (phase 1 §8) and referential lifecycle are compatible by construction (F9).
- Tenant lifecycle: deleting an organization removes its audit entries; no row may
  outlive its tenant. Deleting a project, API key, user, or membership does **not** touch
  audit rows — ids remain as stable historical references (discharges Phase 5's
  "deletion interaction re-reviewed").
- The table has no column capable of holding a body, header, secret, email, or free text —
  absence is the control (Phase 11 D6 framing).

### 6.2 Write path (D7)

- **Committed state changes are audited atomically.** The audit insert participates in the
  same database transaction as the change:
  - `payments.create` — alongside the idempotency claim, the payment row, and the Phase 10
    webhook event (one transaction already exists);
  - payment terminal transitions — inside the existing compare-and-swap transaction of
    `applyEdge`;
  - `refunds.create` — inside the balance-invariant transaction;
  - registration, invitation and membership operations, API-key creation/revocation, and
    customer mutations — the change and its insert share one transaction.
  If the audit insert fails, the whole change rolls back: there is **no committed change
  without its audit entry** (fail-closed for mutations). This couples mutation availability
  to the same PostgreSQL database that already must be available for the change itself —
  no new infrastructure dependency.
- **Authentication outcome events are best-effort** (except `user.registered`, which is
  transactional): a failed write for `user.logged_in` / `user.login_failed` /
  `user.logged_out` is logged (action, organization id, error class — never payload) and
  dropped; it never alters the status, body, or headers of the auth operation and never
  affects readiness. A login must not fail because the audit store failed; fan-out inserts
  are independent, so a partial fan-out with logged failures is an accepted outcome.
- **No queue.** Audit writes are local database inserts in the flow that already owns the
  transaction; the BullMQ machinery (Phase 10) is for cross-process delivery and is not
  warranted here.

### 6.3 Immutability enforcement (D8)

Three layers, cheapest first:

1. No update or delete code path exists — the capability exposes capture and list only.
2. The table has no FK action that could rewrite a row (no `SET NULL`; §6.1).
3. The migration installs a database rule/trigger that **rejects `UPDATE`** on the table
   (defense in depth for "append-only", phase 1 §8). It must not interfere with the
   organization cascade `DELETE`, which remains the only deletion path.

### 6.4 Lifecycle and retention (D9)

- Entries live until their organization is deleted. There is **no** retention-based
  cleanup: phase 1 §8 states entries are never deleted, audit volume is orders of
  magnitude below Phase 11's row-per-request store, and a trail that silently expires
  contradicts the phase's purpose.
- Growth is accepted for the MVP sandbox; a configurable long-horizon retention (e.g.
  yearly) is recorded as the rejected alternative and can be added later by decision.
- Phase 15 must document the append-only lifecycle and org-cascade behavior.

## 7. Data and event requirements summary

- **One new table** via one committed migration; no domain table changes.
- **No new webhook events, no queue changes, no configuration section** (no retention, no
  thresholds) — this phase adds no environment-driven configuration.
- **Capability registry:** no change under the confirmed D3 (reuse `logs.read`);
  otherwise one capability row with an owner/admin matrix.
- **Contract refinements in place** (ADR-0012): operation description (authority,
  capability, org-wide scope, ordering, append-only), `action` property documentation of
  the §5 catalog, and the D6 additive properties. Nothing breaking; no version bump.
- **Coordination obligations discharged by this phase:**

  | From | Obligation | Discharged by |
  | --- | --- | --- |
  | Phase 3 | "Phase 12 records auth security events" | §5.2 |
  | Phase 4 D9 | "audit entries reference organizations; decide FK behavior with deletion" | D9 (`ON DELETE CASCADE`) |
  | Phase 5 | "audit entries reference organizations; deletion interaction re-reviewed" + deferred key-event auditing | D9 (plain-id columns), §5.5 |
  | Phase 6 | "customer operations will appear in request and audit logs" | §5.5 (subject to D2) |
  | Phase 7 | "record payment lifecycle transitions in audit logs. Open." | §5.4 |
  | Phase 8 | "audit logging behavior for idempotency operations" | §4.2 rule 6 (replay/rollback write nothing) |

## 8. Web application

Replace the placeholder at `/dashboard/projects/[projectId]/logs/audit` with an API-backed,
read-only viewer using the existing project shell (Phase 11 viewer pattern):

- **Scope resolution:** fetch the addressed project (`retrieveProject`, whose contract
  exposes `organization_id`), then call `GET /organizations/{organization_id}/logs/audit`.
  The heading/label must state that the view is **organization-wide** (all projects, both
  environments) — entries of sibling projects appearing under a project route is expected
  behavior under D12, not a leak.
- **List:** cursor-paginated entries showing timestamp, action, actor (type + id), resource
  (type + id), project/environment (D6), and `data` rendered as key/value pairs — including
  a selectable/copyable `request_id` for cross-reference into the Phase 11 request-log
  viewer (`docs/api-conventions.md` §7 issue-reporting flow).
- **Filters:** none (D11); ordering follows the cursor contract (ascending).
- **States:** empty, loading, and error states handled; no client-side accumulation of the
  full trail.
- **Authority:** the page renders only for holders of `logs.read`; the **API** remains the
  authority — no fetch without a session, no cross-organization access via direct URLs or
  stale state (a foreign project resolves to the API's 404, rendered without leaking data),
  and no attempt to write or delete entries (no such operation exists).
- The request-log viewer and every other page remain untouched.

## 9. Security requirements

- **No secret material at rest, ever.** Entries are an allowlist projection (§4.2 rule 7):
  regression tests must prove that no persisted entry contains a password, API-key
  plaintext, `Idempotency-Key`, webhook signing secret, session/refresh token, email,
  header, body, or free text — exercised over login (success and failure), API-key
  creation, payment creation with an idempotency key, refund creation, invitation
  creation, and customer mutation flows.
- **Session-only authority.** API keys cannot read audit logs (401); the route never
  accepts `sk_…` credentials.
- **Capability before disclosure.** The D3 capability is evaluated before any entry is
  read; under the confirmed matrix all roles qualify, under the alternative only
  owner/admin.
- **Tenant isolation / IDOR.** Entries are returned only for the addressed organization;
  membership and capability are verified with the established 404 (unknown/foreign org)
  and 403 (missing capability) non-disclosure semantics; opaque IDs are never treated as a
  control; cursors cannot escape the authorized organization's rows; an authenticated
  outsider can never cause entries to be written into a foreign organization (fan-out and
  resource-derived scope both resolve from verified context).
- **Immutability as a security control.** No API surface can alter or remove entries;
  the DB rejects `UPDATE`; the only deletion is tenant cascade, which is visible in the
  organization lifecycle rather than silently expiring evidence.
- **PII minimization (D13).** No emails (failed logins for unknown addresses record
  nothing at all), no IP addresses, no user agents, no free-text input anywhere in
  `data` — consistent with the Phase 11 D6 stance.
- **Secure logging of the capability itself.** Capture failures log the action, the
  organization id, and the error class — never the entry payload.
- **Input validation.** `limit` (1–100) and `cursor` (opaque, server-derived) at the
  boundary; undeclared query parameters rejected; catalog and enum values validated
  server-side; parameterized queries only (Prisma).
- **Bounded security-event volume.** Failed-login entries are bounded by the Phase 3
  auth rate limits; no audit-specific limit is added (Phase 13 owns rate limiting).
- An explicit **security review** (immutability, tenant isolation, allowlist completeness,
  session-only enforcement) is required before sign-off (AGENTS.md).

## 10. Acceptance criteria

1. All four Phase 12 roadmap checkboxes (security events, business events, audit API,
   dashboard viewer) are implemented and traced to §1/§2, and `docs/openapi.yaml` reflects
   the confirmed behavior and lints clean.
2. Each §5 catalog action produces exactly the entries its rules require: one per
   committed action for single-org actions; one per membership for auth fan-out (including
   zero when the user has no organization); none for unknown-email logins, rejected
   logouts, replays, rollbacks, plain GETs, or non-catalog responses.
3. Every entry carries a valid organization id from verified context, a representable
   actor per D5, `action`/`resource_type` from the catalog, `created_at`, and only
   allowlisted `data` — asserted per action by unit and integration tests.
4. Atomicity: forcing the audit insert to fail during `payments.create` (or any §5.4/§5.5
   mutation) rolls back the change — no payment/refund/key/customer/member row without its
   entry, and the caller receives the canonical error envelope; forcing it to fail during
   login leaves the login outcome unchanged, logs the failure, and never affects readiness.
5. Idempotency: replaying `payments.create`/`refunds.create` with a stored key produces no
   second entry; the original success produced exactly one.
6. Attribution: `payment.succeeded`/`payment.failed` applied by the worker sweep and by
   read-time catch-up both record the payment's original creator (session user or API key)
   with no `request_id`; request-driven transitions record `data.request_id` equal to the
   triggering request's `X-Request-Id`.
7. `GET /organizations/{organization_id}/logs/audit`: API-key bearer → 401; missing/invalid
   session → 401; unknown/foreign organization → 404; member without the capability → 403
   (or, under the confirmed all-roles matrix, the 403 path is proven at guard-unit level
   and members/viewers/admins/owners → 200); entries of another organization are never
   returned, cursor manipulation included.
8. Pagination returns stable, non-overlapping ascending pages (default 20, max 100);
   malformed `limit`/`cursor` and undeclared parameters → 400; the response is exactly the
   contracted projection.
9. Immutability: direct `UPDATE` of an audit row is rejected by the database; no API
   operation exists that would modify or delete an entry; deleting an organization removes
   its entries and leaves no orphans; deleting a project, key, user, or member leaves
   entries intact with stable ids.
10. No persisted entry from any flow listed in §9 contains a secret, email, IP, user
    agent, header, body, or free text — asserted by tests.
11. The dashboard viewer replaces the placeholder: project→org resolution, org-wide
    labeled list with the §8 columns, copyable `request_id`, cursor pagination, no filters,
    empty/loading/error states, read-only for every role holding `logs.read`, and
    direct-URL isolation (foreign project → API 404 rendered without data).
12. `docs/openapi.yaml` documents the confirmed semantics (authority, capability, scope,
    ordering, lifecycle, action catalog) and the confirmed D6 properties; lint passes.
13. The coordination obligations of §7 are all discharged (or the rejected D2 path
    records the required reconciliation).
14. Repository checks required by AGENTS.md pass: lint, typecheck, unit tests, relevant
    integration/e2e tests, build — plus OpenAPI validation in CI.

## 11. Testing requirements

- **Unit**
  - scope resolution per §5.6 (single-org, fan-out with 0/1/N memberships, resource-derived
    org for project-scoped actions);
  - actor resolution per auth mode and D5 (session, API key, background creator);
  - per-action `data` allowlist builders — a payload-shaped object can never widen the
    stored fields; `data` omitted when empty; `request_id` present only when
    request-driven;
  - catalog validation (an unknown action/resource value is rejected, not persisted);
  - capability matrix (D3) and session-only guard behavior (API-key token → 401);
  - cursor construction/decoding under D10 ordering;
  - idempotent entry-id emission (re-insert in the same transaction is a no-op).
- **Integration (real PostgreSQL)**
  - migration: columns, nullability, the single cascade FK, `(organization_id, id)` index;
    `UPDATE` on the table is rejected; organization delete cascades; project/key/user
    deletes leave rows intact;
  - end-to-end recording for representative flows: register, login success, known-user
    login failure, logout, invitation create/accept/cancel, member role change, member
    removal, API-key create/revoke, customer create/update/delete (if D2), payment create,
    worker-sweep `payment.succeeded`, refund create — asserting action, org, actor,
    resource, `data`, and request-id correlation against the request-log row;
  - atomicity injection: audit insert throws during a mutation → full rollback; during
    login → outcome unchanged, error logged;
  - replay: idempotent `payments.create`/`refunds.create` → exactly one entry;
  - list endpoint: pagination boundaries, ascending stability, org isolation (org A's
    entries never appear for org B, cursor included), 401/404 semantics.
- **E2E (API)**
  - full status table of §4.3 under session auth; API-key bearer rejected with 401;
    404/403 non-disclosure; limit/cursor edges; undeclared-parameter 400.
  - **Secret/PII-leak regression:** perform login (success + failure), API-key creation,
    idempotent payment creation, refund creation, invitation creation, and customer
    mutation; assert no audit row contains the password, key plaintext, `Idempotency-Key`,
    signing secret, email, or free-text input.
- **Web**
  - viewer renders the confirmed columns and org-wide label; project→org resolution;
    pagination; copyable `request_id`; read-only rendering; direct-URL project isolation;
    loading/error/empty states.
- Tests run deterministically with no real credentials and no secret logging; repository
  checks and OpenAPI lint must pass (AGENTS.md).

## 12. Out of scope

- **Audit of project, webhook-endpoint, and organization mutations** (create/update/delete)
  — no roadmap item or coordination note anticipates them; adding them is a §5 catalog
  amendment.
- **Per-request authorization denials (403/404) as audit entries** — Phase 11 request logs
  already persist them (§5.3).
- **Token-refresh events**, failed-logout events, and any auth event's presented email.
- **Rate limiting** of the audit route (Phase 13); metrics, dashboards, log shipping, and
  alerting (Phase 20).
- **Retention/expiry cleanup** and any deletion operation other than tenant cascade (D9).
- **A platform-global (non-organization) audit surface** — the contract has none; extending
  it would contradict the master scope (ADR-0009 excludes a platform admin console).
- **Export (CSV/JSON), live tail/streaming, full-text search, sorting controls, and list
  filters** beyond pagination (D11).
- **Delivering audit entries through webhooks**, correlating them into the Phase 10 event
  catalog, or any queue-based write path.
- **IP address / user agent / geo capture** and any forensic enrichment (D13).
- **Changing payment/refund/customer/invitation domain rules**, webhook event semantics, or
  stdout/request-logging behavior.
- SDKs, CLI tooling, and public documentation pages (Phase 15 consumes the §5 catalog and
  §6.4 lifecycle facts as handover input).

## 13. Decisions (D1–D13 — confirmed 2026-10-02)

Every row below was derived from the roadmap, the master specification, prior-phase
coordination notes, and the existing contract. All thirteen were **confirmed by the
product authority on 2026-10-02 exactly as proposed** (D2 accepted, D3 = all four roles).
The alternative column records what was rejected and why.

| # | Decision | Confirmed position | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Core catalog scope | Security: `user.registered`, `user.logged_in`, `user.login_failed`, `user.logged_out` (auth) + `invitation.created/canceled`, `member.joined/role_changed/removed` (access = access-control **changes**); Business: `payment.created/succeeded/failed`, `refund.created`. No `pending→processing` entry (aligns Phase 7 D10); no 403/404 mirroring (Phase 11 covers requests); no refresh events. | Roadmap-literal "auth" only with no access-control changes (leaves roles/membership changes — the classic audit subject — unrecorded); mirroring every request denial (duplicate noise); recording the processing edge (violates the established no-`payment.processing` judgment). |
| D2 | Coordination extensions | Add `api_key.created/revoked` (discharges Phase 5's deferral) and `customer.created/updated/deleted` (discharges Phase 6's anticipation). Explicitly beyond the roadmap's "(payments, refunds)" wording — **confirmed 2026-10-02**. | Reject both: keeps the roadmap literal but leaves two recorded coordination notes unfulfilled (Phase 6 note must then be reconciled and Phase 5's deferral left open). Including project/webhook/org mutations: rejected — no anticipation anywhere and unbounded catalog growth. |
| D3 | Read capability matrix | Reuse `logs.read` for all four roles (metadata-only content by construction; Phase 11's confirmed philosophy and "same `logs` surface" precedent). Note: the contract's 403 becomes structurally unreachable through legitimate roles, proven at guard-unit level instead. | New `logs.audit.read` limited to owner/admin (`invitations.read` precedent): audit is a security surface and the 403 response becomes live for members/viewers — viable if product prefers admin-only audit visibility; would require a registry extension and a distinct viewer gate. |
| D4 | Organization scoping of auth events | Membership fan-out: one entry per organization the user belongs to at event time; unknown-email login → **no entry**; zero memberships → zero entries. | Platform-global rows (impossible — `organization_id` required, no platform surface); default-org-only (hides logins from the tenant the user actually works in); recording unknown emails with no org (nowhere legal to put them); dropping failed logins entirely (the archetypal auth security event). |
| D5 | Actor for background transitions | Attribute `payment.succeeded`/`payment.failed` to the payment's original creator (user or API key) — stable whether the edge fires via sweep or read catch-up. | Add `system` to `actor_type` (contract enum change for a cosmetic gain); `actor_type: user` with null `actor_id` (misleading — a user did not act); attribute the triggering request's actor (nondeterministic: an unrelated list request could trigger catch-up). |
| D6 | Project/environment attribution | Add nullable, additive `project_id` and `environment` to `AuditLogEntry` (Phase 11 D1 precedent; required to make an org-wide list intelligible across projects and TEST/LIVE). | Keep the schema byte-identical and place both in `data` (free-form, invisible to schema tooling, inconsistent with the columnar treatment in `request_logs`); omit entirely (entries unattributable in multi-project orgs). |
| D7 | Write semantics | Mutations: insert in the **same transaction** as the change (no unaudited committed change; mirrors Phase 10 D2's transactional-durability reasoning). Auth outcomes (login/login-failed/logout): synchronous best-effort, failure logged and dropped, outcome never altered. | Uniform best-effort (Phase 11 style): allows committed changes with missing entries — unacceptable for an audit trail; uniform fail-closed: a login would fail when the audit insert fails (availability for a sandbox), and there is no transaction to join; queue-based writes (BullMQ): new failure modes for local inserts. |
| D8 | Immutability enforcement | No update/delete code path + no `SET NULL` FKs (plain-id actor/resource/project columns) + a DB rule rejecting `UPDATE`; cascade `DELETE` remains permitted. | Application-level-only (Phase 11 rule 6 level — weaker for a surface whose core promise is immutability); FKs with `SET NULL` on actor deletion (silently rewrites history — contradicts "never updated"); blocking `DELETE` outright (breaks Phase 4 D9 org deletion). |
| D9 | Lifecycle and retention | Entries live until organization deletion (cascade); **no** retention cleanup — phase 1 §8 says entries are never deleted, and audit volume is low. | Configurable retention with periodic cleanup (e.g. 365 days): viable later amendment, but silently expiring a security trail contradicts the phase's stated purpose; `RESTRICT` on org deletion (breaks the confirmed Phase 4 D9 deletion flow). |
| D10 | List ordering | Ascending by UUIDv7 via the shared cursor helper — consistent with every existing list (Phases 6/7/10/11 decisions). | Newest-first (better for "what happened recently" triage) — already rejected twice for consistency and cursor-helper simplicity; retained only if product prioritizes that UX. |
| D11 | List filters | None beyond `limit`/`cursor` (contract as written). | Additive `action` (and/or `resource_type`) exact filters — Phase 10 D15/Phase 11 D8 precedent, cheap and backward-compatible; adopt only if product wants filtered triage at MVP volume. |
| D12 | Viewer location | Keep `/dashboard/projects/[projectId]/logs/audit` (phase 1 §11.3 lists it); resolve project → organization and label the view organization-wide. | Move the viewer under `/dashboard/organizations/[organizationId]` (truer scoping) — requires changing the phase 1 route list and `docs/web-application-structure.md` navigation; better folded into a Phase 14 route-restructure if desired. |
| D13 | `data` contents policy | Per-action typed allowlists of bounded scalars only; `request_id` as the one common correlation key; never emails, IPs, user agents, free text (refund `reason`, customer names), headers, bodies, or secrets. | Capturing IP/user agent (forensic value, but PII collection with no contracted field and against Phase 11 D6's stance); echoing changed values (unbounded, may carry free text/PII); storing attempted-login emails (third-party PII exposure to every role under D3's confirmed matrix). |

## 14. Architectural decisions to record

To be authored in `.ai/decisions/` during implementation, continuing the existing series:

- **Audit write model**: transactional capture for mutations, best-effort auth outcomes,
  membership fan-out, background actor attribution, exactly-once emission (D4, D5, D7).
- **Audit immutability and lifecycle**: plain-id reference columns, the single cascade FK,
  the `UPDATE` block, and no retention (D8, D9) — including why audit and request logs
  deliberately diverge on retention and write guarantees.

## 15. Implementation considerations (not new requirements)

- Reuse the Phase 4 org-route pattern (`SessionAuthGuard + OrgRbacGuard +
  @RequireCapability` via the `RBAC()` factory) — this is an org-scoped, session-only
  route, not the dual-mode `ProjectAccessGuard` and not the Phase 5 project-route guard.
- Expose capture through an injectable port/service (the Phase 10 `WebhookEventPort`
  shape: emitter-owned UUIDv7, `INSERT … ON CONFLICT DO NOTHING`, caller's transaction) so
  domain modules never import audit internals (`docs/domain-model.md` §4 boundary rule).
- Prefer hooking capture where committed state already changes (the payments CAS
  transaction, the refund balance transaction, the Phase 4/5/6 mutation services) over
  intercepting HTTP responses — the catalog is event-driven (§4.2 rule 1), and the worker
  process must be able to write entries without an HTTP context.
- Keep scope resolution on already-available context (`authUser`, `apiKey`, membership,
  project → organization); the only extra read is the D4 membership fan-out query.
- Cursor pagination: reuse `organizations/cursor.ts` (ascending UUIDv7); do not create a
  second helper.
- Extend `organizations/roles.ts` only if D3's alternative is chosen; derive nothing from
  string literals in the controller.
- No new configuration section is needed (no retention, no thresholds) — deliberately
  simpler than Phase 11's `requestLogging` section.
- Refine `docs/openapi.yaml` in place and keep it the single source of truth (ADR-0012);
  the dashboard consumes only this contract — no web-only endpoints; add a thin
  `listAuditLogs` wrapper to `apps/web/lib/brinnpay/client.ts` alongside
  `listRequestLogs`.
- Keep the viewer a pure API client (phase 1 §11.4): no business logic, no client-side
  policy, no accumulation of the trail beyond the current view.
- Compose the `data` payload only through per-action typed builders (never a spread of an
  arbitrary object) so the allowlist is structural, not conventional.
- Do not modify application source as part of specification work.

## 16. Definition of done

The phase is complete only when:

1. Decisions D1–D13 have been confirmed (or formally amended) by the product authority,
   and the implementation matches the confirmed specification — including an explicit D2
   outcome (accepted, or the Phase 6/5 reconciliation recorded).
2. All acceptance criteria in §10 are satisfied and traced to the roadmap checkboxes.
3. Tests pass: unit, integration (real PostgreSQL), e2e API, and web viewer tests of §11 —
   including the atomicity guarantees, the exactly-once/replay rules, and the
   secret/PII-leak regression.
4. Repository-required checks pass: lint, typecheck, unit tests, relevant
   integration/e2e tests, build, and OpenAPI validation.
5. The security requirements of §9 have been explicitly reviewed (allowlist completeness,
   tenant isolation, session-only authority, immutability, cursor non-disclosure), with no
   known critical security issue remaining.
6. `docs/openapi.yaml` reflects the confirmed behavior and lints clean; the phase's
   architectural decisions are recorded in `.ai/decisions/`; the §5 catalog and §6.4
   lifecycle facts needed by Phase 15 documentation are handed over; the coordination
   obligations of §7 are marked discharged.
