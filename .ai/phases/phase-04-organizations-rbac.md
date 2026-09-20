# Phase 4 — Organizations & RBAC

|                   |                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------- |
| Phase             | 4                                                                                      |
| Name              | Organizations & RBAC                                                                   |
| Status            | **Ready — decisions D1–D10 confirmed by the product authority (2026-09-20)**           |
| Depends on        | Phase 3 (complete)                                                                    |
| Blocks            | Phase 5 (Projects & API Keys) and all subsequent phases                               |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 4                                              |

---

## 1. Objective

Enable multi-tenancy with organization management and role-based access control:

- Users can create, retrieve, update, and delete **organizations** (tenants). Every
  registered user already has a personal/default organization created at registration
  (ADR-0010, Phase 3 D4/D5).
- Users can manage **membership** (roles, removal) and **invitations** (invite, list,
  cancel, accept) so that multiple users can collaborate within one organization.
- A **permission system** (`owner`, `admin`, `member`, `viewer`) is defined and enforced
  per route and per resource — as **reusable infrastructure** for every later phase
  (projects, API keys, customers, payments, …).
- **Tenant isolation** is implemented and tested: data access is always scoped by
  organization membership; IDOR is a first-class test concern.
- `apps/web` provides the **organization management UI**, the **member and role
  management UI**, and an **invitation accept flow**.

Phase 4 delivers the `organizations` domain module of the API (organization, membership,
and invitation management; RBAC guard) and the organization area of `apps/web`. It
extends the Phase 3 base tables (`organizations`, `organization_members`) and introduces
the `invitations` table via the committed-migration workflow (ADR-0011).

## 2. Scope

In scope (mapped to the Phase 4 roadmap checkboxes):

| Roadmap checkbox                         | Specification reference                |
| ---------------------------------------- | -------------------------------------- |
| Organizations CRUD                       | §4.2 (list/create/retrieve/update/delete) |
| Member management (invite, remove)       | §4.2 (members, invitations)            |
| Role definitions (owner, admin, member, viewer) | §4.3, D3/D4                  |
| Permission system                        | §4.3, D2/D3                             |
| Tenant isolation (data scoping)          | §4.4, D1                                |
| Organization management UI in `apps/web` | §5.1                                    |
| Member and role management UI            | §5.2                                    |

Required to keep the phase self-consistent (see §3):

- The **org-scoped RBAC guard** as reusable authorization infrastructure for Phases 5–13
  (parallel to the `SessionAuth` guard for authentication).
- **Cursor pagination** on the three organization list endpoints
  (`organizations.list`, `organizations.listMembers`,
  `organizations.listInvitations`) — the OpenAPI contract already requires it
  (phase 1 §7.5); the pattern becomes the shared reference for Phase 6.
- The **invitation accept flow** for users who are not yet members (the only Phase 4
  endpoint a non-member can use). Without it, invitations are unusable.

## 3. Context

