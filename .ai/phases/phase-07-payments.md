# Phase 7 — Payments

|                   |                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Phase             | 7                                                                                            |
| Name              | Payments                                                                                     |
| Status            | **Draft — decisions D1–D12 pending product-authority confirmation (2026-09-25)**             |
| Depends on        | Phase 6 (complete), Phase 5 (complete), Phase 4 (complete), Phase 3 (complete), Phase 2 (complete) |
| Blocks            | Phase 8 (Idempotency), Phase 9 (Refunds), Phase 10 (Webhooks), Phase 16 (Sandbox)            |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 7                                                    |

---

## 1. Objective

Deliver the **Payment** domain module: the core simulated payment model with a lifecycle and
state machine, the payment API surface (create, retrieve, list), the default-success
simulation, and the payments UI in the dashboard (roadmap Phase 7).

- Payments are **simulated operations** — no real money is processed in `test` or `live`
  (master specification; phase 1 §5.2).
- Every payment belongs to exactly one project, one environment (`test`/`live`), and one
  customer of the **same project and environment** (phase 6 §15 coordination obligation:
  payments must be created against a customer of the same project and environment; TEST/LIVE
  data is never mixed).
- The state machine is **pending → processing → succeeded | failed** (the contract's status
  enum). Phase 7 implements the machine and the default-success simulation; decline,
  timeout, and failure triggers belong to Phase 16 (Sandbox).
- The payment routes are reachable by **both authentication modes** — API key
  (`Authorization: Bearer sk_…`) and session — per api-conventions §3, consuming the
  dual-mode boundary introduced by Phase 6 (phase 6 D8) for the second time.
- Session-authenticated access is governed by the Phase 4 role → capability model extended
  with payment capabilities; tenant isolation and the 404/403 non-disclosure semantics are
  preserved.
