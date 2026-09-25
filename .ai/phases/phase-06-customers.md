# Phase 6 — Customers

|                   |                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Phase             | 6                                                                                            |
| Name              | Customers                                                                                    |
| Status            | **Draft — decisions D1–D8 pending product-authority confirmation (2026-09-24)**              |
| Depends on        | Phase 5 (complete), Phase 4 (complete), Phase 3 (complete), Phase 2 (complete)               |
| Blocks            | Phase 7 (Payments), Phase 9 (Refunds), Phase 16 (Sandbox) — all reference `customers`        |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 6                                                    |

---

## 1. Objective

Deliver the **Customer** domain module: developer-managed customer records inside a project
environment, with CRUD operations, cursor pagination, filtering, and search (roadmap Phase 6).

- Customers are **API-level entities only** — they represent the developer's simulated "end
  user" (ADR-0008). A customer has no BrinnPay account, no authentication identity, and no
  access to any product area.
- Customers are **environment-scoped**: every customer belongs to exactly one project and one
  environment (`test` or `live`); TEST and LIVE data is never mixed (phase 1 §5.2,
  api-conventions §8).
- The customer routes are reachable by **both authentication modes** — API key
  (`Authorization: Bearer sk_…`) and session — per api-conventions §3. This phase is the
  **first HTTP consumer of the Phase 5 API-key authentication infrastructure**, and it
  introduces the dual-mode (API-key-or-session) authentication boundary and the
  environment-match rule, validated end-to-end.
- Session-authenticated access is governed by the Phase 4 role → capability model extended
  with customer capabilities; tenant isolation and the 404/403 non-disclosure semantics
  (phase 4 D1, phase 5 D2) are preserved.
- `apps/web` replaces the placeholder route with the **customers UI** in the project shell,
  operating on the environment selected by the Phase 5 environment selector.

Phase 6 delivers the `customers` domain module of the API and the customers area of
`apps/web`. It introduces the `customers` table via the committed-migration workflow
(ADR-0011).

## 2. Scope

In scope (mapped to the Phase 6 roadmap checkboxes):

| Roadmap checkbox              | Specification reference                              |
| ----------------------------- | ---------------------------------------------------- |
| Customer CRUD                 | §4.2 (list/create/retrieve/update/delete)            |
| Pagination (cursor-based)     | §4.2 (list), §4.5                                    |
| Filtering and search          | §4.2 (list), D3, §4.5                                |
| Customers UI in the dashboard | §5.1                                                 |

Required to keep the phase self-consistent (see §3):

- The **dual-mode authentication boundary** (API key or session) that the customer routes
  consume; without it the contract's "accepts either mode" security cannot be implemented
  (D8).
- The **environment-match rule**: API-key-scoped requests derive the environment from the
  key and reject conflicting payload/query environment values; session requests must
  declare the environment explicitly (D2).
- The **capability-registry extension** (roles matrix): customer capabilities so the Phase 4
  guard contract extends naturally (D5).
- The **search refinement** the contract defers ("refined in Phase 6"): free-text search
  fields and semantics (D3).

## 3. Context