Constraints reused from the master specification, Phases 1–3, and ADRs (all binding):

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`); PostgreSQL +
  Prisma; Redis available (rate limiting for org endpoints arrives in Phase 13).
- The API surface is versioned at `/api/v1` (ADR-0005); the canonical contract is
  `docs/openapi.yaml`, which **already defines** the complete Phase 4 surface (`GET/POST
  /organizations`, `GET/PATCH/DELETE /organizations/{organization_id}`,
  `GET /organizations/{organization_id}/members`,
  `PATCH/DELETE /organizations/{organization_id}/members/{user_id}`,
  `GET/POST /organizations/{organization_id}/invitations`,
  `DELETE /organizations/{organization_id}/invitations/{invitation_id}`,
  `POST /invitations/{invitation_id}/accept`) with the `SessionAuth` scheme and the
  `Organization` / `OrganizationMember` / `Invitation` / `Role` (`owner`, `admin`,
  `member`, `viewer`) schemas. Phase 4 refines descriptions in-place where decisions
  affect them (D1, D3–D5, D8) and must keep the contract Redocly-lint clean (ADR-0012).
  **No new endpoints are introduced by Phase 4.**
- All Phase 4 endpoints are **session-authenticated** (`SessionAuth`). API keys
  (Phase 5) never carry organization-management authority (phase 1 §7.3); Phase 4
  implements **session-only** org management.
- Phase 3 (D4) created the minimal `organizations` / `organization_members` tables, seeded
  only via registration (`owner` membership, ADR-0010). Phase 4 **owns their extension**
  (roles beyond `owner`, invitations, validation, UI) and must build on them via
  migrations — no re-defined tables, no parallel Prisma models (Phase 3 §13, ADR-0011).
- Roles (phase 1 §4): `owner` (full administrative authority), `admin` (manages members,
  projects, keys), `member` (development/operational permissions), `viewer` (read-only).
  RBAC is enforced **per route and per resource** (security baseline §1); the web
  application never bypasses API-level authorization (phase 1 §11.4).
- Tenant isolation (phase 1 §6.4, security baseline §4): a user may only access resources
  of organizations they belong to. ID opacity (ADR-0001) is **not** a security control.
- Rate limiting: applied to auth endpoints from Phase 3 only; **all-route rate limiting is
  Phase 13** (phase 1 §10, security baseline §5). Phase 4 adds no rate limiting; the 429
  responses already present in the contract for org endpoints become effective in Phase 13.
- Entity conventions (ADR-0011, phase 2): UUIDv7 IDs as PostgreSQL `uuid` (ADR-0001),
  `snake_case`, `created_at` on every record, `updated_at` on mutable records, UTC.
  `organization_members` currently lacks `updated_at` (it was created minimally in
  Phase 3); role changes make it mutable, so Phase 4 adds the column by migration.
- Email normalization (Phase 3 D8): emails are stored trimmed + lowercased. Invitation
  emails must follow the same normalization for reliable matching.
- No email delivery of any kind exists in the MVP (Phase 3 out-of-scope). The invitation
  flow must therefore work without email (D6).
- Module boundaries (phase 1 §6.3): the `organizations` domain module owns organization,
  membership, and invitation persistence and rules. Cross-cutting capabilities
  (request IDs, logging, validation) are applied app-wide by the Phase 2 base.
- Repository state: Phase 3 is committed — `auth` module, session guard, rate limiting for
  auth endpoints, register/login/refresh/logout/me, `/login` + `/register` UI, session
  handling, base schema with `users`, `refresh_sessions`, `organizations`,
  `organization_members`. The `organizations` module, the invitations table, and the
  org UI **do not exist yet** (`apps/web/app/(dashboard)/dashboard/organizations` is a
  placeholder).

## 4. API Application — `apps/api` (organizations module)

### 4.1 Module purpose

Create the `organizations` domain module owning: organizations (tenant boundary),
memberships (roles), invitations, the **role → permission model**, and the reusable
org-scoped RBAC guard. The module owns its persistence (`organizations`,
`organization_members`, `invitations`) and must not reach into other modules' tables.

The RBAC guard is phase infrastructure for all session-authenticated org-scoped routes:
it resolves the caller's membership in the organization addressed by the request and
evaluates the required capability (D2). Later phases (5–13) extend the capability set but
reuse the same guard and matrix model.

### 4.2 Endpoints

All endpoints already exist in `docs/openapi.yaml`; Phase 4 implements them against the
contract, refining descriptions in place where the confirmed decisions require it.
Error handling reuses the canonical envelope (§4.6).

#### `GET /organizations` — `organizations.list` (200)

- Session-authenticated. Returns the organizations the authenticated user belongs to.
- Cursor pagination (`limit`, `cursor`; response `{ data, next_cursor, has_more }`,
  phase 1 §7.5). Ordering derives from the time-ordered UUIDv7 IDs.
- Non-member visibility is impossible by construction (the list is scoped to the caller's
  memberships).

#### `POST /organizations` — `organizations.create` (201)

Domain rules:

1. Request body: `name` (`OrganizationCreate`, D7).
2. `name` is trimmed and validated: non-empty, ≤ 200 characters (DB `varchar(200)`).
   Names are **not globally unique** — organization identity is the UUIDv7 ID.
3. On success (single transaction): create the `Organization` and the creator's `owner`
   membership. The creator is always the initial `owner` (mirrors Phase 3 D5 naming and
   ADR-0010 semantics for additional orgs).
4. Returns **201** with the `Organization`.
5. A user may create any number of organizations (no limit in the MVP).

#### `GET /organizations/{organization_id}` — `organizations.retrieve` (200)

Domain rules:

1. Session-authenticated; accessed through the org-scoped RBAC guard requiring
   `organizations.read` (D3).
2. Non-member → **404 `NOT_FOUND`** (the organization is not visible to the caller);
   member → **200** with the `Organization` (D1).

#### `PATCH /organizations/{organization_id}` — `organizations.update` (200)

Domain rules:

1. Requires `organizations.update` (owner, admin — D3).
2. Request body: optional `name` (`OrganizationUpdate`); validation bounds as create
   (D7). Partial update semantics: only the provided field is changed. `name` is the only
   mutable attribute in the contract.
3. Non-member → **404**; member without permission → **403 `FORBIDDEN`** (D1).
4. Returns **200** with the updated `Organization`; `updated_at` advances.

#### `DELETE /organizations/{organization_id}` — `organizations.delete` (204)

Domain rules:

1. Requires `organizations.delete` (**owner only** — D3).
2. Non-member → **404**; member without permission → **403** (D1).
3. Deletion cascades the organization's tenant-scoped rows that exist in this phase:
   `organization_members` and `invitations`.
4. Decision D9 fixes the remaining rules: whether the last organization of the acting
   owner may be deleted, and the coordination obligations for Phases 5 (projects) and
   12 (audit logs).
5. Returns **204**. Subsequent access to the organization yields **404** for everyone.

#### `GET /organizations/{organization_id}/members` — `organizations.listMembers` (200)

Domain rules:

1. Requires `members.read` (every member role; viewer reads the roster — D3).
2. Non-member → **404**; member → **200** `OrganizationMemberList` (paginated).
3. Each entry includes the member's identity via the `user` object (D8).
4. All members are visible to all member roles.

#### `PATCH /organizations/{organization_id}/members/{user_id}` — `organizations.updateMember` (200)

Domain rules (D4):

1. Requires `members.update`. The target `{user_id}` must be a member of the
   organization; otherwise **404 `NOT_FOUND`** (no cross-org information disclosure).
2. **Target restrictions:** an actor may change the role of another member only when
   permitted by the role matrix:
   - `owner` may change the role of any member, including another `owner`.
   - `admin` may change roles of `admin`, `member`, and `viewer` members, but **not** of
     `owner` members.
   - A member without `members.update` may still change their **own** role only downward
     (self-demotion) — see rule 5.
3. **Last-owner invariant:** the role of the last `owner` may not be changed to a
   non-owner role (would leave the organization without an owner) → **422
   `BUSINESS_RULE_VIOLATION`**.
4. **Granting `owner`:** only an `owner` actor may set a member's role to `owner`.
   `admin` may not create owners.
5. **Self-demotion:** an `owner` may demote themselves only when another `owner` remains;
   an `admin`/`member`/`viewer` may demote themselves freely (no invariant protects
   these roles).
6. Returns **200** with the updated `OrganizationMember`; `updated_at` advances.

#### `DELETE /organizations/{organization_id}/members/{user_id}` — `organizations.removeMember` (204)

Domain rules (D4):

1. Requires `members.remove`, except that **self-removal is always permitted**
   (a member may leave an organization).
2. The target must be a member of the organization; otherwise **404 `NOT_FOUND`**.
3. **Target restrictions** mirror `updateMember`: `admin` may remove `admin`/`member`/
   `viewer` members but not `owner` members; `owner` may remove any member.
4. **Last-owner invariant:** removing the last `owner` (including self-removal) → **422
   `BUSINESS_RULE_VIOLATION`**.
5. An `owner` may leave the organization (self-removal) only when another `owner` remains.
6. Returns **204**. The removed user's membership row is deleted; their access ends
   immediately.

#### `GET /organizations/{organization_id}/invitations` — `organizations.listInvitations` (200)

Domain rules:

1. Requires `invitations.read` (owner, admin — D3).
2. Non-member → **404**; member without permission → **403** (D1).
3. Returns **200** `InvitationList` (paginated), covering **pending and historical**
   invitations (all statuses), per the contract description.

#### `POST /organizations/{organization_id}/invitations` — `organizations.createInvitation` (201)

Domain rules (D5):

1. Requires `invitations.create` (owner, admin).
2. Request body: `email`, `role` (`InvitationCreate`). `email` is normalized
   (trimmed + lowercased, Phase 3 D8 convention) before storage and checks.
3. **Role restrictions:** `role: owner` invites require the inviter to be an `owner`
   (admins may invite `admin`, `member`, `viewer` only).
4. Conflicts (**409 `CONFLICT`**):
   - the email is already a member of the organization;
   - a **pending** invitation for the same email already exists.
   A canceled or accepted historical invitation does not block a new one.
5. Creates a `pending` invitation. Returns **201** with the `Invitation`.
6. The invitation has **no expiry and no decline status** in the MVP: an ignored
   invitation stays `pending` until accepted or canceled by an administrator (D5/D6).

#### `DELETE /organizations/{organization_id}/invitations/{invitation_id}` — `organizations.cancelInvitation` (204)

Domain rules (D5):

1. Requires `invitations.cancel` (owner, admin).
2. The invitation must belong to the addressed organization; otherwise **404**.
3. A `pending` invitation is canceled → **204**.
4. Idempotency: canceling an already-`canceled` invitation → **204** (no-op).
5. Canceling an `accepted` invitation → **422 `BUSINESS_RULE_VIOLATION`** (an accepted
   invitation is a historical record; membership is unaffected).

#### `POST /invitations/{invitation_id}/accept` — `organizations.acceptInvitation` (201)

Domain rules (D5, D6):

1. Session-authenticated. **No prior membership is required** (this is the endpoint that
   creates it).
2. **Email binding:** the invitation is accepted only by the account whose normalized
   email equals the invitation's normalized email. A different email (or a nonexistent
   invitation) → **404 `NOT_FOUND`** with a generic message — the invitation's existence
   is never revealed to non-matching users.
3. Status check: a non-`pending` invitation → **422 `BUSINESS_RULE_VIOLATION`**.
4. Already a member → **409 `CONFLICT`** (the invitations list is the authoritative view;
   no implicit "re-join").
5. On success (single transaction): mark the invitation `accepted` (set `accepted_at`)
   and create the membership with the invited role. Returns **201** with the
   `OrganizationMember`.
6. An accept link is shared out of band by an administrator (no email delivery, D6).

### 4.3 Role and permission model

**Roles (fixed by phase 1 §4):** `owner`, `admin`, `member`, `viewer`.

**Capabilities (Phase 4 scope; later phases extend the registry):**

| Capability              | owner | admin | member | viewer | Notes |
| ----------------------- | :---: | :---: | :----: | :----: | ----- |
| `organizations.read`    | ✓ | ✓ | ✓ | ✓ | View org details |
| `organizations.update`  | ✓ | ✓ | — | — | Rename org |
| `organizations.delete`  | ✓ | — | — | — | Delete org |
| `members.read`          | ✓ | ✓ | ✓ | ✓ | View roster |
| `members.update`        | ✓ | ✓¹ | — | — | ¹ Non-`owner` targets; granting `owner` requires actor `owner` |
| `members.remove`        | ✓ | ✓¹ | self | self | ¹ Non-`owner` targets; self-removal always allowed; last-owner invariant |
| `invitations.read`      | ✓ | ✓ | — | — | View invitations |
| `invitations.create`    | ✓ | ✓² | — | — | ² `role: owner` requires actor `owner` |
| `invitations.cancel`    | ✓ | ✓ | — | — | Cancel pending invitations |
| `invitations.accept`    | member-agnostic | | | | Any authenticated user whose email matches (D5/D6) |

**Guard mechanics (D2):** a reusable guard (analogous to `SessionAuth`) is applied to
org-scoped routes together with `SessionAuth`. It:

1. reads the `organization_id` from the request path;
2. loads the caller's membership; no membership → **404** (D1);
3. evaluates the requested capability against the role matrix; insufficient → **403**;
4. attaches the resolved membership (organization + role) to the request for downstream
   use, so route handlers never re-derive membership.

Special cases handled outside the matrix: `POST /organizations` (creator becomes owner),
`POST /invitations/{invitation_id}/accept` (no membership required; email binding).

### 4.4 Tenant isolation

- Every Phase 4 query and mutation is scoped by the caller's membership: list endpoints
  derive scope from the caller, item endpoints from the `organization_id` path parameter
  validated through the guard (§4.3).
- The guard's membership check is the single authorization boundary; route handlers must
  not bypass it. Cross-organization `user_id` manipulation in
  `updateMember`/`removeMember` is impossible because the target is resolved within the
  organization's roster (non-member target → 404, §4.2).
- IDOR prevention (a user acting on another organization) is a first-class test concern
  (§9).

### 4.5 Cursor pagination

`organizations.list`, `organizations.listMembers`, `organizations.listInvitations`
implement cursor pagination exactly as contracted (phase 1 §7.5, `Limit`/`Cursor`
parameters, `next_cursor`/`has_more`). The list-response shape and cursor derivation from
time-ordered UUIDv7 IDs becomes the shared pattern that Phase 6 generalizes to customers.

### 4.6 Errors

Reuse the canonical envelope (Phase 2 base). No new error codes are required in Phase 4:

| Case                                   | Status | Code                      |
| -------------------------------------- | ------ | ------------------------- |
| Validation failure                     | 400    | `VALIDATION_ERROR`        |
| Not authenticated                      | 401    | `UNAUTHENTICATED`         |
| Member without required permission     | 403    | `FORBIDDEN`               |
| Non-member / unknown target / hidden   | 404    | `NOT_FOUND`               |
| Existing member / pending invite       | 409    | `CONFLICT`                |
| Last owner / non-pending accept / cancel of accepted / etc. | 422 | `BUSINESS_RULE_VIOLATION` |
| Throttled (reserved; effective in Phase 13) | 429 | `RATE_LIMITED`        |
| Unexpected                             | 5xx    | `INTERNAL_ERROR`          |

Messages are generic where security demands it (§4.2: accept email mismatch, non-member
access) and never leak internals.

## 5. Web Application — `apps/web` (organization UI)

### 5.1 Organization management UI

Replace the Phase 2 placeholder on `/dashboard/organizations` with a functional
organization area:

- **Organization list:** shows the caller's organizations (fetched via
  `organizations.list`), with the caller's role in each, and a **create** form
  (`organizations.create`, `name` only).
- **Organization detail** at `/dashboard/organizations/[organizationId]` (new route; see
  D8/§12 for the `web-application-structure.md` update):
  - organization info (`organizations.retrieve`) with rename (`organizations.update`)
    shown for owner/admin;
  - **delete** (`organizations.delete`) shown for owners only, with confirmation;
  - **member list and role management** (§5.2);
  - **invitations** (§5.2).
- Callers without `members.read` are redirected back to the list. A member of the org
  whose role forbids a mutation simply does not see the corresponding controls (phase 1
  §11.4: role-based UI restrictions match the RBAC model); the **API remains the
  enforcement point**.
- A non-member reaching `/dashboard/organizations/[organizationId]` is treated as a
  not-found state (mirrors the API's 404 semantics, D1).

### 5.2 Member and role management UI

Within the organization detail page:

- **Members:** list (`organizations.listMembers`) with each member's `user` identity and
  role; role change (`organizations.updateMember`) and removal
  (`organizations.removeMember`) controls rendered according to the role matrix (§4.3)
  — e.g., owner sees role controls for everyone; admin sees them for non-owner members;
  viewer sees a read-only roster. A member sees a "leave organization" action for
  themselves.
- **Invitations:** list pending/historical invitations (`organizations.listInvitations`),
  create (`organizations.createInvitation`, email + role; `owner` role offered only when
  the caller is an owner), and cancel (`organizations.cancelInvitation`) — for owner/admin
  only.
- **Accept flow:** `/dashboard/invitations/[invitationId]` (new route) renders an
  "accept invitation" confirmation page backed by `organizations.acceptInvitation`. It
  shows success (redirect to the organization or the organizations list) or the API error
  (not found, no longer pending, already a member). The accept URL is how an invited user
  reaches the flow in the absence of email delivery (D6).

### 5.3 Boundaries

- `apps/web` remains a client of the API: no parallel backend, no RBAC logic beyond *
  presenting* what the API returns, no duplicate domain rules (phase 1 §11).
- The dashboard shell, project placeholders, and settings page are untouched in this
  phase (the complete dashboard polish is Phase 14).
- No shared packages are created (no concrete reuse need yet, master specification).

## 6. Data Requirements

Domain tables are added/extended by Phase 4 via the committed-migration workflow
(ADR-0011), applying the fixed conventions (UUIDv7 stored as `uuid`; `snake_case`;
`created_at` on every record; `updated_at` on mutable records; UTC).

### 6.1 `organizations` (extends Phase 3)

| Column       | Type          | Constraints / notes                                                        |
| ------------ | ------------- | -------------------------------------------------------------------------- |
| `id`         | `uuid`        | PK; UUIDv7 (ADR-0001).                                                      |
| `name`       | `varchar(200)`| Non-empty trimmed name (D7); not globally unique.                           |
| `created_at` | `timestamptz` | UTC.                                                                        |
| `updated_at` | `timestamptz` | UTC; advanced by `organizations.update`.                                    |

No new columns are required by Phase 4; the table is already defined. Deletion semantics
cascade to members and invitations (D9).

### 6.2 `organization_members` (extended by migration)

Phase 3 created the minimal column set; Phase 4 adds the `updated_at` column (the table is
now mutable — role changes).

| Column            | Type                    | Constraints / notes                                                                     |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `id`              | `uuid`                  | PK; UUIDv7.                                                                             |
| `organization_id` | `uuid`                  | FK → `organizations.id` (cascade on organization deletion). Indexed.                    |
| `user_id`         | `uuid`                  | FK → `users.id` (cascade on user deletion). Indexed.                                    |
| `role`            | `varchar(50)`           | One of `owner`, `admin`, `member`, `viewer`; validated at the application boundary (D10). |
| `created_at`      | `timestamptz`           | UTC.                                                                                    |
| `updated_at`      | `timestamptz` (new)     | UTC; advanced on every role change.                                                     |

Integrity: unique (`organization_id`, `user_id`) — already present from Phase 3. The
last-owner and target-restriction invariants (§4.2) are application-enforced (the roles
of multi-row sets make a pure DB constraint impractical for the MVP).

### 6.3 `invitations` (new table)

| Column            | Type                     | Constraints / notes                                                                     |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `id`              | `uuid`                   | PK; UUIDv7.                                                                             |
| `organization_id` | `uuid`                   | FK → `organizations.id` (cascade on organization deletion). Indexed.                    |
| `email`           | `varchar(320)`           | Normalized (trimmed + lowercased, Phase 3 D8).                                          |
| `role`            | `varchar(50)`            | Invited role; one of `owner`, `admin`, `member`, `viewer`; app-validated (D10).         |
| `status`          | `varchar(20)`            | `pending`, `accepted`, `canceled` (contract enum).                                      |
| `created_at`      | `timestamptz`            | UTC.                                                                                    |
| `updated_at`      | `timestamptz`            | UTC; advanced on status transitions.                                                    |
| `accepted_at`     | `timestamptz` (nullable) | Internal audit-friendly timestamp; set on accept. Not exposed unless D8 decides otherwise. |
| `canceled_at`     | `timestamptz` (nullable) | Internal audit-friendly timestamp; set on cancel. Not exposed unless D8 decides otherwise. |

Integrity:

- **Partial unique index** `(organization_id, email)` **where `status = 'pending'`** — the
  database-level guard behind the "one pending invitation per email per organization"
  rule (§4.2, D5). Historical (accepted/canceled) rows do not block re-inviting.
- Index on `email` for the accept lookup path and on `organization_id` for listing.

### 6.4 Migration and integrity

- One committed migration (or a small set) on top of the Phase 3 schema: adds
  `organization_members.updated_at`, creates `invitations` (table, partial unique index,
  indexes).
- Atomicity:
  - `organizations.create`: organization + owner membership all-or-nothing.
  - `organizations.acceptInvitation`: invitation → `accepted` + membership creation
    all-or-nothing.
  - `organizations.delete`: organization + cascade of members/invitations.
- No seed data, no secrets, no emails in migrations.

## 7. Security Requirements

1. **RBAC enforcement (server-side):** every org-scoped route is guarded by
   `SessionAuth` + the org-scoped RBAC guard (§4.3). `apps/web` never bypasses the API;
   UI hiding is presentation, not enforcement.
2. **Tenant isolation:** all reads/writes are scoped by membership; the guard resolves
   membership from the request and route handlers cannot act across organizations.
   IDOR (cross-organization `organization_id`, `user_id`, `invitation_id` manipulation)
   is a first-class test concern.
3. **Non-disclosure (D1):** a non-member receives **404** for org-scoped resources —
   organization existence is not revealed to non-members. A member without the required
   permission receives **403** (distinct and safe). The accept endpoint hides invitation
   existence from non-matching emails (§4.2).
4. **Owner invariants (D4):** the last-owner rule prevents an organization losing its
   owner through role change or removal; only `owner` actors can create/change `owner`
   members. Implemented server-side and tested, not merely hidden in the UI.
5. **Invitation integrity (D5/D6):** invitations are bound to an email; acceptance
   verifies the authenticated user's normalized email against the invitation. No
   invitation can be accepted based on guessing an ID alone by a different account.
   Invitation IDs are UUIDv7 opaque values (ADR-0001) but are not a security control —
   email binding is.
6. **Input validation:** all external input validated at the boundary (DTOs): name bounds
   (D7), role enum (D10), email format + normalization (D8 convention), status transitions.
7. **Secure logging:** the Phase 2 base redaction covers auth material; Phase 4 must never
   log email addresses of invitations beyond normal request logging, and never log
   IDs beyond their normal request/response scope. No new credential material exists in
   this phase.
8. **Error safety:** error responses never leak internals (stack traces, DB details) nor
   reveal membership/roster information of organizations the caller cannot access.
9. **Rate limiting:** org endpoints receive no additional rate limiting in Phase 4
   (Phase 13 applies global limits; the contract's 429 responses become effective then).
10. **No API-key paths:** organization management is session-only; Phase 5 API keys never
    gain org-management authority (phase 1 §7.3).

## 8. Acceptance Criteria

1. All Phase 4 roadmap checkboxes (§2) are implemented and traced (§11).
2. `POST /organizations` creates an organization with the caller as `owner` (atomic);
   `GET /organizations` lists exactly the caller's organizations; retrieve/update/delete
   behave per the role matrix.
3. Non-member access to any org-scoped endpoint returns **404 `NOT_FOUND`**; a member
   without the required permission returns **403 `FORBIDDEN`** (D1) — verified per
   endpoint and per role.
4. The role matrix (§4.3) is enforced per route and per resource: every
   (role, capability) combination behaves as specified, including: admin cannot modify
   or remove `owner` members; only `owner` can grant/change `owner`; member/viewer cannot
   update/delete the organization.
5. Last-owner invariant: removing or demoting the last `owner` returns **422
   `BUSINESS_RULE_VIOLATION`** and leaves membership unchanged (including via self-service).
6. Invitation lifecycle: create → pending; duplicate pending email → **409**; inviting an
   existing member → **409**; accept with matching email → **201** membership with the
   invited role (invitation becomes `accepted`); accept with non-matching email or unknown
   id → **404**; accept non-`pending` → **422**; accept when already a member → **409**;
   cancel pending → **204**; cancel canceled (idempotent) → **204**; cancel accepted →
   **422**.
7. Tenant isolation: an authenticated member of organization A receives **404** for all
   org-scoped requests against organization B (list members, update, remove member,
   invitations) and cannot accept an invitation addressed to another email (D5/D6).
8. Cursor pagination works on the three list endpoints (`limit`, `cursor`,
   `next_cursor`, `has_more`) with correct first/last pages and empty-organization
   behavior.
9. `organization_members.updated_at` exists and advances on role changes; `invitations`
   is created with the partial unique index on pending `(organization_id, email)`; running
   `prisma migrate deploy` applies the migration in CI and clean environments.
10. API responses match the contract, refined per D8 (member entries carry `user`
    identity; invitation entries carry status transition timestamps as decided); the
    contract remains Redocly-lint clean with no parallel contract (ADR-0012).
11. The org-scoped RBAC guard is implemented as reusable infrastructure (usable by Phase 5+
    with an extensible capability registry) and returns the canonical 401/403/404
    envelopes as specified.
12. `apps/web` implements §5: organization list + create; detail page with rename, delete,
    member list, role management, invitations; accept page. Role-based UI matches the
    matrix; viewers see read-only interfaces; non-members see a not-found state.
13. No invitation email, no org membership data of other organizations, and no internal
    details appear in logs or responses beyond the documented API contract.
14. All repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
    `pnpm test:e2e`, `pnpm build`, locally and in CI.

## 9. Testing Requirements

### 9.1 API (`apps/api`)

- **Unit tests:**
  - Permission matrix: every (role, capability) pair resolves as specified (§4.3),
    including the special rules (owner-granting, admin non-owner targets, self-service).
  - Guard: loads membership; non-member → 404; insufficient permission → 403; attaches
    resolved membership; works with `SessionAuth`.
  - Invitation service: lifecycle transitions (pending → accepted/canceled), email
    normalization and matching, duplicate-pending detection, cancel idempotency,
    non-pending rejection, already-member conflict.
  - Owner invariants: last-owner removal/demotion rejection; owner self-demotion guarded.
  - Organization service: create (owner membership, atomicity), update (name bounds,
    `updated_at`), delete (cascade; D9 rules).
  - Cursor pagination helper: ordering, `next_cursor`, `has_more` on the three lists.
- **Integration/e2e (`test:e2e`) against the running app with real PostgreSQL/Redis**
  (CI service containers, Phase 2 D8):
  - register → default org visible in `organizations.list` (Phase 3 back-compat, D5 name).
  - create/retrieve/update/delete org flows; update/delete permission checks per role.
  - members: list showing `user` identity; role change (valid + target-restriction +
    last-owner cases); remove member (+ self-removal + last-owner case).
  - invitations: create (pending; conflict on duplicate pending; conflict on existing
    member; role=owner only by owner), list (admin/owner only), cancel (pending/
    canceled/accepted), accept (match → 201 membership; mismatch → 404; non-pending →
    422; already member → 409; atomicity of accept).
  - **Tenant isolation/IDOR suite:** user A (member of org 1) against org 2 → 404 for
    every org-scoped route; cross-org `user_id`/`invitation_id` manipulation → 404/422
    per §4.2; invitation IDs of org 2 not usable by user A (email-bound).
  - pagination on the three list endpoints; 401s for unauthenticated requests; 403 for
    member-without-permission per matrix.
  - migrations apply cleanly (`prisma migrate deploy` step in CI, §12).
- **Web (`apps/web`):**
  - Unit: org list/create page; detail page rendering per role (controls shown/hidden);
    accept page states (loading, success, error mapping 404/409/422); not-found state
    for non-members.
  - E2e (`test:e2e`): extend the established smoke pattern — org list loads after login;
    a scripted one-user flow (create org, rename, invite self is impossible — so the e2e
    covers create/rename/delete and member read-only views); the full invitation
    acceptance e2e across two users is covered at API e2e level and/or a minimal web e2e
    (full browser e2e remains Phase 17).

### 9.2 Shared

- All checks run from the repository root (`pnpm -r …`) and in CI.
- Tests require no secrets; test config uses `.env.example`-style defaults; test data uses
  generated UUIDv7 and unique emails.

## 10. Definition of Done

Phase 4 is complete when:

- All roadmap checkboxes in §2 are implemented and traced (§11).
- All acceptance criteria in §8 pass.
- All checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D10 are confirmed by the product authority; architecture-level policy is
  recorded as ADRs where applicable, and confirmed decisions are recorded in §14.
- `docs/openapi.yaml` is consistent with the confirmed decisions (member/invitation
  representation refinements in place, permission rules documented) and lints clean — no
  parallel contract.
- No security-relevant issue remains open: RBAC guard is the single authorization
  boundary for org-scoped routes, tenant isolation tests pass, owner invariants enforced,
  non-disclosure semantics verified.
- Coordination obligations are recorded: Phase 5 reuses the RBAC guard and extends the
  capability registry; Phase 5/12 revisit organization deletion semantics if they change
  (projects, audit logs); Phase 13 activates the contract's 429 responses.
- Phase 5 (Projects & API Keys) can start without re-opening Phase 4 decisions.

## 11. Traceability (Roadmap → Phase 4)

| Roadmap Phase 4 checkbox                  | Specification reference            |
| ----------------------------------------- | ---------------------------------- |
| Organizations CRUD                        | §4.2, §6.1, §8.2                    |
| Member management (invite, remove)        | §4.2 (members + invitations), §6.2–6.3 |
| Role definitions (owner, admin, member, viewer) | §4.3, D3/D4                  |
| Permission system                         | §4.3, D2/D3, §8.4                   |
| Tenant isolation (data scoping)           | §4.4, D1, §8.3, §8.7                |
| Organization management UI in `apps/web`  | §5.1, §8.12                         |
| Member and role management UI             | §5.2, §8.12                         |

## 12. Implementation Considerations

- **RBAC guard as shared infrastructure (D2):** implement the org-scoped guard inside the
  `organizations` module next to `SessionAuth`; capabilities are a registry that later
  phases extend (projects, API keys, …). Keep the guard contract minimal: (route
  capability, request) → 401/403/404 or resolved membership.
- **Ownership of role constants:** the role enum (`owner`/`admin`/`member`/`viewer`) and
  capability strings must live in one shared location in `apps/api` (single source for
  guard, matrix, and DTOs); the OpenAPI contract remains the external contract.
- **`organization_members.updated_at` and `invitations` migration:** one committed
  migration (ADR-0011). The partial unique index for pending invitations requires raw SQL
  in the migration (Prisma cannot express `WHERE status = 'pending'` partial indexes
  declaratively); verify `prisma migrate dev`/`deploy` round-trips.
- **Cursor pagination groundwork:** the three list endpoints need the cursor pattern
  before Phase 6; implement the small shared helper the lists use (opaque cursor over
  time-ordered UUIDv7, limit bounds 1–100 per contract) so Phase 6 reuses it rather than
  re-inventing it.
- **UI routes and documentation:** `apps/web` gains
  `/dashboard/organizations/[organizationId]` and `/dashboard/invitations/[invitationId]`;
  update `docs/web-application-structure.md` (authenticated-area route list) and the
  API client (`apps/web/lib/brinnpay/client.ts`) with the org endpoints — the client
  remains a thin fetch wrapper over the contract.
- **OpenAPI refinements (in place, ADR-0012):** extend `OrganizationMember` with a `user`
  object (and optionally invitation transition timestamps, per D8); refine operation
  descriptions for the confirmed permission rules, status-code semantics, and invitation
  lifecycle; keep the file lint-clean. No endpoint additions.
- **Coordination with Phase 5:** projects belong to organizations (Phase 1 domain model)
  and will need the same guard + capability registry; Phase 5 must not duplicate the
  matrix. Also note: org deletion semantics must be revisited when tenant-scoped business
  data (projects in Phase 5+) exists — D9 records the obligation instead of inventing
  cascade rules for not-yet-existing tables.
- **Coordination with Phase 12:** audit entries reference the organization; append-only
  audit rows and organization deletion must not conflict (FK behavior decided in Phase 12;
  recorded obligation in D9).
- **Anti-goals:** no rate limiting (Phase 13), no audit logging (Phase 12), no email
  delivery, no ownership-transfer endpoint (achievable via owner promote + self-demote),
  no organization archiving/merging, no multi-tenant admin console (ADR-0009), no
  API-key paths for org management.

## 13. Out of Scope

- Projects and API keys (Phase 5).
- Customer, payment, refund, webhook modules (Phases 6–10).
- Idempotency records (Phase 8), request logs (Phase 11), audit logs (Phase 12).
- Global/IP/API-key rate limiting and rate-limit headers (Phase 13).
- Email delivery or any notification channel for invitations (none in the MVP roadmap).
- Ownership transfer of an organization as a dedicated operation (achievable via the
  existing member-role operations: promote to `owner`, then self-demote — subject to the
  last-owner invariant).
- Organization archiving, merging, splitting, per-tenant settings beyond `name`, and
  organization-wide bulk operations.
- Platform-administrator functionality (ADR-0009) and any end-user/customer-facing area
  (ADR-0008).
- Full dashboard polish, responsive layout, and browser e2e tooling (Phase 14, Phase 17).
- Real payment processing, billing, SSO, microservices (master specification).

## 14. Confirmed Decisions

> **Confirmed by the product authority on 2026-09-20.** All decisions below were adopted
> as recommended (marked **[rec]**) and are binding for the contract, schema, and UI. The
> four open questions (D9 last-organization deletion, D3/D4 self-removal, D8 member
> identity in the API, D4 admin capabilities) were resolved per the recommended options.
> The affected acceptance criteria (§8) and `docs/openapi.yaml` descriptions reflect
> them.

| #   | Decision                                    | Recommended option [rec] / alternatives                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Access semantics for non-members vs members | **[rec]** Non-member → **404 `NOT_FOUND`** for all org-scoped resources (organizations, members, invitations) — hides organization existence and prevents enumeration. Member without the required capability → **403 `FORBIDDEN`**. Alternatives: 403 for non-members too (reveals existence); 404 for both (weaker debugging, hides permission results — rejected). |
| D2  | Permission-system shape                     | **[rec]** Role → capability matrix with a reusable org-scoped guard inside the `organizations` module; route handlers declare the required capability; later phases extend the registry. Alternatives: hard-coded role checks per route (faster to write, duplicated and drift-prone); full policy engine (overkill for the MVP).        |
| D3  | Permission matrix (Phase 4 scope)           | **[rec]** Matrix of §4.3: `organizations.read` (all roles), `organizations.update` (owner+admin), `organizations.delete` (owner), `members.read` (all roles), `members.update`/`members.remove` (owner; admin for non-`owner` targets; self-service removal), invitations (owner+admin; accept is member-agnostic). Alternatives: viewer cannot read the roster; members cannot leave.               |
| D4  | Member-management target rules              | **[rec]** Only `owner` actors may change/remove `owner` members or grant `owner`; `admin` manages `admin`/`member`/`viewer` only; last-owner invariant (demote/remove/self-demote/self-remove of the last owner → 422); self-removal allowed for any member; self-demotion allowed downward. Alternatives: owners may not touch other owners at all; no self-service.                                 |
| D5  | Invitation lifecycle and constraints        | **[rec]** Statuses: `pending` → `accepted` \| `canceled` (no expiry, no decline in the MVP). One pending invitation per (organization, email) — duplicate pending → 409; inviting an existing member → 409; cancel is idempotent for `canceled` (204) and rejected for `accepted` (422); accept email-mismatch/unknown id → 404, non-`pending` → 422, already member → 409. Alternatives: expiry dates; decline status; cancel of accepted as 204. |
| D6  | Invitation delivery and acceptance channel  | **[rec]** No email delivery (MVP constraint). Acceptance is a session-authenticated endpoint keyed by `invitation_id` with **email binding** (the authenticated user's normalized email must equal the invitation's email); admins share the accept URL out of band. No "my invitations" list endpoint (contract has none). Alternatives: add a user-facing pending-invitations endpoint (contract expansion); unauthenticated accept links (rejected: cannot bind identity). |
| D7  | Organization name bounds                    | **[rec]** Trimmed, non-empty, ≤ 200 characters (DB `varchar(200)`); names are not required to be unique; the default-org name generated in Phase 3 (D5) is always within bounds and accepted. Alternatives: shorter max; uniqueness (rejected: tenant names are display values).                                                                                                                    |
| D8  | Member and invitation API representation    | **[rec]** Extend `OrganizationMember` with a `user` object (`id`, `email`, `name`) so the member UI can display identity; keep `Invitation` as contracted but add nullable `accepted_at`/`canceled_at` and `updated_at` to the API schema to reflect lifecycle. In-place contract refinement (ADR-0012-compatible); no endpoints change. Alternatives: no user object (UI cannot render member identity — rejected); separate user endpoint (unnecessary surface). |
| D9  | Organization deletion semantics             | **[rec] Confirmed** Owner-only; `DELETE` cascades members and invitations (the tenant-scoped rows that exist in Phase 4). Deleting the acting owner's **last** organization is **allowed** — the user may temporarily have zero tenants, since ADR-0010 guarantees a default tenant only at **registration** and the user can create a new one immediately. Coordination obligations: Phases 5 (projects) and 12 (audit) determine how deletion interacts with future tenant-scoped data. |
| D10 | Role storage integrity                      | **[rec]** Application-level enum validation at the boundary (DTO + guard) with the DB `varchar` columns kept as-is. Alternative: DB CHECK constraints via raw SQL in the migration (extra hardening, more migration complexity — deferred unless desired).                                                                                                                                                             |

> **Consistency check with prior phases:** none of the proposed decisions contradicts the
> master specification, phase 1–3 decisions, or ADRs 0001–0013. D1 refines the phase 1
> tenant-isolation rule ("access limited to members") with concrete status codes already
> present in the contract. D2/D3 implement the security-baseline RBAC requirement and the
> phase 1 role definitions. D4/D5 refine phase 1's `OrganizationMember`/`Invitation`
> entities (roles, invitations "detail in Phase 4"). D6 works within the MVP's no-email
> constraint. D8 extends response schemas in place, which phase 1 §13.2 permits for
> phase-owned refinements. D9 implements the roadmap's "delete" CRUD operation; deleting
> the last organization is allowed (ADR-0010 guarantees a default tenant at
> **registration**, not at all times). D10 matches the existing `varchar` columns
> created in Phase 3 §6.3 (D4).

## 15. Dependencies

- Inputs: Phase 3 (session guard, `organizations`/`organization_members` base tables via
  D4, email normalization convention), Phase 2 base (error envelope, request IDs, DTO
  validation, Prisma migration workflow, CI service containers), phase 1 artifacts and
  ADRs 0001–0013, `docs/openapi.yaml` organizations surface.
- Blocks: Phase 5 (Projects & API Keys) — projects live inside organizations and rely on
  the RBAC guard/capability registry; all subsequent phases.
- Coordination obligations out of this phase:
  - Phase 5: reuse the guard and extend the capability registry; revisit organization
    deletion when projects exist (D9).
  - Phase 12: audit entries reference organizations; decide FK behavior with deletion
    (D9).
  - Phase 13: activates the contract's 429 responses on org endpoints.
  - Phase 6: generalizes the cursor-pagination pattern introduced here.
  - Phase 14: completes dashboard polish; Phase 17 adds browser e2e.