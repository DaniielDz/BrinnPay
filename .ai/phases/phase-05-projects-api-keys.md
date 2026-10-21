# Phase 5 — Projects & API Keys

|                   |                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------- |
| Phase             | 5                                                                                      |
| Name              | Projects & API Keys                                                                   |
| Status            | **Draft — decisions D1–D7 pending product-authority confirmation (2026-09-23)**        |
| Depends on        | Phase 3 (complete), Phase 4 (complete), Phase 2 (complete)                             |
| Blocks            | Phase 6 (Customers) and all environment-scoped resource phases (6–10, 11–12)           |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 5                                              |

---

## 1. Objective

Allow organizations to create **projects** (the tenant-owned container for customers,
payments, API keys, and webhooks) and to manage **API keys** scoped to the TEST and LIVE
simulated environments:

- Users can **create, retrieve, update, and delete projects** inside an organization.
- Projects expose two simulated environments — `test` and `live` — by default; every
  environment-scoped resource belongs to exactly one environment and TEST/LIVE data is
  **never mixed** (phase 1 §5.2, api-conventions §8).
- Users can **generate, list, and revoke API keys** per project environment. The key
  format (`sk_test_…` / `sk_live_…`), hashing-at-rest, one-time display, and lookup
  strategy are finalized here (ADR-0006, security baseline §5).
- **Key rotation** is delivered as a workflow (create new + revoke old) — see D1.
- Project access is governed by the Phase 4 role → capability model extended with
  project and API-key capabilities; tenant isolation and the **404/403 non-disclosure
  semantics** (phase 4 D1) are preserved for project-scoped routes.
- `apps/web` provides the **project management UI**, the **API key management UI**, and
  the **environment selector** (TEST/LIVE) in the project shell.

Phase 5 delivers the `projects` and `api-keys` domain modules of the API and the project
area of `apps/web`. It introduces the `projects` and `api_keys` tables via the
committed-migration workflow (ADR-0011) and the reusable **API-key authentication
infrastructure** (generation, hashing, lookup, revocation) whose first HTTP consumers are
the Phase 6+ resource routes.

## 2. Scope

In scope (mapped to the Phase 5 roadmap checkboxes):

| Roadmap checkbox                     | Specification reference                    |
| ------------------------------------ | ------------------------------------------ |
| Projects CRUD                        | §4.2 (list/create/retrieve/update/delete)  |
| TEST vs LIVE environment separation  | §4.2 (environment rules), §4.5, §6          |
| API key generation                   | §4.5 (scheme, hashing, display)            |
| Key rotation                         | §4.5, D1 (create + revoke workflow)        |
| Key revocation                       | §4.2 (`apiKeys.revoke`), §4.5              |
| Project management UI                | §5.1                                       |
| API key management UI                | §5.2                                       |
| Environment selection UI             | §5.3                                       |

Required to keep the phase self-consistent (see §3):

- The **project-scoped authorization guard** (project → owning organization →
  membership → capability), reusing the Phase 4 guard mechanics; without it the
  project routes (which carry no `organization_id` in the path) cannot enforce tenant
  isolation.
- The **API-key lookup/verification infrastructure** (`ApiKeyAuth` guard mechanics):
  ADR-0006 and the security baseline assign the key scheme, hashing, and **lookup
  strategy** to Phase 5. No Phase 5 route consumes it yet; it ships as tested
  infrastructure for Phases 6+.
- The **capability-registry extension** (roles matrix): project and API-key
  capabilities so the Phase 4 guard contract extends naturally.
- The **organization-deletion coordination** promised in phase 4 D9: projects become
  tenant-scoped data, so `DELETE /organizations/{organization_id}` must cascade them
  (and their keys).

## 3. Context