Constraints reused from the master specification, Phases 1–5, and ADRs (all binding):

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`); PostgreSQL +
  Prisma; Redis/BullMQ available (not used before Phase 10).
- The API surface is versioned at `/api/v1` (ADR-0005); the canonical contract is
  `docs/openapi.yaml`, which **already defines** the complete Phase 6 surface:
  `GET/POST /projects/{project_id}/customers`,
  `GET/PATCH/DELETE /projects/{project_id}/customers/{customer_id}`, with the `Customer`,
  `CustomerCreate`, `CustomerUpdate`, `CustomerList`, `Environment`, and `CustomerList`-style
  schemas and the `Search` parameter. **No new endpoints are introduced by Phase 6**
  (ADR-0012); the spec refines descriptions in place where confirmed decisions affect them
  and must keep the contract Redocly-lint clean.
- The contract assigns **both** `ApiKeyAuth` and `SessionAuth` to every customer operation
  (api-conventions §3: `customers/*` is a developer integration surface; the dashboard
  renders the same pages under the user's session). The two modes are **not equivalent**
  (phase 1 §7.3): API-key requests act only within the key's (project, environment) scope;
  session requests are scoped to the user's organization memberships and subject to RBAC.
- Phase 5 (complete) shipped the **API-key authentication infrastructure** — generation,
  SHA-256 hashing, lookup by hash, revocation, `ApiKeyAuthGuard` scoping requests to a
  (project, environment) context — with **no HTTP consumer yet**; phase 5 §4.5 and §12
  explicitly assign the first consumers to Phase 6 (customers) and require the
  environment-match rule to be validated end-to-end.
- Phase 5 (complete) also shipped the project-scoped RBAC guard (project → owning
  organization → membership → capability; non-member → **404 `NOT_FOUND`**, member without
  capability → **403 `FORBIDDEN`**; malformed ids → 404) and the shared cursor pagination
  helper (`limit`/`cursor`, `{ data, next_cursor, has_more }`, time-ordered UUIDv7 ids).
  The customer routes live under `/projects/{project_id}` and stand on the same project
  model and environment model.
- Phase 1 domain model: `Customer` is "developer's customer record … API-level entity;
  represents the 'end user' actor (ADR-0008)"; `Project 1 ── * Customer`;
  `Customer 1 ── 0..* Payment`. Environment model: each environment-scoped resource
  (API keys today; customers in this phase) belongs to exactly one environment; TEST/LIVE
  data is never mixed (phase 1 §5.2).
- ADR-0008 (binding): the "end user" actor is the developer's simulated `Customer`; no
  customer-facing product area exists; `Customer` exists only at the API level.
- ADR-0011 + phase 2 conventions: UUIDv7 IDs as PostgreSQL `uuid` (ADR-0001), `snake_case`
  tables/columns, `created_at` on every record, `updated_at` on mutable records, UTC,
  application-supplied IDs/timestamps.
- ID strategy: UUIDv7 ids are the only customer identity; **ID opacity is not a security
  control** — authorization never relies on id secrecy (ADR-0001, phase 4 D1).
- Errors: canonical envelope (phase 2 base); 400 validation, 401 unauthenticated, 403
  forbidden, 404 not found, 409 conflict, 422 business rule, 429 rate limited (inactive
  until Phase 13). The `customers.create`/`customers.update` contract responses already
  include 422; `customers.list` does not (see D2 for the refinement).
- Rate limiting: all-route limits are Phase 13; Phase 6 adds none; the 429 responses in the
  contract remain inactive until then.
- Email normalization: users and invitations are stored **trimmed and lowercased**
  (phase 3/4 service behavior, `auth.service.ts`, `organizations.service.ts`); customer
  emails follow the same convention.
- Module boundaries (phase 1 §6.3): `customers` is a domain module owning its persistence
  and rules; it must not reach into other modules' tables. API-key authentication is
  application-level infrastructure consumed across modules.
- Repository state: Phase 5 is committed — `projects`/`api-keys` modules, project-scoped
  guard, API-key auth infrastructure, project UI with environment selector. The
  `customers` table does not exist; the `apps/web` customers route is a placeholder
  ("Customer management arrives in Phase 6").
- The contract defers two behaviors to Phase 6 that this spec must resolve: the **search**
  fields ("Free-text search across supported customer fields (refined in Phase 6)") and
  **delete-with-payments** semantics ("Behavior with linked payments is refined in
  Phase 7").

## 4. API Application — `apps/api` (customers)

### 4.1 Module purpose

Implement the customers surface (customer CRUD, environment scoping, search) as a domain
module (`customers` per phase 1 §6.3), plus the reusable piece this phase introduces:

- **Dual-mode authentication boundary (D8):** the customer routes accept an API key **or** a
  session. The boundary resolves the request to exactly one scope — an API-key scope
  (project + environment) or a session identity (user + memberships) — and is the first
  consumer of the Phase 5 `ApiKeyAuthGuard` mechanics.
- **Environment-match rule (D2):** API-key-scoped requests derive the environment from the
  key; conflicting request environment values are rejected. Session requests must provide
  the environment explicitly.

### 4.2 Endpoints

All endpoints already exist in `docs/openapi.yaml`; Phase 6 implements them against the
contract. Errors reuse the canonical envelope (§4.6).

#### `GET /projects/{project_id}/customers` — `customers.list` (200)

- Dual-mode authentication: API key or session (D8).
- **Session mode:**
  - Project-scoped authorization per the project RBAC guard (membership in the owning
    organization + `customers.read`); non-member → **404**, member without capability →
    **403** (phase 4 D1 / phase 5 D2).
  - The `environment` query parameter is **required**: TEST/LIVE data is never mixed, so a
    session request without an explicit environment cannot be served; missing → **400
    `VALIDATION_ERROR`** with a field error on `environment` (D2). The contract's
    `required: false` covers the API-key path in which the environment is implicit.
- **API-key mode:**
  - The request is scoped to the key's project and environment. The path `project_id` must
    equal the key's project; otherwise → **404 `NOT_FOUND`** (the addressed project is not
    within the key's scope — non-disclosure). No role/capability check applies (D5/D6).
  - The environment is **derived from the key**. An explicit `environment` query value, if
    present, must equal the key's environment; mismatch → **422 `BUSINESS_RULE_VIOLATION`**
    (D2).
- Filtering: `environment` (as above) and optional `search` (D3). Cursor pagination
  (`limit`, `cursor`) composes with the filters; ordering by the time-ordered UUIDv7 id.
- Response: **200** `CustomerList` (`{ data, next_cursor, has_more }`).

#### `POST /projects/{project_id}/customers` — `customers.create` (201)

Domain rules:

1. Request body: `environment`, `email` (required), `name` (optional), `metadata`
   (optional) (`CustomerCreate`).
2. **Session mode:** project-scoped authorization (membership + `customers.create`);
   non-member → **404**, member without capability → **403**. `environment` in the body is
   required; missing → **400 `VALIDATION_ERROR`** (D2).
3. **API-key mode:** path `project_id` must equal the key's project → otherwise **404**;
   `environment` in the body must equal the key's environment → mismatch **422
   `BUSINESS_RULE_VIOLATION`** (D2). No role check (D5/D6).
4. `email` is validated as an email address, trimmed and lowercased before persistence
   (phase 3/4 convention), ≤ 320 characters. **Not unique** — customer identity is the
   UUIDv7 id; multiple customers may share an email within the same project/environment
   (D1).
5. `name` is optional; when provided it must be a non-empty string after trimming, ≤ 200
   characters. Whitespace-only `name` → **400**. Absent `name` persists as `null`.
6. `metadata` is optional; when provided it must satisfy the flat string-map constraints
   (D6); absent → `{}`.
7. A customer belongs to exactly one (project, environment) — immutable after creation
   (environment and project_id can never change).
8. Returns **201** with the `Customer`.

#### `GET /projects/{project_id}/customers/{customer_id}` — `customers.retrieve` (200)

Domain rules:

1. **Session mode:** project-scoped authorization (membership + `customers.read`);
   non-member → **404**, member without capability → **403**.
2. **API-key mode:** path `project_id` must equal the key's project (else **404**); the
   customer must belong to the key's project **and** the key's environment — a customer in
   the other environment is not visible to the key (else **404**, non-disclosure).
3. The customer must belong to the addressed project: a `customer_id` of another project →
   **404** (no disclosure). Malformed `customer_id` → **404** (project guard pattern).
4. Returns **200** with the `Customer`.

#### `PATCH /projects/{project_id}/customers/{customer_id}` — `customers.update` (200)

Domain rules:

1. Request body: optional `email`, `name`, `metadata` (`CustomerUpdate`). Partial update:
   only provided fields change. `environment` and `project_id` are immutable and are not
   part of the update schema (contract).
2. **Session mode:** project-scoped authorization (membership + `customers.update`);
   non-member → **404**, member without capability → **403**.
3. **API-key mode:** path `project_id` must equal the key's project (else **404**); the
   customer must belong to the key's environment (else **404**); no role check (D5/D6).
4. Validation bounds for `email` / `name` / `metadata` as in create (email trimmed +
   lowercased, ≤ 320; name trimmed, non-empty, ≤ 200; metadata per D6).
5. Clearing `name` to `null` is **not supported** in the MVP (the contract's `CustomerUpdate`
   fields are non-nullable strings) — D7. A PATCH providing no fields is a **no-op** that
   returns the current state (mirroring `projects.update`).
6. `updated_at` advances when a field actually changes.
7. Returns **200** with the updated `Customer`.

#### `DELETE /projects/{project_id}/customers/{customer_id}` — `customers.delete` (204)

Domain rules:

1. **Session mode:** project-scoped authorization (membership + `customers.delete`);
   non-member → **404**, member without capability → **403**.
2. **API-key mode:** path `project_id` must equal the key's project (else **404**); the
   customer must belong to the key's environment (else **404**); no role check (D5/D6).
3. Deletes the customer row. In Phase 6 there are no child rows (payments do not exist
   yet); hard delete. The interplay with linked payments is refined in **Phase 7**
   (contract wording; coordination obligation — §12, §15).
4. Returns **204**. Subsequent access to the customer → **404** for everyone.

### 4.3 Authorization model (D5, D8)

- **Authentication (dual-mode boundary, D8):** every customer route resolves the request to
  exactly one scope:
  - `Authorization: Bearer <sk_…>` present → **API-key scope**: (project, environment) of
    the key (Phase 5 lookup; revoked/unknown key → **401**, generic).
  - otherwise → **session scope**: the authenticated user's memberships.
  - A request carrying both a valid session and an API key is treated as API-key-scoped
    (the key is the more specific scope; derive from the header).
- **Session-mode authorization** reuses the Phase 5 project-scoped guard mechanics with the
  customer capability matrix:

  | Capability        | owner | admin | member | viewer | Note |
  | ----------------- | :---: | :---: | :----: | :----: | ---- |
  | `customers.read`  | ✓ | ✓ | ✓ | ✓ | View customers of a project |
  | `customers.create`| ✓ | ✓ | — | — | Create customers (D5) |
  | `customers.update`| ✓ | ✓ | — | — | Edit customers (D5) |
  | `customers.delete`| ✓ | ✓ | — | — | Delete customers (D5) |

  Non-member → **404** (project existence never revealed); member without the capability →
  **403**. The registry extension lives in the single shared location
  (`apps/api/src/organizations/roles.ts`).
- **API-key-mode authorization (D6):** the key grants full CRUD **within its
  (project, environment) scope** — no role check. This follows the Phase 5 anti-goal ("no
  per-key scopes/permissions": a key is the developer's credential for its project
  environment, and any valid key may manage that environment's customers). Cross-project or
  cross-environment access through a key → **404** (non-disclosure), never a 403.
- The API (not the UI) is the enforcement point; the web application is a client of the API
  and never bypasses API-level authorization (phase 1 §11.4).

### 4.4 Tenant and environment isolation

- **Project scoping:** customers are queried and mutated only within the addressed project
  (path `project_id`). Session mode: project guard verifies membership in the owning
  organization. API-key mode: the path project must equal the key's project.
- **Cross-project `customer_id` manipulation** (acting on a customer id belonging to another
  project) → **404**, no disclosure.
- **Environment isolation:** TEST and LIVE data is never mixed (phase 1 §5.2). A customer is
  retrieved/updated/deleted through an API key only if it belongs to the key's environment
  (else **404**); a session-scoped list requires an explicit environment; an API-key-scoped
  list is filtered to the key's environment and conflicting explicit values → **422**.
- IDOR prevention across organizations, projects, environments, and customer ids is a
  first-class test concern (§9).

### 4.5 Pagination, search, and ordering

- **Pagination:** the shared cursor helper (phase 4 §4.5, phase 5) — `limit` (default 20,
  max 100) and `cursor` (opaque, last id of the previous page); response shape
  `{ data, next_cursor, has_more }`. Ordering by id ascending; UUIDv7 ids are
  time-ordered (ADR-0001). The cursor applies **within the filtered result set**
  (project + environment + search).
- **Search (D3):** the `search` query parameter performs a **case-insensitive substring
  match on `email` and `name`** (Prisma `contains` with `mode: 'insensitive'` on
  PostgreSQL). The term is optional; empty or whitespace-only values are treated as
  absent. Search applies within the selected environment only. No relevance ranking, no
  partial-token matching, no other fields in the MVP. The contract's `Search` description
  is refined in place to name the fields (ADR-0012).
- Search does not add dedicated indexes in the MVP (leading-wildcard substring match cannot
  use a B-tree index; datasets are small — performance is Phase 19).

### 4.6 Errors

Reuse the canonical envelope (phase 2 base). No new global error codes are required; the
environment-mismatch business rule uses the existing 422 `BUSINESS_RULE_VIOLATION` code with
a details object (a dedicated code such as `ENVIRONMENT_MISMATCH` is possible — see D2):

| Case | Status | Code |
| ----------------------------------------------- | ------ | ------------------------- |
| Validation failure (email format/bounds, name bounds, metadata constraints, malformed id, missing session `environment`) | 400 | `VALIDATION_ERROR` |
| Unknown/revoked API key; missing/expired session | 401 | `UNAUTHENTICATED` |
| Member without required permission (session mode) | 403 | `FORBIDDEN` |
| Non-member / unknown project / cross-project or cross-environment customer / malformed id / API-key path-project mismatch | 404 | `NOT_FOUND` |
| API-key environment mismatch (list query, create payload) | 422 | `BUSINESS_RULE_VIOLATION` |
| Throttled (reserved; effective in Phase 13) | 429 | `RATE_LIMITED` |
| Unexpected | 5xx | `INTERNAL_ERROR` |

Messages are generic where security demands it (cross-scope customer access, unknown keys)
and never leak internals.

## 5. Web Application — `apps/web` (customers UI)

Replace the placeholder route `/dashboard/projects/[projectId]/customers` (route already
documented in `docs/web-application-structure.md` §4). `apps/web` remains a client of the
API: no parallel backend, no duplicated domain rules; the API is the enforcement point and
role-based UI presentation matches the capability matrix (§4.3).

### 5.1 Customers page (`/dashboard/projects/[projectId]/customers`)

- **Environment:** the page operates on the environment from the project-shell selector —
  the `environment` query parameter, defaulting to `test` (phase 5 §5.3). All list/create
  calls pass that environment explicitly; switching the selector navigates to the same page
  with the new parameter.
- **List:** customers of the selected environment from `customers.list`, showing `email`,
  `name`, and `created_at`, with cursor pagination ("load more" via `next_cursor`, or
  simple page-next controls consistent with existing list UI). TEST/LIVE data is never
  mixed: the environment badge matches the selector.
- **Search:** a search box issuing `customers.list` with the `search` parameter
  (debounced); the result set replaces the list; pagination composes with the active term.
- **Create (owner/admin only, per matrix):** a form with `email` (required), `name`
  (optional), and a simple key/value `metadata` editor (`customers.create`). Validation
  errors surface from the API response.
- **Detail / edit (owner/admin only):** view a customer's record; edit `email`, `name`, and
  `metadata` (`customers.update`); **delete** with explicit confirmation
  (`customers.delete`, 204 → row disappears from the list).
- **Read-only roles:** `member`/`viewer` see the list, search, and detail content without
  create/edit/delete controls (API still enforces; UI hiding is presentation only —
  phase 4 §5.3).
- **Non-member:** reaching this page without membership in the owning organization shows the
  established not-found state (project access semantics, phase 5 §5.3).

### 5.2 Client additions

- Extend `apps/web/lib/brinnpay/client.ts` with the typed customer functions over the
  contract (thin fetch wrapper): list (with `project_id`, `environment`, `search`,
  `limit`, `cursor`), create, retrieve, update, delete — mirroring the existing
  projects/api-keys client functions.

### 5.3 Boundaries

- The dashboard shell, overview, project shell, and org/settings areas are untouched.
- `metadata` editing is a simple row-based editor; no JSON tree editing, no schema-typed
  metadata UI.
- Full dashboard polish and responsive layout remain Phase 14.

## 6. Data Requirements

Tables are added by Phase 6 via the committed-migration workflow (ADR-0011), applying the
fixed conventions (UUIDv7 stored as `uuid`; `snake_case`; `created_at` on every record;
`updated_at` on mutable records; UTC; application-supplied IDs/timestamps).

### 6.1 `customers` (new table)

| Column        | Type                  | Constraints / notes                                                         |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `id`          | `uuid`                | PK; UUIDv7 (ADR-0001).                                                       |
| `project_id`  | `uuid`                | FK → `projects.id` **`ON DELETE CASCADE`** (project deletion removes its customers). Indexed; composite index with `environment`. |
| `environment` | `varchar(20)`         | `test` or `live`; app-validated (phase 4 D10 pattern — `isEnvironment` helper from `projects/environment.ts`). |
| `email`       | `varchar(320)`        | Trimmed + lowercased, app-validated email format. **Not unique** (D1); duplicate emails are permitted. |
| `name`        | `varchar(200)` (nullable) | Trimmed; `null` when not provided.                                       |
| `metadata`    | `jsonb` (nullable)    | Flat string map (D6); `{}` when absent; replaced wholesale on update.        |
| `created_at`  | `timestamptz`         | UTC.                                                                          |
| `updated_at`  | `timestamptz`         | UTC; advanced by `customers.update`.                                         |

No `deleted_at` (hard delete), no status/lifecycle fields (customer lifecycle arrives with
payments in Phase 7; do not invent).

### 6.2 Migration and integrity

- One committed migration on top of the Phase 5 schema: creates `customers`, adds
  `customers → projects` FK with `ON DELETE CASCADE`, and indexes:
  - `@@index([projectId])`
  - `@@index([projectId, environment])` (list filtering within an environment; id-ordered
    cursor scans remain efficient at MVP scale)
- Prisma schema update: add `Customer` model; extend `Project` with `customers Customer[]`.
  `environment`/`metadata` semantics remain app-validated.
- Atomicity: create/update/delete are single writes; no multi-row transactions in Phase 6.
- No seed data, no secrets in migrations.

## 7. Security Requirements

1. **Dual-mode authentication (D8):** every customer route resolves to exactly one scope —
  API key or session. Unknown/revoked keys and invalid sessions → **401** (generic, no
  state disclosure). The two modes never mix: a key-scoped request can never act on the
  user's memberships and vice versa.
2. **Tenant isolation / IDOR:** all customer queries are scoped by project; cross-project
  `customer_id` use and cross-organization project access → **404** (non-disclosure,
  phase 4 D1 / phase 5 D2 applied to customers). IDOR tests are first-class (§9).
3. **Environment isolation:** TEST/LIVE data is never mixed. A key sees only its
  environment's customers; session lists require an explicit environment; conflicting
  values are rejected (400/422 per §4.6).
4. **RBAC (session mode):** every customer route declares a capability; the capability
  matrix extension lives in the single shared registry; the API is the enforcement point.
5. **API-key scope discipline (API-key mode):** the path `project_id` must equal the key's
  project (**404** otherwise) and the target customer must belong to the key's environment
  (**404** otherwise) — key scope is never widened by path or payload values.
6. **Input validation:** email (format, ≤ 320, normalized), name (trim, non-empty, ≤ 200),
  metadata (flat string-map constraints), `environment` enum, UUID path ids (malformed →
  404 per the guard pattern). All external input validated at the boundary (NestJS
  pipes/DTOs).
7. **No credential handling:** customers carry no credentials; nothing new is logged — no
  new secrets are introduced by this phase.
8. **Secure logging / errors:** error messages and logs never reveal customer data beyond
  what the contract returns, and never leak internal details. Search/log content does not
  include API key material.
9. **Contract hygiene (ADR-0012):** `docs/openapi.yaml` descriptions refined in place where
  confirmed decisions affect them (search fields, environment requirements, delete
  semantics already deferred to Phase 7) and kept Redocly-lint clean — no parallel
  contract, no endpoint additions.

## 8. Acceptance Criteria

1. All Phase 6 roadmap checkboxes (§2) are implemented and traced (§11).
2. `customers.list`/`create`/`retrieve`/`update`/`delete` behave per §4.2 for both auth
  modes; response shapes match the contract (`Customer`, `CustomerList`).
3. **Dual-mode boundary (D8):** the same customer routes accept an API key (scoped to its
  project + environment) or a session (scoped to memberships + RBAC); a valid key for the
  addressed project performs CRUD without a role check; a revoked/unknown key → **401**
  generic; an invalid session → **401**.
4. **Session-mode RBAC:** `customers.create/update/delete` → owner/admin only;
  `customers.read` → every member role; non-member of the owning organization → **404**
  `NOT_FOUND` for every customer route; member without the capability → **403**
  `FORBIDDEN` — verified per endpoint and per role.
5. **API-key environment rule (D2):** create with a payload `environment` different from the
  key's → **422 `BUSINESS_RULE_VIOLATION`**; list with a mismatched query `environment` →
  **422** (after the in-place contract refinement); session create/list without
  `environment` → **400 `VALIDATION_ERROR`**; list is filtered to the key's environment.
6. **Customer scoping:** `customers.retrieve/update/delete` of a customer belonging to
  another project → **404**; of a customer in the other environment via an API key →
  **404**; malformed `customer_id` → **404**; deletion → **204** and subsequent access →
  **404** for everyone.
7. **Search (D3):** `search` matches `email` and `name` case-insensitively as a substring,
  is composed with the environment filter and cursor pagination, and treats
  empty/whitespace terms as absent; the contract's `Search` description names the fields.
8. **Email handling:** customer emails are validated (`email` format, ≤ 320), and persisted
  trimmed + lowercased; duplicate emails within a project/environment are allowed (D1).
9. **`customers` table:** exists with the specified columns, FK `ON DELETE CASCADE` from
  projects, indexes, and conventions (UUIDv7, timestamps, snake_case); `prisma migrate
  deploy` applies the migration in CI and clean environments.
10. **Web UI:** the customers page lists/search-paginates customers of the selected
    environment, offers create/edit/delete to owner/admin only (per matrix), hides controls
    for member/viewer, shows the not-found state for non-members, and the environment
    selector state flows through to the list/create calls.
11. **API-key infrastructure end-to-end (phase 5 obligation):** the first HTTP consumer of
    `ApiKeyAuth` is proven end-to-end — key-scoped customer access, revoked-key rejection,
    and the environment-match rule via real HTTP (integration/e2e).
12. **Contract consistency:** `docs/openapi.yaml` is consistent with the confirmed decisions
    (in-place refinements only), lints clean (Redocly) with no parallel contract
    (ADR-0012).
13. All repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
    `pnpm test:e2e`, `pnpm build`, locally and in CI.

## 9. Testing Requirements

### 9.1 API (`apps/api`)

- **Unit tests:**
  - Customer service: create (email normalization, name bounds, metadata validation,
    environment required in session flow), retrieve, update (partial, no-op patch,
    `updated_at`), delete; cross-project/cross-environment customer ids → 404.
  - Environment-match logic: key-derived environment vs payload/query environment
    (match/mismatch/absent) → 422/400 outcomes per mode.
  - Search: case-insensitive substring on email and name; whitespace-only term → absent;
    composition with environment filter and cursor.
  - Metadata validation (D6): flat string map accepted; nested objects, non-string values,
    oversized keys/values/entry counts → 400.
  - Capability matrix: the four customer (role, capability) pairs resolve as specified
    (§4.3); existing Phase 4/5 pairs unchanged.
  - Dual-mode boundary (D8): bearer key present → key scope; no bearer → session scope;
    revoked key → 401; invalid session → 401.
  - DTO validation: email format/bounds, name bounds, environment enum, list query
    (limit/cursor/environment/search).
- **Integration/e2e (`test:e2e`) against the running app with real PostgreSQL/Redis:**
  - register → default org → project → customer create/list/retrieve/update/delete under
    session; capability checks per role; non-member → 404; member-without-capability →
    403.
  - API-key mode end-to-end: create key (phase 5) → customer CRUD with the key; revoked key
    → 401; key of project A against project B's customer routes → 404; key environment
    mismatch → 422; list filtered to key environment.
  - Tenant isolation/IDOR suite: user of org 1 against org 2's project customers → 404;
    cross-project `customer_id` → 404; cross-environment customer via key → 404.
  - Search: substring matches (case-insensitive) on email/name, empty term, composed with
    pagination.
  - Migrations apply cleanly (`prisma migrate deploy` step in CI, phase 2 workflow).
- **Web (`apps/web`):**
  - Unit: customers page states — list rendering per environment, search interaction,
    create form validation feedback, owner/admin-only controls, member/viewer read-only,
    non-member not-found.
  - E2e (`test:e2e`): extend the established smoke pattern — a scripted single-user flow
    (switch to `test` environment, create a customer, search for it, edit it, delete it).
    Full browser e2e remains Phase 17.

### 9.2 Shared

- All checks run from the repository root (`pnpm -r …`) and in CI.
- Tests require no secrets; test config uses `.env.example`-style defaults; test data uses
  generated UUIDv7 and unique test projects.
- Assertions that customer `metadata`/email content never appears in structured request
  logs beyond the contract response surface are included where logging is exercised.

## 10. Definition of Done

Phase 6 is complete when:

- All roadmap checkboxes in §2 are implemented and traced (§11).
- All acceptance criteria in §8 pass.
- All checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D8 are confirmed by the product authority (§14), contract refinements are
  applied in place (ADR-0012), and the document stays Redocly-lint clean.
- The Phase 5 coordination obligation is discharged: the API-key authentication
  infrastructure has its first HTTP consumers (customer routes), with the environment-match
  rule validated end-to-end (§8.11).
- No security-relevant issue remains open: dual-mode authentication resolves to exactly one
  scope; tenant isolation and environment isolation are enforced with 404 non-disclosure;
  RBAC (session) and key-scope discipline (API key) are tested per role and per scope.
- Coordination obligations are recorded: Phase 7 (Payments) owns `customers.customer_id`
  references, the payment-customer FK `ON DELETE` policy, and the delete-with-payments
  semantics the contract defers; the customer's `environment` immutability binds Phase 7
  payment creation (payments must be created against a customer of the same project and
  environment).
- Phase 7 (Payments) can start without re-opening Phase 6 decisions.

## 11. Traceability (Roadmap → Phase 6)

| Roadmap Phase 6 checkbox        | Specification reference                    |
| ------------------------------- | ------------------------------------------ |
| Customer CRUD                   | §4.2, §6.1, §8.2–8.6                       |
| Pagination (cursor-based)       | §4.2 (list), §4.5, §8.7                    |
| Filtering and search            | §4.2 (list), D3, §4.5, §8.7                |
| Customers UI in the dashboard   | §5, §8.10                                  |

## 12. Implementation Considerations

- **Dual-mode boundary (D8):** the existing `ApiKeyAuthGuard` 401s any request without a
  bearer header, so the customer routes cannot simply stack both guards. Implement a
  combined boundary that: (a) when `Authorization: Bearer <sk_…>` is present, runs the
  Phase 5 API-key path and attaches the `(project, environment)` scope; (b) otherwise runs
  the session path and attaches the user. The project/capability check then branches on the
  resolved scope (§4.3): API-key mode verifies the path project equals the key's project
  (404) and skips the role matrix; session mode reuses the Phase 5 project-guard mechanics
  (membership → capability → 404/403) and the shared capability registry
  (`organizations/roles.ts` extension with the customer capabilities). Avoid duplicating the
  Phase 5 lookup logic — reuse the module/service behind `ApiKeyAuthGuard`.
- **Environment resolution (D2):** session + list/create must receive `environment` (400
  when missing, field error); API-key mode derives it from the key and treats an explicit
  conflicting value as 422 (list and create) — see D2 for the `customers.list` 422 contract
  refinement.
- **Search (D3):** filter with `email: { contains: term, mode: 'insensitive' }` plus
  `name: { contains: term, mode: 'insensitive' }` in an OR group, ANDed with
  project + environment, composed with the existing `cursorToWhere`. Empty term → no search
  filter. Update the `Search` parameter description in place.
- **Migration:** one committed migration creating `customers` (FK cascade to `projects`,
  `(project_id, environment)` composite index). Follow the Phase 4/5 pattern; verify
  `prisma migrate dev`/`deploy` round-trips in CI.
- **Normalization:** email trimmed + lowercased before persistence (mirror the
  phase 3/4 `normalizeEmail` behavior). Enforce `IsEmail` + `MaxLength(320)`; name
  `MaxLength(200)` + non-empty-after-trim when provided.
- **Metadata (D6):** validate at the boundary (custom validator over `@IsObject()`), persist
  via Prisma `Json` (`jsonb`); absent → `{}`; update replaces the whole map. No merging.
- **UI (D8 flow-through):** the environment selector (phase 5 §5.3) already persists
  `environment` as a query parameter on child links; the customers page reads it
  (default `test`), passes it to `customers.list`/`customers.create`, and never mixes
  environments. Add the typed customer functions to `apps/web/lib/brinnpay/client.ts`.
- **OpenAPI refinements (in place, ADR-0012):** refine the `customers.*` descriptions —
  search fields, environment requirements per auth mode, dual-mode authorization,
  metadata constraints, email normalization/uniqueness (D1), and the delete-with-payments
  note pointing to Phase 7. Add the 422 response to `customers.list` if D2 confirms the 422
  mismatch code (small, in-place refinement; keep lint clean).
- **Anti-goals:** no customer authentication/accounts (ADR-0008), no customer lifecycle
  status, no per-customer payment history in this phase (Phase 7), no duplicate detection
  (D1), no customer archiving/bulk operations, no merging/duplicates UI, no per-key
  scopes/permissions (Phase 5 anti-goal), no rate limiting (Phase 13), no audit logging
  (Phase 12).

## 13. Out of Scope

- Payments, refunds, webhooks, idempotency, request logs, audit logs, all-route rate
  limiting (Phases 7–13) — although Phase 7 builds on this phase's customers and may
  revisit the delete-with-payments behavior.
- Any customer-facing product area, end-user accounts, or customer authentication
  (ADR-0008).
- Customer lifecycle status, payment history on the customer record, duplicate-email
  detection, customer archival/restore, bulk operations (not in the contract; do not
  invent).
- Per-customer or per-key permission scopes (Phase 5 anti-goal).
- Platform-administrator functionality (ADR-0009).
- Full dashboard polish, responsive layout, and browser e2e tooling (Phases 14, 17).
- Real payment processing, billing, SSO, microservices (master specification).

## 14. Decisions

> **Pending product-authority confirmation (2026-09-24).** The recommendations below ([rec])
> are the smallest solutions consistent with the canonical contract and prior phases.
> Phase 6 is not ready for implementation until D1–D8 are confirmed.

| # | Decision | Recommended option [rec] / alternatives |
| - | -------- | ---------------------------------------- |
| D1 | Customer email uniqueness | **[rec]** Email is **not unique** — customers are identified by their UUIDv7 id; multiple customers may share an email within a project/environment (common payment-provider behavior; the contract declares no uniqueness). Alternatives: unique per (project, environment) via a partial/unique index (blocks legitimate duplicate-email scenarios and adds a constraint the contract never states). |
| D2 | Environment resolution and mismatch code | **[rec]** Session mode: `environment` is **required** (list query, create payload) — missing → **400 `VALIDATION_ERROR`** (field error); the contract's `required: false` covers the API-key path. API-key mode: environment **derived from the key**; an explicit conflicting value → **422 `BUSINESS_RULE_VIOLATION`** on list and create — refine `customers.list` responses in place to add 422 (ADR-0012, in-place). Alternatives: mismatch → 400 everywhere (contract-conformant for list, but inconsistent with create's declared 422 and semantically weaker); add a dedicated `ENVIRONMENT_MISMATCH` code (extra registry entry; not needed for the MVP). |
| D3 | Search fields and semantics ("refined in Phase 6") | **[rec]** `search` matches `email` and `name` with a **case-insensitive substring** (Prisma `contains` + `mode: 'insensitive'`), composed with the environment filter and cursor pagination; empty/whitespace term treated as absent. Alternatives: exact-match email search (underpowered); prefix-only match (unpredictable for names); search over more fields (metadata — no contract basis in the MVP). |
| D4 | Metadata constraints | **[rec]** Flat object: **string keys (≤ 40 chars) and string values (≤ 500 chars), ≤ 50 entries**; absent on create → `{}`; update **replaces the whole map** (no merging). Alternatives: allow arbitrary JSON values (weaker contract meaning of "key/value metadata"; complicates UI and validation); deep/typed metadata (overkill for MVP). |
| D5 | Session-mode capability matrix | **[rec]** `customers.read` → all roles; `customers.create/update/delete` → **owner + admin**, following the Phase 5 project-resources pattern (customer data is project data; mutation is administrative in the dashboard). Alternatives: let `member` create/update/delete customers (possible, but diverges from the Phase 5 matrix without a stated reason). |
| D6 | API-key-mode authorization | **[rec]** A valid key grants **full CRUD within its (project, environment) scope — no role check**, matching Phase 5's no-per-key-scopes anti-goal and ADR-0006 ("one key = one project + environment"). The path project must equal the key's project and targets must belong to the key's environment (mismatches → **404**, non-disclosure). Alternatives: map the key to a role (no model exists; over-engineering). |
| D7 | Clearing `name` to null | **[rec]** **Not supported in the MVP** — `CustomerUpdate.name` is a non-nullable string in the contract; a PATCH omitting `name` leaves it unchanged. Alternatives: allow explicit `null` to clear the name (contract schema change; deferred). |
| D8 | Dual-mode authentication boundary | **[rec]** A combined API-key-**or**-session boundary resolves each request to exactly one scope — bearer key present → Phase 5 API-key path (project + environment); otherwise → session path (user memberships); then the project/capability check branches on the scope (§4.3). This is the first HTTP consumer of the Phase 5 infrastructure. Alternatives: two separate route registrations per endpoint (duplication, drift); key-only then session-fallback middleware (ambiguous when both are present). |

> **Consistency check with prior phases:** none of the proposed decisions contradicts the
> master specification, Phases 1–5, or ADRs 0001–0014. D1 follows the contract (no
> uniqueness declared) and ADR-0001 (identity = UUIDv7). D2 implements the contract's
> declared environment rules (phase 1 §5.2, api-conventions §3, contract descriptions) with
> only an in-place response refinement for `customers.list`. D3 is the refinement the
> contract defers. D4 narrows the `additionalProperties: true` metadata object to the
> "key/value" meaning the contract description states. D5 extends the phase 4/5 matrix
> consistently. D6 honors phase 5's no-per-key-scopes anti-goal and the domain-model boundary
> rule ("API-key-authenticated requests are scoped to the project the key belongs to").
> D7 preserves the contract's field typing. D8 is the implementation of the contract's
> "security: [ApiKeyAuth, SessionAuth]" on resource routes and discharges the phase 5
> coordination obligation.

## 15. Dependencies

- Inputs: Phase 5 (API-key authentication infrastructure, project-scoped guard, cursor
  pagination, environment model, project shell + environment selector UI), Phase 4 (RBAC
  guard/capability registry, 404/403 semantics, cursor helper), Phase 3 (session auth),
  Phase 2 base (error envelope, request IDs, DTO validation, Prisma migration workflow, CI
  service containers), phase 1 artifacts and ADRs 0001–0014, `docs/openapi.yaml` customers
  surface.
- Blocks: Phase 7 (Payments) — `Payment.customer_id` references customers; the customer's
  (project, environment) constrains payment creation; Phase 7 defines the
  payment-customer FK `ON DELETE` policy and the delete-with-payments behavior the contract
  defers. Phase 9 (Refunds) and Phase 16 (Sandbox) also reference customers.
- Coordination obligations out of this phase:
  - Phase 7: payment-customer FK policy (recommended evaluation: `RESTRICT` — reject
    deleting a customer with payments — or phase-specific decision); refinements to the
    `customers.delete` description once the behavior is decided; payments must be created
    against a customer of the same project and environment.
  - Phase 5 (obligation discharged here): first HTTP consumer of `ApiKeyAuth`; the
    environment-match rule validated end-to-end.
  - Phase 11/12: customer operations will appear in request and audit logs.
  - Phase 13: activates the 429 responses present on Phase 6 endpoints.
  - Phase 14: completes customers-area UI polish; Phase 17 adds browser e2e.