- This phase also **discharges the Phase 6 coordination obligation** (phase 6 §15): the
  payment→customer FK `ON DELETE` policy and the delete-with-payments behavior the contract
  defers (`customers.delete` description: "Behavior with linked payments is refined in
  Phase 7").
- Per phase 1 §9.1, this phase owns the **payment event catalog** (types, payloads, emission
  timing). Event persistence, webhook delivery, and retries belong to Phase 10.

Phase 7 delivers the `payments` domain module of the API, the payments area of `apps/web`,
the `payments` table via the committed-migration workflow (ADR-0011), and the payment event
catalog.

## 2. Scope

In scope (mapped to the Phase 7 roadmap checkboxes):

| Roadmap checkbox              | Specification reference                              |
| ----------------------------- | ---------------------------------------------------- |
| Payment data model            | §6 (payments table), §4.2                            |
| Payment API (create, retrieve, list) | §4.2, §4.3–§4.5                              |
| Payment state machine (pending, processing, succeeded, failed) | §4.6                    |
| Payment simulation (no real money) | §4.6, D2                                       |
| Payments UI in the dashboard  | §5                                                   |

Required to keep the phase self-consistent (see §3):

- The **delete-with-payments behavior** (`customers.delete` refinement, D4): the contract
  defers it to Phase 7; without it the `payments` table's FK policy would be undefined and
  customer deletion would silently lose payment history.
- The **payment event catalog** (D10): phase 1 §9.1 assigns the payment lifecycle events to
  Phase 7; the catalog is a prerequisite for Phase 10 webhook delivery.
- A **money helper** at the API boundary: ADR-0002 requires amounts to be stored as integer
  minor units and exposed as decimal strings, with "scale handling in a single
  currency/money helper module"; no such helper exists yet.
- The **`payments.read`/`payments.create` capability extension** so the Phase 4 guard
  contract extends naturally (D5), mirroring the Phase 6 registry extension.

## 3. Context

Constraints reused from the master specification, Phases 1–6, and ADRs (all binding):

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`); PostgreSQL +
  Prisma; Redis available (BullMQ specifically is **not** wired until Phase 10 — ADR-0013).
- The API surface is versioned at `/api/v1` (ADR-0005); the canonical contract is
  `docs/openapi.yaml`, which **already defines** the complete Phase 7 surface:
  `GET/POST /projects/{project_id}/payments`,
  `GET /projects/{project_id}/payments/{payment_id}` with the `Payment`, `PaymentCreate`,
  `PaymentList`, `MoneyAmount`, `Environment`, and `IdempotencyKey` definitions. **No new
  endpoints are introduced by Phase 7** (ADR-0012); the spec refines descriptions in place
  where confirmed decisions affect them (state machine, simulation, environment rules,
  `customers.delete` behavior) and must keep the contract Redocly-lint clean.
- The contract assigns **both** `ApiKeyAuth` and `SessionAuth` to every payment operation
  (api-conventions §3). The two modes are **not equivalent** (phase 1 §7.3): API-key
  requests act only within the key's (project, environment) scope; session requests are
  scoped to the user's organization memberships and subject to RBAC.
- Phase 6 (complete) introduced the **dual-mode authentication boundary** (Phase 6 D8):
  bearer `sk_…` → API-key scope (project + environment); otherwise → session scope. The
  customer routes are the first consumer; payment routes are the second and should mirror
  the same mechanics (D11).
- Phase 6 (complete) also delivered: the environment-match rule (phase 6 D2 — session
  requires an explicit environment; API-key derives it and rejects conflicts), the shared
  cursor pagination helper (`{ data, next_cursor, has_more }`, UUIDv7 ordering), the
  project-scoped RBAC mechanics (non-member → 404, member without capability → 403), the
  capability registry in `organizations/roles.ts`, and JSON-free, snake_case contract
  projections.
- Phase 6 §15 coordination obligations (binding on this phase):
  - The **payment→customer FK `ON DELETE` policy** (recommended evaluation:
    `RESTRICT` — reject deleting a customer with payments — or phase-specific decision);
  - **refinements to the `customers.delete` description** once the behavior is decided;
  - **payments must be created against a customer of the same project and environment**;
  - customer `environment` immutability binds payment creation.
- Phase 1 domain model: `Customer 1 ── 0..* Payment`; `Payment` is a "simulated payment
  operation with a lifecycle"; "state machine detailed in Phase 7". Amounts per ADR-0002
  (integer minor units internally, decimal strings in the API); USD-only per ADR-0003
  (`currency` field kept for forward compatibility; non-`usd` rejected).
- ADR-0004 (binding in shape, not in storage): `payments.create` accepts an
  `Idempotency-Key` header with operation scope `payments.create`. The **storage,
  uniqueness, replay, and TTL mechanics belong to Phase 8**; Phase 7 must decide how to
  treat the header meanwhile (D6) without front-loading Phase 8.
- ADR-0013 (binding): BullMQ queues and workers are introduced in Phase 10. Phase 7's
  simulation must not depend on BullMQ.
- ADR-0011 + phase 2 conventions: UUIDv7 IDs as PostgreSQL `uuid` (ADR-0001), `snake_case`
  tables/columns, `created_at` on every record, `updated_at` on mutable records, UTC,
  application-supplied IDs/timestamps.
- Errors: canonical envelope (phase 2 base); 400 validation, 401 unauthenticated, 403
  forbidden, 404 not found, 409 conflict, 422 business rule, 429 rate limited (inactive
  until Phase 13). The `payments.create` and `payments.list` contract responses already
  declare 400/422 where applicable (see D1 for the `payments.list` 422 question).
- Rate limiting: all-route limits are Phase 13; Phase 7 adds none; the 429 responses in the
  contract remain inactive until then.
- Module boundaries (phase 1 §6.3): `payments` is a domain module owning its lifecycle,
  rules, and events; it must not reach into other modules' tables. It reads customers only
  through the customers-owned persistence boundary of its own module's queries (FK-scoped
  existence check). The idempotency/request-logging/audit cross-cutting capabilities are
  not part of this phase.
- Repository state: Phase 6 is committed — customers module with the dual-mode guard, the
  `customers` table, the dashboard customers UI. The `payments` table does not exist; the
  `apps/web` payments route is a placeholder ("Payments arrive in Phase 7").
- The contract defers two behaviors to Phase 7 that this spec must resolve: the **payment
  state machine and simulation** ("The full state machine and simulation behavior are
  refined in Phase 7") and the **delete-with-payments behavior** ("Behavior with linked
  payments is refined in Phase 7" on `customers.delete`).

## 4. API Application — `apps/api` (payments)

### 4.1 Module purpose

Implement the payments surface (payment create/retrieve/list, state machine, simulation,
event emission, money handling) as a domain module (`payments` per phase 1 §6.3), plus the
pieces this phase introduces or extends:

- **Money helper (`common/money`, D8):** parse/format/validate decimal string amounts at the
  API boundary; integer minor units internally (ADR-0002); USD-only validation (ADR-0003).
- **Simulation engine (§4.6, D2):** deterministic, time-based advancement of the payment
  state machine with default success; failure triggers are explicitly out of Phase 7 scope.
- **Payment event catalog (§4.7, D10):** the event types, payloads, and emission timing
  owned by this phase per phase 1 §9.1; emitted through a seam that Phase 10 plugs into.
- **Delete-with-payments behavior (§4.9, D4):** a change to the `customers` module and the
  `customers.delete` contract description, discharging the Phase 6 coordination obligation.

### 4.2 Endpoints

All endpoints already exist in `docs/openapi.yaml`; Phase 7 implements them against the
contract. Errors reuse the canonical envelope (§4.10).

#### `GET /projects/{project_id}/payments` — `payments.list` (200)

- Dual-mode authentication: API key or session (phase 6 D8 pattern).
- **Session mode:**
  - Project-scoped authorization (membership in the owning organization + `payments.read`);
    non-member → **404**, member without capability → **403**.
  - The `environment` query parameter is **required**: TEST/LIVE data is never mixed, so a
    session request without an explicit environment cannot be served; missing → **400
    `VALIDATION_ERROR`** with a field error on `environment` (D1, mirroring phase 6 D2). The
    contract's `required: false` covers the API-key path in which the environment is
    implicit.
- **API-key mode:**
  - The request is scoped to the key's project and environment. The path `project_id` must
    equal the key's project; otherwise → **404 `NOT_FOUND`**. No role/capability check
    applies (D5/D6 phase 6).
  - The environment is **derived from the key**. An explicit `environment` query value, if
    present, must equal the key's environment; mismatch → **422 `BUSINESS_RULE_VIOLATION`**
    (D1).
- Filtering: `environment` only — the contract defines no `search` or `customer_id` filter
  for payments; none are invented. Cursor pagination (`limit`, `cursor`) composes with the
  environment filter; ordering by the time-ordered UUIDv7 id.
- Non-terminal payments whose scheduled advancement time has passed are advanced before the
  page is assembled (§4.6, D2).
- Response: **200** `PaymentList` (`{ data, next_cursor, has_more }`).

#### `POST /projects/{project_id}/payments` — `payments.create` (201)

Domain rules:

1. Request body: `environment`, `customer_id`, `amount`, `currency` (all required),
   `description` (optional) (`PaymentCreate`). The `Idempotency-Key` header is accepted and
   validated (D6).
2. **Session mode:** project-scoped authorization (membership + `payments.create`);
   non-member → **404**, member without capability → **403**. `environment` in the body is
   required (DTO-enforced); missing → **400 `VALIDATION_ERROR`**.
3. **API-key mode:** path `project_id` must equal the key's project → otherwise **404**;
   `environment` in the body must equal the key's environment → mismatch **422
   `BUSINESS_RULE_VIOLATION`** (D1, phase 6 D2 pattern). No role check.
4. **Customer validation (D3):** the `customer_id` must reference a customer of the
   **same project and same environment** (Phase 6 §15 obligation). An unknown customer, a
   customer of another project, or (API-key mode) a customer of the other environment →
   **404 `NOT_FOUND`** (non-disclosure: the referenced resource is not visible in this
   scope). Session mode: the customer must belong to the addressed project; a customer of
   another project → **404**.
5. **Amount (D7, D8):** `amount` is a decimal string matching the contract's `MoneyAmount`
   pattern (`^[0-9]+(\.[0-9]{1,2})?$`), converted to integer minor units at the boundary;
   the value must be **strictly positive** — `0`, `0.00`, and any negative value are not
   valid payments → **400 `VALIDATION_ERROR`** (field error on `amount`). No arbitrary
   upper bound in the MVP (BigInt storage; format limits constrain input).
6. **Currency (ADR-0003):** `currency` must be `usd`; anything else fails DTO enum
   validation → **400 `VALIDATION_ERROR`**.
7. **Description (D9):** optional; when provided, trimmed, ≤ 500 characters; whitespace-only
   → **400**. Absent → `null`.
8. The payment is created with `status = pending` and the simulation schedule is armed
   (§4.6). Returns **201** with the `Payment` (status `pending`).
9. **Idempotency-Key (D6):** the header is accepted when present, validated (non-empty,
   ≤ 255 characters → else **400**), and its value is deliberately **not** used for replay
   or deduplication in Phase 7 — repeated requests with the same key may create duplicate
   payments. This semantic gap is explicitly owned by Phase 8 and documented in the
   contract description (in-place refinement).

#### `GET /projects/{project_id}/payments/{payment_id}` — `payments.retrieve` (200)

Domain rules:

1. **Session mode:** project-scoped authorization (membership + `payments.read`);
   non-member → **404**, member without capability → **403**. No environment parameter: the
   payment id is the address; project scoping is the isolation boundary (D12, mirroring
   phase 6's retrieve/update/delete).
2. **API-key mode:** path `project_id` must equal the key's project (else **404**); the
   payment must belong to the key's project **and** the key's environment — a payment in
   the other environment is not visible to the key (else **404**, non-disclosure).
3. The payment must belong to the addressed project: a `payment_id` of another project →
   **404** (no disclosure). Malformed `payment_id` → **404** (guard pattern).
4. A non-terminal payment whose scheduled advancement time has passed is advanced before
   responding (§4.6, D2).
5. Returns **200** with the `Payment`.

### 4.3 Authorization model (D5, D11)

- **Authentication (dual-mode boundary):** every payment route resolves the request to
  exactly one scope, following the Phase 6 D8 pattern:
  - `Authorization: Bearer <sk_…>` present → **API-key scope**: (project, environment) of
    the key; revoked/unknown key → **401** (generic).
  - otherwise → **session scope**: the authenticated user's memberships.
  - A request carrying both a valid session and an API key is treated as API-key-scoped.
- **Session-mode authorization** reuses the project-scoped guard mechanics with the payment
  capability matrix (D5):

  | Capability        | owner | admin | member | viewer | Note |
  | ----------------- | :---: | :---: | :----: | :----: | ---- |
  | `payments.read`   | ✓ | ✓ | ✓ | ✓ | View payments of a project |
  | `payments.create` | ✓ | ✓ | — | — | Create payments (D5) |

  Non-member → **404** (project existence never revealed); member without the capability →
  **403**. The registry extension lives in the single shared location
  (`apps/api/src/organizations/roles.ts`).
- **API-key-mode authorization:** the key grants full access **within its (project,
  environment) scope** — no role check (phase 6 D6 pattern; Phase 5 no-per-key-scopes
  anti-goal). Cross-project or cross-environment access through a key → **404**
  (non-disclosure), never a 403.
- The API is the enforcement point; the web application is a client and never bypasses
  API-level authorization (phase 1 §11.4).

### 4.4 Tenant and environment isolation

- **Project scoping:** payments are queried and mutated only within the addressed project
  (path `project_id`). Session mode: project guard verifies membership in the owning
  organization. API-key mode: the path project must equal the key's project.
- **Cross-project `payment_id` manipulation** → **404**, no disclosure.
- **Customer scoping on create (D3):** the referenced customer must live in the same
  project and environment; a cross-project or cross-environment customer is
  indistinguishable from an unknown one (**404**, non-disclosure).
- **Environment isolation:** TEST and LIVE data is never mixed (phase 1 §5.2). A payment is
  retrieved through an API key only if it belongs to the key's environment (else **404**);
  a session-scoped list requires an explicit environment; an API-key-scoped list is filtered
  to the key's environment and conflicting explicit values → **422**; create follows the
  same rules for the body `environment`.
- IDOR prevention across organizations, projects, environments, customers, and payment ids
  is a first-class test concern (§9).

### 4.5 Pagination and ordering

- **Pagination:** the shared cursor helper (phase 4 §4.5, phases 5/6) — `limit` (default
  20, max 100) and `cursor` (opaque, last id of the previous page); response shape
  `{ data, next_cursor, has_more }`. Ordering by id ascending; UUIDv7 ids are time-ordered
  (ADR-0001). The cursor applies within the filtered result set (project + environment).
- No search, no customer filter, no status filter on the list — the contract defines none.

### 4.6 State machine and simulation (D2)

**States** (contract `Payment.status`): `pending`, `processing`, `succeeded`, `failed`.

**Legal transitions:**

```text
pending ──► processing ──► succeeded   (default simulation)
                     └──► failed       (defined; not producible via the public API in
                                        Phase 7 — decline/timeout triggers are Phase 16)
```

- `pending` → `processing` and `processing` → `succeeded | failed` are the only allowed
  edges. Terminal states (`succeeded`, `failed`) are absorbing: no transition out.
- No user-initiated transitions exist: the contract has no update/cancel/confirm endpoints
  for payments. The simulation is the only driver.

**Simulation (default success, no real money):**

- A created payment enters `pending` and is advanced automatically:
  - `pending → processing` after a short delay (default on the order of 1 second);
  - `processing → succeeded` (default outcome) after a further short delay (default on the
    order of 2 seconds).
- The schedule is **deterministic from `created_at`** and two documented delay constants
  (pending delay, settlement delay) — no separate transition columns are required in the
  DB; a restart never strands a payment because advancement may be computed from the
  elapsed time alone.
- **Advancement is lazy-safe:** a non-terminal payment whose scheduled time has passed is
  advanced when it is read (list or retrieve) and by the module's own scheduled checks. All
  advancement is guarded (compare-and-set on the expected status) so a payment can never
  advance twice or regress, even under concurrent timers/reads.
- **Failure:** the `failed` state exists in the model (column, transition legality, event
  definition) but Phase 7 exposes **no public trigger** for it — the default simulation
  always succeeds. Decline, timeout, and configurable failure scenarios are Phase 16
  (Sandbox); `failure_code` is stored when a payment fails and its catalog is Phase 16's
  responsibility.
- `updated_at` advances on each transition. Delays must be configurable/injectable so tests
  run deterministically with near-zero delays or a controlled clock.

### 4.7 Payment event catalog (D10)

Phase 1 §9.1 assigns the payment event catalog to Phase 7. The catalog binds Phase 10
(persistence, delivery, retries) but is defined here:

| Event type         | Trigger                            | `data` payload           |
| ------------------ | ---------------------------------- | ------------------------ |
| `payment.created`  | payment created (status `pending`) | the `Payment` object as contracted |
| `payment.succeeded`| `processing → succeeded`           | the `Payment` object     |
| `payment.failed`   | `processing → failed`              | the `Payment` object     |

- Naming follows phase 1 §9.4 (`<resource>.<past-tense-verb>`). No `payment.processing`
  event in the MVP: it would violate the naming convention and add noise; Phase 16 may
  revisit if the sandbox requires it.
- Outbound envelope follows phase 1 §9.5: `{ id, type, created_at, data, environment,
  project_id }` with a UUIDv7 event id and `environment` = `test`/`live`.
- **Emission:** `payment.created` fires synchronously when the payment is created;
  `payment.succeeded`/`payment.failed` fire when the terminal transition is applied (by
  scheduled check or read-time catch-up).
- **Seam:** the payments module emits through an internal event-sink boundary (interface +
  no-op/debug implementation in Phase 7). The webhooks module (Phase 10) implements event
  persistence and delivery against the same seam. The payments module owns the catalog and
  the emission points only; it must not create the `webhook_events` table in this phase.

### 4.8 Money handling (D7, D8)

- Amounts are **integer minor units** in persistence (`amount_minor`, USD scale 2) and
  **decimal strings** in the API (`amount`, e.g. `"10.00"`) — ADR-0002. No code path
  operates on floating-point money.
- A single **money helper** (`common/money`, ADR-0002's "single currency/money helper
  module") provides: parse decimal string → minor units (with the contract's `MoneyAmount`
  format and positivity rules), format minor units → decimal string, and USD-only currency
  validation (ADR-0003). Boundary conversion and validation are covered by tests (valid
  formats, leading/trailing zeroes, scale mismatches like `"10.001"`, zero/negative,
  `"10."`, `".50"`, over-precision).
- Minor units use Prisma `BigInt` (PostgreSQL `bigint`) — amounts cannot overflow. The
  response mapper converts `BigInt` minor units to the decimal string **before** any JSON
  serialization (`JSON.stringify(BigInt)` throws — never serialize raw `BigInt`).

### 4.9 Delete-with-payments behavior (D4) — `customers` module change

Discharges the Phase 6 §15 coordination obligation:

- **Policy:** `customers.delete` must **reject** deleting a customer that has linked
  payments → **422 `BUSINESS_RULE_VIOLATION`**, generic message, code
  `BUSINESS_RULE_VIOLATION` (the contract's `customers.delete` already declares a 422
  response; no contract response addition needed). A customer without payments is deleted
  as today (**204**).
- **DB backstop:** the `payments.customer_id` FK uses `ON DELETE RESTRICT`, so a delete
  cannot slip through at the database level even if the service check is bypassed.
- **Contract refinement (in place, ADR-0012):** replace the `customers.delete` description
  "Behavior with linked payments is refined in Phase 7" with the decided behavior.
- The check is scoped by the same visibility rules as the existing delete: the customer must
  first be resolved within the caller's scope (project; API-key pins environment); if any
  payment references it, the delete is rejected.

### 4.10 Errors

Reuse the canonical envelope (phase 2 base). No new global error codes are required; the
business-rule violations reuse the existing 422 `BUSINESS_RULE_VIOLATION` code with a
details object:

| Case | Status | Code |
| ------------------------------------------------- | ------ | ------------------------- |
| Validation failure (amount format/positivity, currency ≠ `usd`, UUID format on `customer_id`, missing session `environment` on list/create, description bounds, invalid `Idempotency-Key` header) | 400 | `VALIDATION_ERROR` |
| Unknown/revoked API key; missing/expired session | 401 | `UNAUTHENTICATED` |
| Member without required permission (session mode) | 403 | `FORBIDDEN` |
| Non-member / unknown project / unknown or cross-project or cross-environment payment / malformed `payment_id` / unknown or cross-project-or-environment customer / API-key path-project mismatch | 404 | `NOT_FOUND` |
| API-key environment mismatch (list query, create payload) | 422 | `BUSINESS_RULE_VIOLATION` |
| Customer has linked payments (`customers.delete`) | 422 | `BUSINESS_RULE_VIOLATION` |
| Throttled (reserved; effective in Phase 13) | 429 | `RATE_LIMITED` |
| Unexpected | 5xx | `INTERNAL_ERROR` |

Messages are generic where security demands it (cross-scope payment/customer access, unknown
keys) and never leak internals.

## 5. Web Application — `apps/web` (payments UI)

Replace the placeholder route `/dashboard/projects/[projectId]/payments` (documented in
`docs/web-application-structure.md` §4). `apps/web` remains a client of the API: no
parallel backend, no duplicated domain rules; the API is the enforcement point and
role-based UI presentation matches the capability matrix (§4.3).

### 5.1 Payments page (`/dashboard/projects/[projectId]/payments`)

- **Environment:** the page operates on the environment from the project-shell selector —
  the `environment` query parameter, defaulting to `test` (phase 5 §5.3, phase 6 §5.1). All
  list/create calls pass that environment explicitly; switching the selector navigates to
  the same page with the new parameter. TEST/LIVE data is never mixed.
- **List:** payments of the selected environment from `payments.list`, showing
  `customer_id`, `amount`, `currency`, `status`, `description`, and `created_at`, with
  cursor pagination consistent with the existing list UI. The status badge reflects the
  **persisted** status.
- **Simulation visibility:** while any listed payment is non-terminal (`pending`/
  `processing`), the page refreshes periodically (short interval) so the simulated
  advancement is observable, and provides a manual refresh control. Polling stops in the
  terminal state.
- **Create (owner/admin only, per matrix):** a form with a customer select (populated from
  `customers.list` of the selected environment — only customers of the same environment are
  offered), `amount` (decimal string input), `currency` (fixed to `usd`), and an optional
  `description` (`payments.create`). Validation errors surface from the API response.
- **Detail:** view a payment's full record — status, amount, currency, customer reference,
  description, timestamps — refreshed per the visibility rules above.
- **Read-only roles:** `member`/`viewer` see the list and detail content without the create
  control (API still enforces; UI hiding is presentation only — phase 4 §5.3).
- **Non-member:** reaching this page without membership in the owning organization shows the
  established not-found state (project access semantics, phase 5 §5.3).

### 5.2 Client additions

- Extend `apps/web/lib/brinnpay/client.ts` with the typed payment functions over the
  contract (thin fetch wrapper): list (with `project_id`, `environment`, `limit`,
  `cursor`), create (with `Idempotency-Key` support optional for the dashboard — the
  dashboard passes no key), retrieve — mirroring the existing customers client functions.

### 5.3 Boundaries

- The dashboard shell, overview, project shell, customers/api-keys pages, and org/settings
  areas are untouched except where this phase's own behavior requires it.
- No payment filters beyond environment, no refunds in the payments UI (Phase 9), no
  webhook event feeds (Phase 10).
- Full dashboard polish and responsive layout remain Phase 14.

## 6. Data Requirements

Tables are added by Phase 7 via the committed-migration workflow (ADR-0011), applying the
fixed conventions (UUIDv7 stored as `uuid`; `snake_case`; `created_at` on every record;
`updated_at` on mutable records; UTC; application-supplied IDs/timestamps).

### 6.1 `payments` (new table)

| Column           | Type                  | Constraints / notes                                                           |
| ---------------- | --------------------- | ----------------------------------------------------------------------------- |
| `id`             | `uuid`                | PK; UUIDv7 (ADR-0001).                                                         |
| `project_id`     | `uuid`                | FK → `projects.id` **`ON DELETE CASCADE`** (project deletion removes its payments). Indexed; composite index with `environment`. |
| `environment`    | `varchar(20)`         | `test` or `live`; app-validated (`isEnvironment` helper from `projects/environment.ts`). Immutable. |
| `customer_id`    | `uuid`                | FK → `customers.id` **`ON DELETE RESTRICT`** (D4 — a customer with payments cannot be deleted). Indexed. |
| `amount_minor`   | `bigint`              | Integer minor units of the currency (ADR-0002); USD scale 2. Positive.         |
| `currency`       | `varchar(3)`          | `usd` only in the MVP (ADR-0003); app-validated.                               |
| `status`         | `varchar(20)`         | `pending`/`processing`/`succeeded`/`failed`; app-validated (phase 4 D10 pattern). |
| `failure_code`   | `varchar(50)` (nullable) | Machine-readable failure reason; set only when `status = failed` (internal invariant); code catalog is Phase 16. |
| `description`    | `varchar(500)` (nullable) | Optional developer-provided description (D9); trimmed when stored.           |
| `created_at`     | `timestamptz`         | UTC.                                                                              |
| `updated_at`     | `timestamptz`         | UTC; advances on every status transition and on no-op-less writes.               |

No `deleted_at` (no deletion surface in the contract), no customer/refund history columns
(separate tables), no transition-time columns (simulation schedule is derived from
`created_at` and the delay constants — §4.6).

### 6.2 Migration and integrity

- One committed migration on top of the Phase 6 schema: creates `payments`, adds
  `payments → projects` FK (`ON DELETE CASCADE`), adds `payments → customers` FK
  (`ON DELETE RESTRICT`), and indexes:
  - `@@index([projectId, environment])` (list filtering within an environment; id-ordered
    cursor scans remain efficient at MVP scale);
  - `@@index([customerId])` (delete-with-payments check; future per-customer lookups).
- Prisma schema update: add `Payment` model; extend `Project` with `payments Payment[]`
  and `Customer` with `payments Payment[]`. `environment`, `status`, `currency`, and
  `failure_code` semantics remain app-validated.
- Atomicity: create is a single write; each transition is a guarded single-row update
  (compare-and-set on the expected status).
- No seed data, no secrets in migrations.

## 7. Security Requirements

1. **Dual-mode authentication:** every payment route resolves to exactly one scope — API
   key or session (phase 6 D8 mechanics). Unknown/revoked keys and invalid sessions →
   **401** (generic, no state disclosure). The two modes never mix.
2. **Tenant isolation / IDOR:** all payment queries are scoped by project; cross-project
   `payment_id` use and cross-organization project access → **404** (non-disclosure).
   IDOR tests are first-class (§9).
3. **Environment isolation:** TEST/LIVE data is never mixed. A key sees only its
   environment's payments; session lists require an explicit environment; conflicting
   values are rejected (400/422 per §4.10).
4. **RBAC (session mode):** every payment route declares a capability
   (`payments.read`, `payments.create`); the matrix extension lives in the single shared
   registry; the API is the enforcement point.
5. **API-key scope discipline (API-key mode):** the path `project_id` must equal the key's
   project (**404** otherwise), targets (payments, customers) must belong to the key's
   environment (**404** otherwise), and the create payload `environment` must match the key
   (**422** otherwise) — key scope is never widened by path or payload values.
6. **Customer scoping on create (D3):** a `customer_id` outside the addressed
   (project, environment) is indistinguishable from an unknown customer (**404**,
   non-disclosure); no existence oracle is created through payment creation.
7. **Input validation:** amount (format, positivity, scale), currency enum (`usd`),
   description bounds, `Idempotency-Key` header bounds, `environment` enum, UUID path and
   body ids (malformed `payment_id` → 404; malformed `customer_id` → 400 field error). All
   external input validated at the boundary (NestJS pipes/DTOs).
8. **Money correctness:** no floating-point money anywhere; boundary conversion only;
   `BigInt` minor units (no overflow); conversion and formatting covered by tests.
9. **Simulation safety:** transitions are guarded compare-and-set updates — a payment can
   never advance twice, regress, or transition out of a terminal state; concurrent timers/
   reads cannot corrupt state.
10. **No credential handling / secure logging:** payments carry no credentials; nothing new
    is logged beyond the contract surface; error messages never leak internals or
    cross-scope existence.
11. **Contract hygiene (ADR-0012):** in-place refinements only — `payments.*` descriptions
    (state machine, simulation, environment rules, Idempotency-Key note), `MoneyAmount`
    note (positivity), and `customers.delete` description (delete-with-payments) — kept
    Redocly-lint clean; no endpoint additions, no parallel contract.

## 8. Acceptance Criteria

1. All Phase 7 roadmap checkboxes (§2) are implemented and traced (§11).
2. `payments.list`/`create`/`retrieve` behave per §4.2 for both auth modes; response shapes
   match the contract (`Payment`, `PaymentList`).
3. **Dual-mode boundary:** the same payment routes accept an API key (scoped to its
   project + environment) or a session (scoped to memberships + RBAC); a valid key for the
   addressed project performs create/retrieve/list without a role check; a revoked/unknown
   key → **401** generic; an invalid session → **401**.
4. **Session-mode RBAC:** `payments.create` → owner/admin only; `payments.read` → every
   member role; non-member of the owning organization → **404** `NOT_FOUND` for every
   payment route; member without the capability → **403** `FORBIDDEN` — verified per
   endpoint and per role.
5. **Environment rule (D1):** session list without `environment` → **400**
   `VALIDATION_ERROR`; session create without body `environment` → **400**; API-key create
   with a payload `environment` different from the key's → **422**; API-key list with a
   mismatched query `environment` → **422**; list is filtered to the key's environment.
6. **Payment scoping:** `payments.retrieve` of a payment belonging to another project →
   **404**; of a payment in the other environment via an API key → **404**; malformed
   `payment_id` → **404**.
7. **Customer scoping on create (D3):** create with an unknown `customer_id`, a customer of
   another project, or (API-key mode) a customer of the other environment → **404**
   `NOT_FOUND`; create against a customer of the same project and environment succeeds.
8. **State machine and simulation (D2):** create returns the payment with
   `status = pending`; the payment advances to `processing` and then `succeeded` (default)
   within the documented bounds; terminal states are absorbing; no transition can regress or
   fire twice; a process restart does not strand non-terminal payments (read-time
   catch-up); tests exercise `failed` at the service level (no public trigger in Phase 7).
9. **Money (D7, D8):** create stores correct integer minor units for valid decimal amounts
   (`"10.00"` → 1000) and returns decimal strings; `"0"`/`"0.00"`, negatives, and
   scale-violating values (`"10.001"`) → **400**; non-`usd` currency → **400**; no
   floating-point arithmetic anywhere in the money path; `BigInt` is never serialized raw.
10. **Idempotency-Key (D6):** `payments.create` accepts a valid header; an empty or
    over-long header → **400**; the header is not used for deduplication in Phase 7
    (same-key duplicate creates are permitted) and the contract description documents this
    Phase 8 handoff.
11. **Delete-with-payments (D4):** `customers.delete` on a customer with linked payments →
    **422** `BUSINESS_RULE_VIOLATION`; without payments → **204** as before; the
    `payments.customer_id` FK is `ON DELETE RESTRICT` (backstop); the `customers.delete`
    contract description states the behavior.
12. **Event catalog (D10):** `payment.created`, `payment.succeeded`, and `payment.failed`
    are emitted at the specified transitions through the event seam with the phase 1 §9.5
    envelope; emission is observable in tests; no `webhook_events` persistence exists yet.
13. **`payments` table:** exists with the specified columns, FKs (`CASCADE` to projects,
    `RESTRICT` to customers), indexes, and conventions (UUIDv7, BigInt minor units,
    timestamps, snake_case); `prisma migrate deploy` applies the migration in CI and clean
    environments.
14. **Web UI:** the payments page lists the selected environment's payments with status
    badges, offers create to owner/admin only (per matrix), hides the create control for
    member/viewer, refreshes while payments are non-terminal, shows the not-found state for
    non-members, and flows the environment selector through to the list/create calls.
15. **Contract consistency:** `docs/openapi.yaml` is consistent with the confirmed
    decisions (in-place refinements only), lints clean (Redocly) with no parallel contract
    (ADR-0012).
16. All repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
    `pnpm test:e2e`, `pnpm build`, locally and in CI.

## 9. Testing Requirements

### 9.1 API (`apps/api`)

- **Unit tests:**
  - Money helper: parse/format/validate — valid amounts, leading zeros, scale mismatch
    (`"10.001"`), zero/negative rejection, malformed strings (`".50"`, `"10."`, `"-5"`),
    `usd`-only currency, `BigInt` never in JSON output.
  - Service: create (customer existence/scoping → 404, environment resolution per mode →
    400/422, money conversion, description bounds, status = `pending`), retrieve (scoping,
    malformed id → 404), list (environment filter, cursor composition, no inventing
    filters), state machine (legal transitions, guarded compare-and-set, no regression from
    terminal states, read-time catch-up with a controlled clock), event emission (created/
    succeeded/failed recorded through the seam).
  - Environment-match logic: key-derived environment vs payload/query environment
    (match/mismatch/absent) → 422/400 outcomes per mode (D1).
  - Capability matrix: the two payment (role, capability) pairs resolve as specified (§4.3);
    existing Phase 4/5/6 pairs unchanged.
  - Dual-mode boundary: bearer key present → key scope; no bearer → session scope; revoked
    key → 401; invalid session → 401.
  - DTO validation: amount format/positivity, currency enum, description bounds, UUID body
    and path ids, `environment`, `Idempotency-Key` bounds, list query (limit/cursor/
    environment).
  - Customers change: delete-with-payments → 422; delete without payments → 204; the
    existing customer behavior unchanged otherwise.
- **Integration/e2e (`test:e2e`) against the running app with real PostgreSQL/Redis:**
  - register → default org → project → customer → payment create/list/retrieve under
    session; capability checks per role; non-member → 404; member-without-capability →
    403.
  - API-key mode end-to-end: create key (phase 5) → payment create/retrieve/list with the
    key; revoked key → 401; key of project A against project B's payment routes → 404; key
    environment mismatch → 422; list/retrieve filtered to key environment.
  - Tenant isolation/IDOR suite: user of org 1 against org 2's project payments → 404;
    cross-project `payment_id` → 404; cross-environment payment via key → 404; unknown and
    cross-scope `customer_id` on create → 404.
  - Simulation: create → observe `pending` → `processing` → `succeeded` within the
    configured bounds (short, injected delays for test speed).
  - Delete-with-payments: customer with a payment → 422; after (test-level) payment
    removal → 204; migrations apply cleanly (`prisma migrate deploy` in CI).
- **Web (`apps/web`):**
  - Unit: payments page states — list rendering per environment, status badges and refresh
    behavior while non-terminal, create form validation feedback, owner/admin-only controls,
    member/viewer read-only, non-member not-found.
  - E2e (`test:e2e`): extend the established smoke pattern — a scripted single-user flow
    (switch to `test` environment, create a customer, create a payment against it, observe
    it advance to `succeeded`, refresh the list). Full browser e2e remains Phase 17.

### 9.2 Shared

- All checks run from the repository root (`pnpm -r …`) and in CI.
- Tests require no secrets; test config uses `.env.example`-style defaults; test data uses
  generated UUIDv7 and unique test projects.
- Simulation delays are configurable/injectable so CI runs are deterministic and fast.
- Assertions that payment amount/description content never appears in structured request
  logs beyond the contract response surface are included where logging is exercised.

## 10. Definition of Done

Phase 7 is complete when:

- All roadmap checkboxes in §2 are implemented and traced (§11).
- All acceptance criteria in §8 pass.
- All checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D12 are confirmed by the product authority (§14), contract refinements are
  applied in place (ADR-0012), and the document stays Redocly-lint clean.
- No security-relevant issue remains open: dual-mode authentication resolves to exactly one
  scope; tenant isolation and environment isolation are enforced with 404 non-disclosure;
  RBAC (session) and key-scope discipline (API key) are tested per role and per scope;
  money handling uses exact integer arithmetic only.
- The Phase 6 coordination obligation is discharged: the payment→customer FK policy
  (`RESTRICT`) is implemented, `customers.delete` rejects customers with linked payments
  (422), the `customers.delete` contract description is refined, and payments are created
  only against customers of the same project and environment (§4.2 rule 4).
- The payment event catalog is defined and emitted through the seam (§4.7) — the Phase 1
  §9.1 ownership obligation is discharged without building Phase 10 persistence/delivery.
- Coordination obligations are recorded for later phases: Phase 8 (idempotency semantics
  for `payments.create`), Phase 9 (refunds require the payment state machine and its
  terminal states), Phase 10 (event persistence/delivery against the §4.7 seam), Phase 16
  (decline/timeout/failure triggers and the `failure_code` catalog), Phase 12 (audit
  logging of the payment lifecycle).
- Phase 8 (Idempotency) can start without re-opening Phase 7 decisions.

## 11. Traceability (Roadmap → Phase 7)

| Roadmap Phase 7 checkbox        | Specification reference                    |
| ------------------------------- | ------------------------------------------ |
| Payment data model              | §4.2, §6.1, §8.13                          |
| Payment API (create, retrieve, list) | §4.2, §4.3–§4.5, §8.2–8.7             |
| Payment state machine (pending, processing, succeeded, failed) | §4.6, §8.8 |
| Payment simulation (no real money) | §4.6, D2, §8.8                          |
| Payments UI in the dashboard    | §5, §8.14                                  |

## 12. Implementation Considerations

- **Dual-mode boundary (D11):** mirror the Phase 6 `CustomersAccessGuard` mechanics in a
  `payments`-module guard: bearer `sk_…` → API-key path (path project must equal the key's
  project, 404; no role check); otherwise session path (project → membership → capability →
  404/403). Reuse the Phase 5/6 infra (API-key lookup, session guard, capability registry,
  cursor helper, `environment.ts`) rather than duplicating it. A shared extraction of the
  guard is deferred until the third consumer (refunds, Phase 9) exists.
- **Environment resolution (D1):** session + list/create must receive `environment`
  (DTO/query-required → 400 when missing, field error); API-key mode derives it from the
  key and treats an explicit conflicting value as 422 (list and create) — mirror phase 6
  D2. Refine `payments.list` in place to declare the 422 response if D1 confirms 422.
- **Simulation (D2):** compute the transition schedule from `created_at` and two delay
  constants (pending delay, settlement delay). Advance with guarded `updateMany`
  (`where: { id, status: <expected> }`, check affected count) so concurrent scheduled/read
  paths never double-advance. Provide a read-time catch-up and a lightweight in-process
  scheduled check (timers — **not** BullMQ, ADR-0013). Delays configurable/injectable for
  deterministic tests.
- **Money (D7/D8):** implement `common/money` (decimal string ↔ minor units, positivity,
  USD-only). Use Prisma `BigInt`; the response mapper converts to the decimal string before
  serialization. Never log or serialize raw `BigInt`.
- **Customer check (D3):** on create, look up the customer scoped to
  `{ id: customer_id, projectId: scope.project_id, ...(api_key ? { environment } : {}) }`;
  not found → 404 (the same lookup shape as the customer service's scoped read).
- **Migration:** one committed migration creating `payments` (FK `CASCADE` to projects, FK
  `RESTRICT` to customers, `(project_id, environment)` + `customer_id` indexes). Follow the
  Phase 4/5/6 pattern; verify `prisma migrate dev`/`deploy` round-trips in CI.
- **Event seam (D10):** a minimal internal event-sink boundary in the payments module
  (interface + no-op/debug implementation); called from the create path (`payment.created`)
  and the terminal transition path (`payment.succeeded`/`payment.failed`). Phase 10 wires
  the real sink. Do not create `webhook_events` tables now.
- **Customers module change (D4):** in `customers.service.delete`, after the scoped
  customer is found, check `payment.count({ where: { customerId } })` → 422 when > 0; the
  FK `RESTRICT` is the DB backstop. Refine the `customers.delete` contract description in
  place.
- **OpenAPI refinements (in place, ADR-0012):** refine `payments.list`/`payments.create`/
  `payments.retrieve` descriptions — state machine and simulation summary, default-success
  behavior, environment requirements per auth mode, customer same-project-and-environment
  requirement, Idempotency-Key Phase 8 handoff; `MoneyAmount` description (positive
  amounts); `Payment.failure_code` description (set when failed; catalog in Phase 16);
  `customers.delete` description (RESTRICT behavior). Add the `payments.list` 422 response
  if D1 confirms it. Keep lint clean.
- **UI (D8 flow-through):** the environment selector (phase 5 §5.3) already persists
  `environment` as a query parameter on child links; the payments page reads it (default
  `test`), passes it to `payments.list`/`payments.create`, and never mixes environments.
  Add the typed payment functions to `apps/web/lib/brinnpay/client.ts`.
- **Anti-goals:** no idempotency semantics (Phase 8), no refunds (Phase 9), no event
  persistence/delivery (Phase 10), no request/audit logging (Phases 11/12), no rate limiting
  (Phase 13), no sandbox decline/timeout/failure triggers or `failure_code` catalog
  (Phase 16), no payment update/cancel/delete endpoints (not in the contract), no customer
  filter/search/status filter on `payments.list` (not in the contract), no payment
  authentication/accounts, no real money.

## 13. Out of Scope

- Idempotency storage, replay, deduplication, TTL mechanics (Phase 8) — Phase 7 only
  accepts/validates the `Idempotency-Key` header (D6).
- Refunds — full/partial refund logic, refund rules, refund endpoints (Phase 9).
- Webhook event persistence, webhook endpoints, HMAC delivery, retries, replay (Phase 10) —
  Phase 7 defines the payment event catalog and emission seam only.
- Request logs and audit logs (Phases 11/12).
- All-route rate limiting (Phase 13).
- Sandbox decline/timeout/failure simulation scenarios and the `failure_code` catalog
  (Phase 16).
- Full dashboard polish, responsive layout, and browser e2e tooling (Phases 14, 17).
- Any customer-facing product area, end-user accounts, or customer authentication
  (ADR-0008); platform-administrator functionality (ADR-0009).
- Real payment processing, multi-currency, rates, exchange logic, microservices, billing,
  SSO (master specification; ADR-0003).

## 14. Decisions

> **Pending product-authority confirmation (2026-09-25).** The recommendations below ([rec])
> are the smallest solutions consistent with the canonical contract and prior phases.
> Phase 7 is not ready for implementation until D1–D12 are confirmed.

| # | Decision | Recommended option [rec] / alternatives |
| - | -------- | ---------------------------------------- |
| D1 | Environment mismatch on `payments.list` | **[rec]** Mirror phase 6 D2: session list without `environment` → **400**; API-key explicit conflicting value → **422** `BUSINESS_RULE_VIOLATION` on list and create — requiring an in-place 422 response addition to `payments.list` (ADR-0012). Alternatives: use the contract's existing 400 for list mismatches (no contract change, but inconsistent with create's 422 and weaker semantics); a dedicated `ENVIRONMENT_MISMATCH` code (extra registry entry; not needed). |
| D2 | Simulation mechanics | **[rec]** Default-success simulation: payments advance `pending → processing → succeeded` with short, configurable delays computed deterministically from `created_at`; advancement is guarded and lazy-safe (read-time catch-up), so restarts never strand a payment; **no** public failure trigger in Phase 7 (`failed` is defined and service-testable; decline/timeout/failure scenarios and `failure_code` catalog are Phase 16). Alternatives: advance only on read (no timers — statuses would lie until read; undermines future webhook events); expose a failure trigger now (front-loads Phase 16 and invents sandbox-scenario config the roadmap assigns to Phase 16); use BullMQ (contradicts ADR-0013). |
| D3 | Unknown/mismatched `customer_id` on create | **[rec]** **404 `NOT_FOUND`** (non-disclosure): a customer outside the addressed (project, environment) is indistinguishable from an unknown one — no existence oracle. Alternatives: 422 `BUSINESS_RULE_VIOLATION` (would confirm the referenced customer's existence and leak cross-scope information); 400 (validation vs existence confusion). |
| D4 | Delete-with-payments behavior + FK policy | **[rec]** **Reject** deleting a customer with linked payments: `customers.delete` → **422** `BUSINESS_RULE_VIOLATION` (response already declared on `customers.delete`); `payments.customer_id` FK `ON DELETE RESTRICT` as the DB backstop; contract description refined in place. Alternatives: 409 `CONFLICT` (declared in the envelope but absent from `customers.delete` responses — contract change); `CASCADE` (silently deletes payment history — destructive and hides data); `SET NULL` (contradicts the contract's required non-null `customer_id`). |
| D5 | Session-mode capability matrix | **[rec]** `payments.read` → **all roles**; `payments.create` → **owner + admin**, following the Phase 5/6 project-resources pattern (payment data is project data; creating payments is administrative in the dashboard). Alternatives: let `member` create payments (possible, but diverges from the established matrix without a stated reason). |
| D6 | `Idempotency-Key` in Phase 7 | **[rec]** **Accept and validate** the header on `payments.create` (non-empty, ≤ 255 chars; invalid → 400) but do **not** implement replay/deduplication — the same key may produce duplicate payments until Phase 8; document the handoff in the contract description. Alternatives: implement Phase 8 storage/TTL early (violates roadmap sequencing and phase discipline); reject the header (breaks the documented contract for clients that follow it). |
| D7 | Amount bounds | **[rec]** Strictly positive, format per the contract's `MoneyAmount` (`^[0-9]+(\.[0-9]{1,2})?$`), minor units in `bigint` (no overflow); zero/negative → **400**. No arbitrary upper cap in the MVP (input is format-bounded; `BigInt` storage). Alternatives: an explicit documented cap (e.g., a $ limit) — defensible but invents a product limit the contract never states; store as `int` (restricts to ~$21M and needs a cap decision). |
| D8 | Money helper module | **[rec]** Introduce a single `common/money` helper for decimal-string ↔ minor-units conversion and USD-only validation, used only at the API boundary (ADR-0002's single helper); no floating-point money anywhere. Alternatives: inline conversions per endpoint (duplicated, drift-prone, violates ADR-0002's explicit single-module requirement). |
| D9 | `description` length bound | **[rec]** ≤ **500 characters**, trimmed; whitespace-only → 400; absent → `null`. The contract declares no bound, but a column type is required. Alternatives: 200 (aligns with `name` — unnecessarily tight for a description); 2000 (looser, fine either way — product authority to confirm). |
| D10 | Payment event catalog scope | **[rec]** Emit `payment.created`, `payment.succeeded`, `payment.failed` at the corresponding transitions, payload = the `Payment` as contracted, envelope per phase 1 §9.5, through an internal seam; **no** `payment.processing` event (naming convention is past-tense; noise) and no `webhook_events` persistence in Phase 7. Alternatives: also emit `payment.processing` (useful for sandbox demos but violates the naming convention and adds noise; Phase 16 may revisit); persist events now (front-loads Phase 10's table). |
| D11 | Access guard reuse | **[rec]** **Mirror** the Phase 6 dual-mode guard in the `payments` module (thin duplicate following the established pattern; zero risk to the committed customers module); extract a shared dual-mode resource guard when the third consumer arrives (refunds, Phase 9). Alternatives: extract the shared guard now (touches and re-tests committed Phase 6 code in Phase 7 — larger change, no additional correctness). |
| D12 | Session-mode retrieve environment | **[rec]** `payments.retrieve` (session mode) applies **no environment filter** — the `payment_id` is the address and project scoping is the isolation boundary (mirrors phase 6 retrieve/update/delete); API-key mode continues to pin to the key's environment (**404** cross-environment). Alternatives: require `environment` on retrieve (no contract parameter exists; adds complexity without an isolation benefit). |

> **Consistency check with prior phases:** none of the proposed decisions contradicts the
> master specification, Phases 1–6, or ADRs 0001–0014. D1 continues the phase 6 D2
> environment rule with the same 400/422 split (in-place contract addition for `payments.list`).
> D2 implements the roadmap's "payment simulation" with the smallest mechanism that is
> restart-safe and BullMQ-free (ADR-0013). D3 preserves 404 non-disclosure (phase 4 D1,
> phase 5 D2, phase 6). D4 discharges the phase 6 §15 coordination obligation with the
> recommended `RESTRICT` policy and the already-declared 422. D5 extends the phase 5/6
> matrix consistently. D6 honors ADR-0004's scope (the header is part of the contract from
> Phase 1) while leaving storage/replay to Phase 8 per the roadmap. D7/D8 implement
> ADR-0002/0003 exactly (integer minor units, decimal strings, USD-only, single helper).
> D9 picks a harmless column bound where the contract is silent. D10 fulfills phase 1 §9.1
> (payment event catalog owned by Phase 7) without building Phase 10 storage. D11 reuses the
> proven guard mechanics without rewriting committed code. D12 mirrors phase 6 retrieve
> semantics.

## 15. Dependencies

- Inputs: Phase 6 (customers + dual-mode boundary, environment-match rule, capability
  registry, cursor helper, dashboard customers UI, and the §15 coordination obligations
  this phase discharges), Phase 5 (API-key authentication infrastructure, project-scoped
  RBAC mechanics, environment model, project shell + environment selector UI), Phase 4
  (RBAC guard/capability registry, 404/403 semantics), Phase 3 (session auth), Phase 2 base
  (error envelope, request IDs, DTO validation, Prisma migration workflow, CI service
  containers), phase 1 artifacts and ADRs 0001–0014, `docs/openapi.yaml` payments surface.
- Blocks: Phase 8 (Idempotency) — the `payments.create` idempotency semantics build on this
  phase's create endpoint; Phase 9 (Refunds) — refunds target payments and depend on the
  payment state machine and its terminal states; Phase 10 (Webhooks) — payment events
  defined here are delivered there; Phase 16 (Sandbox) — decline/timeout/failure triggers
  extend this phase's simulation; Phase 12 (Audit Logs) — the payment lifecycle becomes an
  audit subject.
- Coordination obligations out of this phase:
  - Phase 8: implement `Idempotency-Key` replay/dedup for `payments.create` (operation
    scope `payments.create`, ADR-0004) and update the `payments.create` description once
    dedup is live.
  - Phase 9: refine `Payment`/`Refund` interplay — refund eligibility presumably requires
    the payment's terminal state; the state machine here is normative.
  - Phase 10: implement event persistence and webhook delivery against the §4.7 catalog
    and seam; the event envelope is fixed here.
  - Phase 16: add decline/timeout/failure simulation triggers and the `failure_code`
    catalog; extend §4.6 without breaking the legal transitions.
  - Phase 12: record payment lifecycle transitions in audit logs.
  - Phase 14/17: complete the payments UI polish and browser e2e coverage.