Constraints reused from the master specification, Phases 1–4, and ADRs (all binding):

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`); PostgreSQL +
  Prisma; Redis/BullMQ available (queues not used before Phase 10).
- The API surface is versioned at `/api/v1` (ADR-0005); the canonical contract is
  `docs/openapi.yaml`, which **already defines** the complete Phase 5 surface:
  `GET/POST /projects`, `GET/PATCH/DELETE /projects/{project_id}`,
  `GET/POST /projects/{project_id}/api-keys`,
  `DELETE /projects/{project_id}/api-keys/{api_key_id}`, with the `Project`,
  `ProjectCreate`, `ProjectUpdate`, `ApiKey`, `ApiKeyCreated`, `ApiKeyCreate`,
  `Environment`, `ProjectList`, and `ApiKeyList` schemas and the `SessionAuth` scheme.
  **No new endpoints are introduced by Phase 5** (ADR-0012); the spec refines
  descriptions in place where confirmed decisions affect them and must keep the
  contract Redocly-lint clean.
- All Phase 5 endpoints are **session-authenticated only** (phase 1 §7.3,
  api-conventions §3): API keys never carry organization- or project-management
  authority. The API-key authentication mode is built in this phase but first appears
  on Phase 6+ resource routes (`customers/*`, `payments/*`, …).
- Phase 1 §5.2 environment model: every project supports both `test` and `live`
  simulated environments; each environment-scoped resource (API key today; customers,
  payments, webhooks later) belongs to exactly one environment; TEST and LIVE data is
  never mixed. Environment is represented lowercase in the API (`test`/`live`),
  uppercase in UI copy (`TEST`/`LIVE`), and in the key prefix (`sk_test_…`/
  `sk_live_…`) — api-conventions §8.
- Phase 1 domain model: `Project` is "tenant-owned container for customers, payments,
  keys, webhooks"; `ApiKey` is "credential for API access, scoped to a project
  environment" (`sk_test_…`/`sk_live_…`, plaintext shown once at creation, stored
  hashed).
- ADR-0006 (binding): prefixed keys `sk_test_…`/`sk_live_…`; full key displayed **once**
  at creation; only a **hash** stored, **unique**; keys never appear in logs, error
  responses, or any artifact; one key = one project + environment; the definitive
  scheme (length, charset, hashing algorithm, lookup strategy) is **Phase 5's** job.
- Security baseline §5 maps "API key scheme (generation, hashing, lookup)" to Phase 5;
  baseline §1/§3 credential rules (shown once, hashed, never logged, scoped) bind.
- Phase 4 (complete): roles `owner`, `admin`, `member`, `viewer`; the role → capability
  matrix and the org-scoped RBAC guard (`SessionAuth` + `OrgRbacGuard`, capability
  registry extensible by Phases 5–13); non-member → **404 `NOT_FOUND`**, member without
  capability → **403 `FORBIDDEN`** (D1); cursor pagination helper; capability strings
  live in one shared location (`apps/api/src/organizations/roles.ts`).
- Phase 4 D9: organization deletion cascades the tenant-scoped rows existing in Phase 4
  (`organization_members`, `invitations`); it records the obligation to revisit when
  projects (Phase 5) and audit entries (Phase 12) exist. This phase resolves the
  projects side (D7).
- Repository state: Phase 4 is committed — `auth` module, `organizations` module,
  RBAC guard, cursor pagination, org UI. `apps/web` `projects` area is placeholder-only
  (`/dashboard/projects`, `/dashboard/projects/[projectId]`,
  `/dashboard/projects/[projectId]/api-keys` all render "arrives in Phase 5"). The
  `projects` and `api_keys` tables do not exist.
- Entity conventions (ADR-0011, phase 2): UUIDv7 IDs as PostgreSQL `uuid` (ADR-0001),
  `snake_case`, `created_at` on every record, `updated_at` on mutable records, UTC;
  application code supplies IDs and timestamps (no DB defaults).
- Errors: canonical envelope (phase 2 base); the generic codes cover Phase 5 — no new
  error codes are required.
- Rate limiting: all-route limits are Phase 13; Phase 5 adds none; the 429 responses in
  the contract remain inactive until then.
- Module boundaries (phase 1 §6.3): the `projects` and `api-keys` are domain concerns
  behind one cohesive module boundary; they own their persistence and must not reach
  into other modules' tables. API-key lookup is application-level authentication
  infrastructure shared by all API-key-authenticated routes.

## 4. API Application — `apps/api` (projects + api-keys)

### 4.1 Module purpose

Implement the projects surface (project CRUD, environment model) and the API-key
lifecycle (generation, hashing, listing, revocation, lookup) as domain modules
(`projects`, `api-keys` per phase 1 §6.3), plus the reusable pieces:

- **Project-scoped guard**: resolves a `project_id` from the path, loads the owning
  organization, resolves the caller's membership, evaluates the required capability,
  and attaches the resolved membership + project context to the request (D2/D3).
- **API-key authentication infrastructure**: hashing + lookup + revocation check
  service and the `ApiKeyAuth` guard mechanics consumed by Phase 6+ routes (D4, §4.5).

### 4.2 Endpoints

All endpoints already exist in `docs/openapi.yaml`; Phase 5 implements them against the
contract. Errors reuse the canonical envelope (§4.6).

#### `GET /projects` — `projects.list` (200)

- Session-authenticated. Returns the projects of **all organizations the authenticated
  user belongs to** (contract wording). No organization filter parameter exists.
- Cursor pagination (`limit`, `cursor`; `{ data, next_cursor, has_more }`, phase 1
  §7.5). Ordering derives from the time-ordered UUIDv7 IDs (shared cursor helper).
- No capability check required (the list is inherently scoped to the caller's
  memberships, mirroring `organizations.list`).

#### `POST /projects` — `projects.create` (201)

Domain rules:

1. Request body: `organization_id`, `name` (`ProjectCreate`).
2. **Authorization:** the caller must be a member of the target organization and hold
   `projects.create` (D3). A non-member receives **404 `NOT_FOUND`** (the organization
   is not visible to the caller — phase 4 D1 semantics); a member without the
   capability receives **403 `FORBIDDEN`**.
3. `name` is trimmed and validated: non-empty, ≤ 200 characters (DB `varchar(200)`,
   mirroring organization names, phase 4 D7). Names are **not unique** — project
   identity is the UUIDv7 ID.
4. A project supports both `test` and `live` environments by default; the MVP has no
   option to disable either (D6). `environments: ["test", "live"]` is derived, not
   stored.
5. Returns **201** with the `Project`. Any number of projects per organization is
   permitted in the MVP (no limit).

#### `GET /projects/{project_id}` — `projects.retrieve` (200)

Domain rules:

1. Project-scoped authorization: the caller must be a member of the owning organization
   and hold `projects.read` (D2/D3).
2. Non-member → **404 `NOT_FOUND`** (the project is not visible to the caller — same
   non-disclosure semantics as organizations); member without the capability → **403**.
3. Returns **200** with the `Project` (including the derived `environments` array).

#### `PATCH /projects/{project_id}` — `projects.update` (200)

Domain rules:

1. Requires `projects.update` (owner/admin — D3; the contract requires "an
   administrative role").
2. Request body: optional `name` (`ProjectUpdate`); validation bounds as create.
   Partial update semantics: only the provided field is changed; `name` is the only
   mutable attribute in the contract. `organization_id` and `environments` are
   immutable.
3. Non-member → **404**; member without permission → **403** (D2).
4. Returns **200** with the updated `Project`; `updated_at` advances.

#### `DELETE /projects/{project_id}` — `projects.delete` (204)

Domain rules:

1. Requires `projects.delete` (owner/admin — D3; the contract requires "an
   administrative role").
2. Non-member → **404**; member without permission → **403** (D2).
3. Deletion cascades the project's tenant-scoped rows: `api_keys` today; customers,
   payments, refunds, and webhook data in later phases (FK `ON DELETE CASCADE`).
4. All API keys of the project are implicitly revoked by deletion (their rows are
   deleted); already-issued plaintext key material becomes invalid because the lookup
   finds no row.
5. Returns **204**. Subsequent access to the project yields **404** for everyone.

#### `GET /projects/{project_id}/api-keys` — `apiKeys.list` (200)

Domain rules:

1. Requires `apiKeys.read` (available to every member role — D3).
2. Project-scoped authorization as in `projects.retrieve`; non-member → **404**;
   member without capability → **403**.
3. **Scope:** the list covers the whole project — both environments' keys — because the
   contract has no `environment` query parameter; each key carries its own
   `environment` value (D5). The contract's description says "of a project
   environment"; this phase resolves the ambiguity in favor of a project-wide list.
4. The list includes **active and revoked** keys; revoked keys are identified by a
   non-null `revoked_at` (D5). Cursor pagination applies.
5. Plaintext key material is **never** returned (only the `ApiKey` shape: `id`,
   `project_id`, `environment`, `created_at`, `revoked_at`).

#### `POST /projects/{project_id}/api-keys` — `apiKeys.create` (201)

Domain rules:

1. Requires `apiKeys.create` (owner/admin — D3).
2. Request body: `environment` (`ApiKeyCreate`), one of `test` or `live` (app-validated
   enum).
3. Generates a key for the requested environment (D4, §4.5), stores **only its hash**,
   and returns the plaintext exactly once in the response body (`ApiKeyCreated`, whose
   `key` field appears nowhere else) — ADR-0006.
4. Multiple active keys per project environment are permitted (required for rotation:
   a new key may be created while the old one is still in use — D1/D5).
5. Returns **201** with `ApiKeyCreated`: `{ id, project_id, environment, key,
   created_at }`. `key` is the `sk_test_…`/`sk_live_…` credential; the server never
   stores or returns it again.

#### `DELETE /projects/{project_id}/api-keys/{api_key_id}` — `apiKeys.revoke` (204)

Domain rules:

1. Requires `apiKeys.revoke` (owner/admin — D3; the contract requires "an
   administrative role").
2. The key must belong to the addressed project (cross-project `api_key_id`
   manipulation → **404 `NOT_FOUND`**, no disclosure).
3. Revocation sets `revoked_at`; the change is effective immediately — any subsequent
   API-key lookup for this key fails authentication.
4. **Idempotency:** revoking an already-revoked key → **204** (no-op, mirroring the
   phase 4 cancellation pattern). A non-existent key id → **404**.
5. Returns **204**, after which the key appears in `apiKeys.list` with `revoked_at`
   set; it can never be un-revoked.

#### Rotation (no dedicated endpoint — D1)

- The roadmap's "key rotation" is delivered as the workflow: create a new key
  (`apiKeys.create`) in the target environment, migrate usage, then revoke the old key
  (`apiKeys.revoke`). No rotation endpoint is added to the contract.
- The `apps/web` API-key page may offer a "rotate" action that runs create-then-revoke
  and displays the new plaintext key once (§5.2).

### 4.3 Role and permission model

**Roles** (fixed by phase 1 §4): `owner`, `admin`, `member`, `viewer`.

**Capabilities added by Phase 5** (extending the Phase 4 registry in the single shared
location, `apps/api/src/organizations/roles.ts`):

| Capability         | owner | admin | member | viewer | Note |
| ------------------ | :---: | :---: | :----: | :----: | ---- |
| `projects.read`    | ✓ | ✓ | ✓ | ✓ | View projects of the org |
| `projects.create`  | ✓ | ✓ | — | — | Create a project inside the org (D3) |
| `projects.update`  | ✓ | ✓ | — | — | Rename a project (contract: "administrative role") |
| `projects.delete`  | ✓ | ✓ | — | — | Delete a project (contract: "administrative role") |
| `apiKeys.read`     | ✓ | ✓ | ✓ | ✓ | View key metadata (never plaintext) |
| `apiKeys.create`   | ✓ | ✓ | — | — | Generate a new key (D3) |
| `apiKeys.revoke`   | ✓ | ✓ | — | — | Revoke a key (contract: "administrative role") |

The Phase 4 matrix stays intact; `org-rbac.guard` mechanics are reused unchanged for
routes whose path carries `organization_id`. Project routes instead use the
project-scoped guard (D2) with the same capabilities and the same 404/403 semantics.

### 4.4 Tenant isolation

- **Project-scoped routes** (`/projects/{project_id}…`): the guard resolves the project
  → owning organization → membership. A caller without membership in the owning
  organization receives **404** for every project route (project existence is not
  revealed — phase 4 D1 applied to projects). Cross-organization project/API-key-id
  manipulation is impossible because the project is resolved within the owning
  organization and the key must belong to the addressed project.
- **`projects.list`** derives scope from the caller's memberships; **`projects.create`**
  verifies membership in the target `organization_id` from the body.
- IDOR prevention (acting on another organization's project, or another project's key)
  is a first-class test concern (§9).
- Projects are **not** environment-scoped themselves; their environment-scoped
  resources (API keys) are, and TEST/LIVE data is never mixed (§4.5).

### 4.5 API key scheme, hashing, and lookup (ADR-0006 detail — D4)

**Generation**

- Random section: 32 bytes from a cryptographically secure PRNG (256 bits of entropy).
- Serialization: unpadded base64url (43 characters).
- Final format: `sk_test_<43 chars>` / `sk_live_<43 chars>` (the environment prefix
  makes TEST/LIVE confusion visible — ADR-0006).
- The full credential is ~53 characters. It is never persisted in plaintext and never
  logged.

**Hashing**

- One-way: **SHA-256**, single pass, hex digest (64 characters), stored in a `varchar`
  column with a **unique** constraint (D5).
- Rationale (verify at confirmation): the key material has 256 bits of entropy, so a
  fast hash is appropriate; no slow KDF (Argon2) is needed — that is reserved for
  low-entropy secrets such as passwords (ADR-0007). If the product authority prefers
  HMAC-SHA256 with a server secret (defense-in-depth against rainbow tables), record it
  as an ADR before implementation.
- The hash digest is not a secret and never needs client-facing exposure.

**Storage uniqueness**

- `key_hash` unique across all rows. Multiple **active** keys per (project, environment)
  are allowed; "unique per project environment" (ADR-0006) is satisfied by the global
  unique hash column combined with the permission rules for creation (D5).

**Lookup / verification (the API-key authentication infrastructure)**

- Input: `Authorization: Bearer <key>` (api-conventions §3, `ApiKeyAuth` scheme).
- Procedure: parse the bearer token → compute SHA-256 → look up `api_keys` by
  `key_hash` → if no row or `revoked_at` is set → **401 `UNAUTHENTICATED`** (generic,
  no disclosure of whether the key exists or was revoked).
- On success the request is scoped to the key's **(project, environment)**: resource
  routes derive the environment from the key and reject payload/query environments that
  do not match (contract wording on each Phase 6+ endpoint).
- The `ApiKeyAuthGuard` ships in this phase with unit/integration tests; it has **no
  HTTP consumer until Phase 6** (customers) because the contract assigns
  API-key-authenticated routes to later phases. It is not usable for the session-only
  Phase 5 routes (`projects/*`, `api-keys/*`).
- Constant-time comparison is not required for the hash-equality lookup (the token is
  high-entropy; DB equality on the hash is the lookup mechanism).

**Revocation**

- `revoked_at` set by `apiKeys.revoke`; the lookup treats a revoked row as
  unauthenticated immediately.

### 4.6 Errors

Reuse the canonical envelope (phase 2 base). No new error codes are required:

| Case                                   | Status | Code                      |
| -------------------------------------- | ------ | ------------------------- |
| Validation failure (name bounds, environment enum, malformed id) | 400 | `VALIDATION_ERROR` |
| Not authenticated                      | 401    | `UNAUTHENTICATED`         |
| Member without required permission     | 403    | `FORBIDDEN`               |
| Non-member / unknown project / unknown key / hidden resource | 404 | `NOT_FOUND` |
| Throttled (reserved; effective in Phase 13) | 429 | `RATE_LIMITED`        |
| Unexpected                             | 5xx    | `INTERNAL_ERROR`          |

Messages are generic where security demands it (non-member access, revoked-key
authentication) and never leak key material or internals.

## 5. Web Application — `apps/web` (project and API-key UI)

Replace the Phase 2/4 placeholders in the project area (routes already documented in
`docs/web-application-structure.md` §4). `apps/web` remains a client of the API: no
parallel backend, no duplicated domain rules; the API is the enforcement point and role
-based UI presentation matches the capability matrix (§4.3).

### 5.1 Project management UI (`/dashboard/projects`)

- **Project list:** lists the caller's projects across their organizations
  (`projects.list`), showing the owning organization and the `TEST`/`LIVE` environment
  badges; links to the project shell.
- **Create:** form with an organization selector (from `organizations.list`) and a
  project name (`projects.create`).
- **Manage (owner/admin only, per matrix):** rename (`projects.update`) and delete
  (`projects.delete`) with confirmation, exposed on the project shell (5.3) or list
  entries. Non-privileged roles simply do not see the controls.
- Already-established loading/error/empty states and the client-side `403` mapping
  patterns from Phase 4 apply.

### 5.2 API key management UI (`/dashboard/projects/[projectId]/api-keys`)

- **List:** shows all keys of the project (`apiKeys.list`) grouped or badged by
  `test`/`live`, with creation date and revoked state. Key material is never shown —
  only the metadata the contract returns.
- **Create:** select an environment → `apiKeys.create` → the returned plaintext key is
  shown **exactly once** with a copy button and a clear warning that it will not be
  shown again; the server never returns it later. Creation is offered to owner/admin
  only.
- **Revoke (owner/admin):** `apiKeys.revoke` with confirmation; revoked keys are
  displayed as revoked and cannot be re-enabled.
- **Rotate (owner/admin):** a "rotate" action runs create-then-revoke (D1); the new
  plaintext key is displayed once after creation.
- A non-member reaching this page sees the not-found state (project access semantics,
  §4.2).

### 5.3 Environment selection UI (project shell)

- `/dashboard/projects/[projectId]` is the project shell: project name, owner/admin
  rename/delete controls, and the **environment selector** (`TEST`/`LIVE`). The
  selector is the presentation of phase 1 §5.2: environment-scoped child pages
  (customers, payments, logs — Phases 6+) operate on the selected environment. In this
  phase the selector is persisted as UI state (query parameter or client state); the
  API-key page lists both environments regardless of the selection because the contract
  list is project-wide (D5).
- Non-member access → not-found state.

### 5.4 Boundaries

- The dashboard shell, overview, settings, and organization UI are untouched.
- No shared packages are created (no concrete reuse need yet, master specification).
- Full dashboard polish and responsive layout remain Phase 14.

## 6. Data Requirements

Tables are added by Phase 5 via the committed-migration workflow (ADR-0011), applying
the fixed conventions (UUIDv7 stored as `uuid`; `snake_case`; `created_at` on every
record; `updated_at` on mutable records; UTC; application-supplied IDs/timestamps).

### 6.1 `projects` (new table)

| Column            | Type                    | Constraints / notes                                                            |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `id`              | `uuid`                  | PK; UUIDv7 (ADR-0001).                                                          |
| `organization_id` | `uuid`                  | FK → `organizations.id` **`ON DELETE CASCADE`** (D7). Indexed.                  |
| `name`            | `varchar(200)`          | Trimmed, non-empty (app-validated); not unique.                                 |
| `created_at`      | `timestamptz`           | UTC.                                                                             |
| `updated_at`      | `timestamptz`           | UTC; advanced by `projects.update`.                                             |

The `test`/`live` environments are **not** stored — a project always supports both in
the MVP (D6); the `environments` array in the API is derived by the service.

### 6.2 `api_keys` (new table)

| Column            | Type                    | Constraints / notes                                                            |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `id`              | `uuid`                  | PK; UUIDv7. The credential entity ID, **not** the credential material.          |
| `project_id`      | `uuid`                  | FK → `projects.id` **`ON DELETE CASCADE`**. Indexed.                            |
| `environment`     | `varchar(20)`           | `test` or `live`; app-validated (phase 4 D10 pattern).                          |
| `key_hash`        | `varchar(64)`           | SHA-256 hex digest of the credential; **unique** constraint (D5); never logged. |
| `revoked_at`      | `timestamptz` (nullable)| Set by `apiKeys.revoke`; null while active.                                     |
| `created_at`      | `timestamptz`           | UTC.                                                                             |

No `updated_at` — the API key is immutable apart from revocation, which is carried by
`revoked_at` (matching the contract's `ApiKey` schema, which has no `updated_at`).
No `last_used_at` and no key label/description (not in the contract; do not invent).

### 6.3 Migration and integrity

- One committed migration (or a small set) on top of the Phase 4 schema: creates
  `projects` and `api_keys`, adds `projects` → `organizations`, `api_keys` → `projects`
  FK cascades, indexes, and the unique `key_hash` constraint.
- Prisma schema update: add `Project` and `ApiKey` models; extend `Organization` with
  `projects Project[]`. The `ApiKey.environment` and revoked semantics remain validated
  at the application boundary.
- Atomicity: `projects.create` (single insert), `projects.delete` (single delete with
  DB cascade), `apiKeys.create` (single insert), `apiKeys.revoke` (single update) are
  naturally atomic; no multi-row transactions are required in Phase 5.
- No seed data, no secrets, no credentials in migrations.

## 7. Security Requirements

1. **Credential generation:** API keys are generated from a CSPRNG with 256 bits of
   entropy; never derived from predictable input; format `sk_test_…`/`sk_live_…`
   (ADR-0006, D4).
2. **At-rest protection:** only the SHA-256 hash is stored (D4); the plaintext appears
   exactly once in the create response and nowhere else (ADR-0006); no recovery path —
   loss requires rotation.
3. **Secrets in logs/errors:** keys, key hashes, and `Authorization` headers are never
   written to logs, request logs, audit data, or error responses; error messages never
   contain key material.
4. **Revocation:** revocation is effective immediately for authentication; a revoked key
   yields a generic **401** (no state disclosure). Keys of a deleted project are gone
   with it (cascade).
5. **Tenant isolation / IDOR:** project-scoped guard (§4.4) with phase 4 D1 semantics
   (non-member → 404); cross-organization project access and cross-project key access
   are first-class test concerns; ID opacity is not a security control.
6. **RBAC:** every Phase 5 route declares a capability; the API (not the UI) is the
   enforcement point; capability registry extensions live in the single shared matrix.
7. **Environment isolation:** a key identifies exactly one (project, environment); the
   derived authentication scope can never cross environments; TEST/LIVE data is never
   mixed (enforced at lookup and consumed by Phase 6+ routes).
8. **Input validation:** name bounds (trim, non-empty, ≤ 200), `environment` enum,
   UUID format for path IDs (malformed ids → 404 non-disclosure per the Phase 4 guard
   pattern).
9. **Session-only management surface:** `projects/*` and `api-keys/*` accept sessions
   only; API-key authentication never gains management authority (phase 1 §7.3).
10. **No new secrets in configuration:** key hashing needs no server secret; if HMAC is
    preferred, record an ADR and add the required configuration explicitly.
11. **Contract hygiene:** OpenAPI descriptions updated in place (ADR-0012) and kept
    lint-clean; the `apiKeys.create` description documents the once-only display and
    the hashing-at-rest guarantee.

## 8. Acceptance Criteria

1. All Phase 5 roadmap checkboxes (§2) are implemented and traced (§11).
2. `POST /projects` creates a project in the caller's organization (caller is a member
   and holds `projects.create`); `GET /projects` lists exactly the projects of the
   caller's organizations with cursor pagination; retrieve/update/delete behave per the
   capability matrix.
3. Project routes enforce phase 4 D1 semantics: a non-member of the owning organization
   receives **404 `NOT_FOUND`** for `GET/PATCH/DELETE /projects/{project_id}` and the
   `api-keys` routes; a member without the required capability receives **403
   `FORBIDDEN`** — verified per endpoint and per role.
4. The capability matrix (§4.3) is enforced: `projects.create/update/delete` and
   `apiKeys.create/revoke` are owner/admin-only; `projects.read` and `apiKeys.read` are
   available to every member role.
5. `PATCH /projects/{project_id}` updates only `name` (`organization_id` and
   `environments` are immutable); `updated_at` advances. `DELETE /projects/{project_id}`
   → **204**, cascades the project's `api_keys`, and subsequent access → **404**.
6. `POST /projects/{project_id}/api-keys` returns **201** whose body contains the
   plaintext key (`sk_test_…`/`sk_live_…`) exactly once; `apiKeys.list` never includes
   plaintext; the stored row contains only the unique hash; the key can never be
   recovered through any endpoint or log.
7. `apiKeys.list` returns keys of **both** environments with per-key `environment`,
   includes revoked keys with `revoked_at` set, and paginates per the contract.
8. `DELETE /projects/{project_id}/api-keys/{api_key_id}` → **204**, sets `revoked_at`,
   is idempotent for already-revoked keys (**204**), and rejects cross-project key ids
   and unknown ids with **404**. A revoked key fails the lookup path with **401**
   (generic).
9. API-key authentication infrastructure (D4): generation format/entropy, SHA-256
   hashing, hash lookup, and revocation rejection behave as specified; the guard works
   without an HTTP consumer (tested at unit/integration level until Phase 6) and is
   ready to scope requests to (project, environment).
10. Tenant isolation: a member of organization A receives **404** for every project
    route of organization B (including through `project_id` or `api_key_id`
    manipulation); a project of org B never appears in the caller's `projects.list`.
11. `projects` / `api_keys` tables exist with the specified columns, FK cascades, and
    unique `key_hash`; organization deletion now cascades projects and their keys (D7);
    `prisma migrate deploy` applies the migration in CI and clean environments.
12. API responses match the contract; `docs/openapi.yaml` descriptions are refined in
    place (permission rules, key scheme, list scope, rotation semantics) and remain
    Redocly-lint clean with no parallel contract (ADR-0012).
13. `apps/web` implements §5: project list + create; project shell with TEST/LIVE
    environment selector and rename/delete (owner/admin); API-key page with list,
    once-only create display, revoke, and rotate (owner/admin); role-based UI matches
    the matrix; non-members see the not-found state.
14. No key material, key hash, or `Authorization` header value appears in logs, request
    logs, error responses, or UI state beyond the documented once-only display.
15. All repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
    `pnpm test:e2e`, `pnpm build`, locally and in CI.

## 9. Testing Requirements

### 9.1 API (`apps/api`)

- **Unit tests:**
  - Key scheme: format (`sk_test_`/`sk_live_` prefixes), random-section length and
    entropy source, charset (unpadded base64url), total length; generate many keys and
    assert uniqueness.
  - Hashing: SHA-256 hex length/format; deterministic for the same input; never returns
    the plaintext; hash column uniqueness enforced at the DB layer.
  - Lookup service: found/not-found/revoked cases; revoked → unauthenticated; no state
    disclosure in the error.
  - Capability matrix: the seven Phase 5 (role, capability) pairs resolve as specified
    (§4.3); existing Phase 4 pairs unchanged.
  - Project guard: resolves project → organization → membership; non-member → 404;
    member without capability → 403; attaches project context; malformed `project_id`
    → 404 (non-disclosure).
  - Project service: create (name bounds, derived environments), update (name-only,
    `updated_at`), delete (cascade), retrieve.
  - API-key service: create (environment enum, hash stored, plaintext returned once),
    list (project-wide, both environments, revoked included, pagination), revoke
    (sets `revoked_at`, idempotent no-op, cross-project/unknown → 404).
- **Integration/e2e (`test:e2e`) against the running app with real PostgreSQL/Redis**
  (CI service containers):
  - register → default org → create project → appear in `projects.list` (Phase 3/4
    back-compat).
  - projects: create/retrieve/update/delete flows; permission checks per role; create
    in an org the caller does not belong to → **404**; member-without-capability →
    **403**.
  - api keys: create (201, plaintext once; subsequent list/retrieve carry no `key`),
    list (both envs, revoked included, pagination, never plaintext), revoke (204 +
    idempotent 204 + 404 for unknown/cross-project), environment enum validation.
  - Tenant isolation/IDOR suite: user A (member of org 1) against org 2's projects and
    keys → **404** for every route; `api_key_id` of another project → **404**;
    `projects.list` never contains org 2's projects.
  - API-key authentication infrastructure: service/guard-level integration tests for
    active vs revoked lookup (first HTTP consumer arrives in Phase 6).
  - Migrations apply cleanly (`prisma migrate deploy` step in CI, phase 2 workflow).
- **Web (`apps/web`):**
  - Unit: project list/create page; project shell (environment selector state; rename/
    delete controls per role); API-key page states (list rendering with env badges;
    create revealing the key once; revoke/rotate confirmations); not-found state for
    non-members.
  - E2e (`test:e2e`): extend the established smoke pattern — a scripted single-user flow
    (create project, rename, list; create API key and assert the plaintext is shown once
    and never again; revoke key and assert the revoked state). Full browser e2e remains
    Phase 17.

### 9.2 Shared

- All checks run from the repository root (`pnpm -r …`) and in CI.
- Tests require no secrets; test config uses `.env.example`-style defaults; test data
  uses generated UUIDv7, unique project names, and randomly generated keys.
- Assertions that key material never reaches logs: exercise logging paths on create
  (the create response body contains the key, but structured request logs must not).

## 10. Definition of Done

Phase 5 is complete when:

- All roadmap checkboxes in §2 are implemented and traced (§11).
- All acceptance criteria in §8 pass.
- All checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D7 are confirmed by the product authority; architecture-level policy
  (API-key hashing scheme in particular) is recorded as an ADR where appropriate, and
  confirmed decisions are recorded in §14.
- `docs/openapi.yaml` is consistent with the confirmed decisions, describes the key
  scheme/rotation/list-scope semantics, and lints clean (ADR-0012) — no parallel
  contract.
- No security-relevant issue remains open: keys are generated from a CSPRNG, stored
  hashed with a unique constraint, shown once, never logged; revocation is immediate;
  project-scoped routes enforce tenant isolation with 404/403 semantics; the capability
  registry is the single authorization boundary for project routes.
- Coordination obligations are recorded: Phase 6 reuses the API-key authentication
  infrastructure (first HTTP consumer) and the cursor pattern; organization deletion
  now cascades projects and keys (D7); Phase 5's environment model binds Phases 6–10.
- Phase 6 (Customers) can start without re-opening Phase 5 decisions.

## 11. Traceability (Roadmap → Phase 5)

| Roadmap Phase 5 checkbox                  | Specification reference            |
| ----------------------------------------- | ---------------------------------- |
| Projects CRUD                             | §4.2, §6.1, §8.2–8.5                |
| TEST vs LIVE environment separation       | §3, §4.2, §4.5, §5.3, §6, §7.7      |
| API key generation                        | §4.5 (D4), §6.2, §8.6, §8.9         |
| Key rotation                              | §4.2 (rotation workflow), D1, §5.2  |
| Key revocation                            | §4.2 (`apiKeys.revoke`), §4.5, §8.8 |
| Project management UI                     | §5.1, §8.13                          |
| API key management UI                     | §5.2, §8.13                          |
| Environment selection UI                  | §5.3, §8.13                          |

## 12. Implementation Considerations

- **Project-scoped guard (D2):** extend the Phase 4 guard pattern instead of a parallel
  authorization model. The existing `OrgRbacGuard` reads `organization_id` from the
  path; project routes need the indirection project → organization. Implement a
  project-scoped guard in the `projects` module (or a small shared application-level
  guard) that resolves the owning organization, reuses the same membership lookup, the
  same capability evaluation, and the same 404/403 semantics, and attaches both
  membership and project context. Keep the capability registry in the single shared
  location (`roles.ts`).
- **`projects.create` authorization:** the organization id arrives in the request body,
  not the path; resolve membership against the body value with the same 404/403
  semantics (or reuse the guard with a declared "organization from body" source), so no
  route bypasses the capability check.
- **API-key scheme as an ADR-worthy decision (D4):** the hashing algorithm (recommended
  SHA-256 single-pass) and format details finalize ADR-0006's open items; record the
  confirmed scheme as an ADR (e.g., ADR-0014) when confirmed, with the
  implementation-local constants (random-section length, charset) derived from it.
- **Migration:** one committed migration creating `projects` and `api_keys` (FK
  cascades, unique `key_hash` index). Follow the Phase 4 pattern: raw SQL only where
  Prisma cannot express the constraint; verify `prisma migrate dev`/`deploy`
  round-trips in CI.
- **Derived `environments`:** the API `environments` array is always `["test", "live"]`
  in the MVP (D6); compute it in the service mapper — do not model it in the schema.
- **API-key auth infrastructure:** implement the hash/lookup primitives and the guard
  without an HTTP consumer; cover with unit and integration tests. Phase 6 wires the
  first `ApiKeyAuth`-accepting routes (customers) and validates the environment-match
  rule end-to-end.
- **UI routes and documentation:** populate the existing placeholder routes
  (`/dashboard/projects`, `/dashboard/projects/[projectId]`,
  `/dashboard/projects/[projectId]/api-keys`); update
  `apps/web/lib/brinnpay/client.ts` with the project/API-key functions (thin fetch
  wrapper over the contract). `docs/web-application-structure.md` already documents the
  routes; refresh §4 only if the environment-selector behavior adds detail.
- **OpenAPI refinements (in place, ADR-0012):** refine the `projects.*` and `apiKeys.*`
  operation descriptions (permission rules, key scheme and once-only display, list
  scope covering both environments, rotation semantics, idempotent revocation); keep
  the file lint-clean. No endpoint additions.
- **Coordination with Phase 6+:** customers/payments/webhooks are environment-scoped
  and accept API-key **or** session auth; their route environment derivation from the
  key's scope is defined here (§4.5) and consumed later. The cursor list pattern
  introduced in Phase 4 generalizes to `projects.list` and `apiKeys.list`.
- **Coordination with Phase 4 (D9):** organization deletion cascades projects — update
  the `organizations.delete` contract description in place ("organization_members,
  invitations cascade" → include projects). Phase 12 revisits audit entries.
- **Anti-goals:** no environment toggling (both always enabled — D6), no key naming/
  metadata, no per-key scopes/permissions, no key-expiry dates, no rate limiting
  (Phase 13), no audit logging of key events (Phase 12), no webhook/payment coupling,
  no API-key-authenticated routes in this phase.

## 13. Out of Scope

- Customers, payments, refunds, and webhook modules and their API-key-authenticated
  routes (Phases 6–10) — although they depend on this phase's project-scoped guard and
  API-key authentication infrastructure.
- Idempotency records (Phase 8), request logs (Phase 11), audit logs (Phase 12),
  all-route rate limiting (Phase 13).
- Environment toggles (disabling `test` or `live` per project), per-key scopes,
  permissions, expiration, usage reporting, or key labels (not in the contract).
- Recovery of a lost API key (impossible by design; rotation covers it).
- Organization or project bulk operations, project archival, moving a project between
  organizations, and per-project member lists (the org is the membership boundary).
- Platform-administrator functionality (ADR-0009) and end-user/customer-facing areas
  (ADR-0008).
- Full dashboard polish, responsive layout, and browser e2e tooling (Phases 14, 17).
- Real payment processing, billing, SSO, microservices (master specification).

## 14. Decisions

> **Pending product-authority confirmation (2026-09-23).** The recommendations below
> ([rec]) are the smallest solutions consistent with the canonical contract and prior
> phases. Phase 5 is not ready for implementation until D1–D7 are confirmed.
> Architecture-level outcomes (notably D4's hashing scheme) become ADRs on confirmation.

| #   | Decision                                              | Recommended option [rec] / alternatives                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Key rotation mechanism                                | **[rec]** Rotation is a **workflow** (create new + revoke old) with no dedicated endpoint — the canonical contract has none, and the roadmap's "key rotation" is satisfied by the two existing operations. The UI offers a "rotate" action. Alternatives: add a rotation endpoint (contract expansion, rejected under ADR-0012 until justified); server-side key versioning (overkill for the MVP). |
| D2  | Project-route authorization model                     | **[rec]** Extend the Phase 4 guard pattern with a **project-scoped guard** (project → owning organization → membership → capability) reusing the same 404/403 non-disclosure semantics; `projects.list` derives scope from memberships; `projects.create` checks the body's `organization_id`. Alternatives: a parallel ad-hoc guard per route (drift risk); moving `organization_id` into every project path (contract change, rejected). |
| D3  | Phase 5 capability matrix                             | **[rec]** `projects.read` and `apiKeys.read` → all roles; `projects.create/update/delete` and `apiKeys.create/revoke` → owner+admin (create of projects/keys is an administrative action; the contract requires "an administrative role" for update/delete/revoke). Alternatives: let `member` create projects/keys (members are "development/operational", but credentials are management-scoped); restrict `apiKeys.read` to owner/admin (unnecessary — only hashes and metadata are returned). |
| D4  | API key scheme (finalizes ADR-0006)                   | **[rec]** Random section = 32 bytes CSPRNG, unpadded base64url; key = `sk_test_<43>`/`sk_live_<43>` (~53 chars total, 256-bit entropy); stored as **SHA-256** hex (unique `varchar(64)`); lookup by hash. Alternatives: HMAC-SHA256 with a server-side secret (defense-in-depth, extra config + secret management — extra ADR before implementation); Argon2id (unnecessary for high-entropy keys); hex encoding (longer keys). |
| D5  | API-key list scope, uniqueness, and revoked keys      | **[rec]** `apiKeys.list` is **project-wide** (both environments, per-key `environment`) because the contract has no environment filter; the list **includes revoked keys** (non-null `revoked_at`) so rotation history is visible; **multiple active keys per environment are allowed** (required for rotation) with a global unique `key_hash`. Alternatives: filter the list by environment (contract expansion); hide revoked keys (loss of rotation history); one key per environment (blocks rotation grace periods). |
| D6  | `environments` field representation                   | **[rec]** Both environments are always available (`["test", "live"]`), computed by the service, not stored, with no disable option in the MVP — matching the contract's `ProjectCreate` note ("no option to disable either"). Alternatives: a stored enable/disable flag (contract expansion, deferred). |
| D7  | Organization-deletion interaction with projects (phase 4 D9) | **[rec]** `DELETE /organizations/{organization_id}` **cascades** projects and therefore their API keys (FK `ON DELETE CASCADE`), extending the Phase 4 cascade model to tenant-scoped business data. Alternatives: block organization deletion while projects exist (422) — heavier, no contract basis; soft-delete projects (orphaning, rejected). |

> **Consistency check with prior phases:** none of the proposed decisions contradicts the
> master specification, Phases 1–4, or ADRs 0001–0013. D1 interprets the roadmap's
> "key rotation" within the existing contract. D2 reuses the phase 4 D1/§4.3 guard
> semantics for a route family the contract already defines. D3 extends the phase 1 §4
> role definitions and the phase 4 capability registry. D4 is the Phase 5 detail
> ADR-0006 explicitly deferred; the key format/prefixed environments remain exactly as
> ADR-0006 and phase 1 §5.2 fix. D5 follows from the contract's list parameters and the
> rotation requirement. D6 matches the contract's `ProjectCreate` and `Project`
> schemas. D7 resolves the phase 4 D9 coordination obligation consistently with the
> established cascade model.

## 15. Dependencies

- Inputs: Phase 4 (RBAC guard/capability registry, cursor helper, 404/403 semantics,
  `organizations` module), Phase 3 (session auth, `organizations` base tables via
  registration), Phase 2 base (error envelope, request IDs, DTO validation, Prisma
  migration workflow, CI service containers), phase 1 artifacts and ADRs 0001–0013,
  `docs/openapi.yaml` projects/api-keys surface.
- Blocks: Phase 6 (Customers) — its routes live under `/projects/{project_id}` and its
  `ApiKeyAuth` mode consumes this phase's lookup infrastructure; Phases 7–10 and the
  Phase 11/12 project-scoped log surfaces stand on the same project guard and
  environment model.
- Coordination obligations out of this phase:
  - Phase 6: first HTTP consumer of the API-key authentication infrastructure;
    environment-match rule validated end-to-end; cursor pattern generalization.
  - Phase 4 (D9): organization deletion now cascades projects and keys; contract
    description updated in place.
  - Phase 12: audit entries reference organizations; deletion interaction re-reviewed.
  - Phase 13: activates the 429 responses present on Phase 5 endpoints.
  - Phase 14: completes project-area UI polish; Phase 17 adds browser e2e.