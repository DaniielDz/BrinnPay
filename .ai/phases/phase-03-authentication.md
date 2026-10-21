# Phase 3 — Authentication

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| Phase             | 3                                                        |
| Name              | Authentication                                           |
| Status            | **Ready**                                                |
| Depends on        | Phase 2 (complete)                                       |
| Blocks            | Phase 4 (Organizations & RBAC) and all subsequent phases |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 3                 |

---

## 1. Objective

Implement user registration, login, and secure session management for BrinnPay:

- Users can register with an email and password; a personal/default organization is
  created during onboarding (ADR-0010).
- Users can log in and obtain a short-lived JWT access token together with a revocable
  refresh session.
- Refresh sessions are revocable and exposed to the browser only as an `HttpOnly` cookie
  (phase 1 §11.5); logout revokes the session and clears the cookie.
- Passwords are hashed with **Argon2id** (ADR-0007); they are never stored, logged, or
  returned in plaintext.
- Auth endpoints are rate limited (security baseline; full API rate limiting is Phase 13).
- The web application provides login and registration UI and client-side session handling
  that never persists the access token beyond memory.

This phase delivers the `auth` domain module of the API and the authentication area of
`apps/web`. It introduces the first domain tables (`users`, `refresh_sessions` and — per
D4 — the minimal organization tables required by ADR-0010) via the migration workflow
established in Phase 2 (ADR-0011).

## 2. Scope

In scope (mapped to the Phase 3 roadmap checkboxes):

| Roadmap checkbox                         | Specification reference          |
| ---------------------------------------- | -------------------------------- |
| User registration                        | §4.2 (register), §6              |
| User login                               | §4.2 (login)                     |
| Token/session management (JWT + refresh) | §4.2 (refresh/logout/me), §6, §8 |
| Password hashing (bcrypt/argon2)         | §8.1 (Argon2id, ADR-0007)        |
| Rate limiting (auth endpoints)           | §4.4                             |
| Authentication UI in `apps/web`          | §5                               |
| Login UI                                 | §5.1                             |
| Registration UI                          | §5.1                             |
| Session handling in the web application  | §5.2                             |
| Auth tests                               | §11                              |

Required to keep the phase self-consistent (see §3):

- The `SessionAuth` guard as reusable authentication infrastructure for all later
  session-authenticated endpoints (Phases 4–14).
- The minimal persistence for the ADR-0010 default organization (created in this phase
  from the registration transaction, D4).

## 3. Context

Constraints reused from the master specification, Phase 1, Phase 2, and ADRs (all binding):

- Modular monolith: NestJS API (`apps/api`) + Next.js web app (`apps/web`); PostgreSQL +
  Prisma; Redis available (connectivity only — BullMQ is wired in Phase 10, ADR-0013).
- The API surface is versioned at `/api/v1` (ADR-0005); the canonical contract is
  `docs/openapi.yaml`, which **already defines** the auth surface (`/auth/register`,
  `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`), the `SessionAuth` bearer
  scheme, the `AuthSession` / `AccessTokenResponse` / `User` schemas, and the
  `brinnpay_refresh` `HttpOnly` cookie header. Phase 3 refines descriptions in-place where
  decisions affect them (D2, D6, D9, D10) and must keep the contract Redocly-lint clean
  (ADR-0012).
- Session model (phase 1 §11.5, security baseline): short-lived JWT access token held in
  memory by the web app, never in `localStorage`/`sessionStorage`; revocable refresh
  session persisted server-side (`RefreshSession`); refresh token exposed to the browser
  only via an `HttpOnly` cookie (`Secure` in secure/production, `SameSite` configured to
  minimize CSRF); logout revokes the refresh session and clears the cookie.
- Password hashing: **Argon2id required/default**; bcrypt only as a documented exception
  requiring an explicit Phase 3 decision (ADR-0007). None such exception is proposed in
  this phase.
- Default organization: a registered user automatically obtains a personal/default
  organization during onboarding; the user is the `owner` (ADR-0010). Timing, naming,
  transactionality, and default role are decided in this phase (D4, D5).
- Rate limiting: **applied to auth endpoints from Phase 3** (security baseline §1);
  endpoint-wide rate limiting for all API routes is Phase 13.
- Two authentication modes exist and are not equivalent (phase 1 §7.3): session (JWT) for
  dashboard/user endpoints and API keys (Phase 5) for programmatic access. This phase
  implements **session authentication only**; API keys arrive in Phase 5.
- Domain entities are added by their owning phases through committed migrations on the
  Phase 2 base schema (ADR-0011), applying the fixed conventions: UUIDv7 IDs stored as
  PostgreSQL `uuid` (ADR-0001), `snake_case`, `created_at` on every record, `updated_at`
  on mutable records, UTC timestamps.
- Web application principles: `apps/web` is a single Next.js app and a **client of the
  API**; no parallel backend, no domain logic (phase 1 §11, Phase 2 §5).
- Repository state: Phase 2 base is committed — API base infrastructure (config,
  validation, error envelope, request IDs, structured secure logging, Prisma, Redis,
  health, Swagger UI) and web routing skeleton with `/login` and `/register` placeholders.
  No domain code exists yet.

## 4. API Application — `apps/api` (auth module)

### 4.1 Module purpose

Create the `auth` domain module owning: user accounts, password hashing/verification,
access-token issuance, refresh-session lifecycle, the reusable session guard, and rate
limiting of auth endpoints. The module owns its persistence (`users`,
`refresh_sessions`; per D4 also the minimal organization tables) and must not reach into
other modules' tables.

### 4.2 Endpoints

All endpoints live under `/api/v1/auth`, match the operation IDs in `docs/openapi.yaml`
(`auth.register`, `auth.login`, `auth.refresh`, `auth.logout`, `auth.me`), and follow the
error envelope (§4.5).

#### `POST /auth/register` — `auth.register` (201)

Domain rules:

1. Request body: `email`, `password`, optional `name` (per `RegisterRequest`; D6 sets the
   final password bounds).
2. `email` is normalized (trimmed, lowercased) before storage and uniqueness checks
   (D8). Case-insensitive uniqueness: two registers differing only in case collide.
3. `password` is hashed with Argon2id (ADR-0007). The plaintext password is never
   stored, logged, transmitted back, or included in responses.
4. `name`, when provided, is trimmed; empty-after-trim is treated as absent. Length and
   content bounds follow D6/Phase 4 conventions; invalid input → 400 `VALIDATION_ERROR`.
5. Duplicate email → **409 `CONFLICT`**. The response reveals only that the email is
   already registered; it never reveals whether the existing account is "active" or any
   other attribute. This enumeration trade-off is accepted for the MVP sandbox (§8.8).
6. On success (single transaction, D4):
   - create the `User`;
   - create the default personal organization with the user as `owner` member
     (ADR-0010; D4/D5);
   - create the first `RefreshSession`;
   - set the refresh token as the `HttpOnly` cookie (§4.3);
   - return **201** with `AuthSession` (`access_token`, `token_type: "Bearer"`,
     `expires_in`, `user`). The refresh token is **never** in the body.
7. The whole registration is atomic: a failure in any step rolls back all steps (D4).
8. Auth endpoints are rate limited (§4.4); a throttled request → **429
   `RATE_LIMITED`**.

#### `POST /auth/login` — `auth.login` (200)

Domain rules:

1. Request body: `email`, `password` (per `LoginRequest`).
2. `email` is normalized as in register (D8) before lookup.
3. Unknown email and wrong password produce the **same response**: **401
   `UNAUTHENTICATED`** with a generic message ("invalid email or password"). No user
   enumeration via different messages or status codes.
4. On success: create a new `RefreshSession`, set the refresh cookie (§4.3), return
   **200** with `AuthSession`. The refresh token is never in the body.
5. Failed attempts count toward rate limiting (§4.4).

#### `POST /auth/refresh` — `auth.refresh` (200)

Domain rules:

1. Authenticated by the refresh `HttpOnly` cookie (no bearer, no body credentials).
2. The presented token is looked up by hash. Valid only if: session exists, is not
   revoked, and is not expired (D10).
3. **Rotation (D3):** a successful refresh creates a new `RefreshSession`, revokes the
   presented one, sets the new cookie, and returns **200** with `AccessTokenResponse`
   (`access_token`, `token_type`, `expires_in`).
4. **Reuse detection (D3):** if a presented token is revoked but not expired (a replay of
   an already-rotated token — a possible theft signal), revoke **all** active sessions of
   the user and return **401 `UNAUTHENTICATED`**.
5. Missing, invalid, expired, or revoked session → **401 `UNAUTHENTICATED`** with a
   generic message; the cookie should be cleared when the session is invalid (D9).

#### `POST /auth/logout` — `auth.logout` (204 / 401)

Domain rules:

1. Authenticated by the refresh cookie. If the presented session is valid, revoke it.
2. The cookie is always cleared on the response, whether or not a valid session was
   found (D9).
3. Behavior with no/invalid session follows D9: either idempotent **204** (recommended)
   or **401 `UNAUTHENTICATED`** with the cookie cleared (`RefreshTokenCookieCleared`).
4. Logout does not need an access token: it works with the refresh cookie alone.

#### `GET /auth/me` — `auth.me` (200)

Domain rules:

1. Requires session authentication via the `SessionAuth` guard (§4.3): bearer JWT access
   token.
2. Returns **200** with the `User` of the authenticated session (`id`, `email`, `name`,
   `created_at`, `updated_at`).
3. Missing/invalid/expired token → **401 `UNAUTHENTICATED`**.

### 4.3 Session mechanisms

**Access token (JWT):**

- Short-lived (D2), signed with a server-held secret (D1), containing at minimum:
  `sub` = user UUIDv7, `iat`, `exp`; `iss`/`aud`/`jti` per D1. The token is an opaque
  string to clients.
- The `SessionAuth` guard validates signature, expiry, and structure, loads the user, and
  attaches the authenticated identity to the request for downstream authorization
  (RBAC is Phase 4; the guard is the reusable boundary).
- The guard must handle "no header", "malformed header", and "invalid token" as **401
  `UNAUTHENTICATED`** with the canonical envelope.
- The access token is never logged; the token value never appears in error bodies.

**Refresh session (opaque token + server state):**

- Refresh tokens are cryptographically random opaque strings, generated at session
  creation; only a hash is stored in `refresh_sessions` (never the plaintext, never a
  JWT). The plaintext travels only in the `HttpOnly` cookie.
- Cookie attributes (phase 1 §11.5, D2/D10): name `brinnpay_refresh`, `Path=/api/v1/auth`,
  `HttpOnly` always, `Secure` in secure/production environments (and when configured),
  `SameSite` per D2/D10 (proposed `Lax`), lifetime bounded by D10.
- Rotation/reuse-detection semantics per §4.2 (D3).
- Expired or revoked sessions are rejected; cleanup of expired rows is lazy (D10;
  no background jobs — BullMQ is Phase 10, ADR-0013).

### 4.4 Rate limiting (auth endpoints)

Security baseline: rate limiting applies to auth endpoints **from Phase 3**.

1. Rate limiting covers all `/auth/*` endpoints, keyed at minimum by client IP and,
   for login/register, by the account email being attacked (D7).
2. Limits and windows are environment-configurable values (env-driven; sane sandbox
   defaults per D7).
3. A throttled request returns **429 `RATE_LIMITED`** with the canonical envelope.
4. Storage must be Redis-backed so limits hold across API instances (Redis is already
   wired in Phase 2); in-process storage is acceptable only as a documented local-dev
   fallback (D7).
5. Rate limiting must never log password or token material.
6. Full API-wide rate limiting (all routes, API-key based, endpoint-specific limits,
   standard headers) is Phase 13; Phase 3 only protects auth endpoints.

### 4.5 Errors

Auth errors reuse the canonical envelope (already enforced globally, Phase 2):

| Case                    | Status | Code               |
| ----------------------- | ------ | ------------------ |
| Validation failure      | 400    | `VALIDATION_ERROR` |
| Invalid credentials     | 401    | `UNAUTHENTICATED`  |
| Invalid/expired session | 401    | `UNAUTHENTICATED`  |
| Duplicate email         | 409    | `CONFLICT`         |
| Throttled               | 429    | `RATE_LIMITED`     |
| Unexpected              | 5xx    | `INTERNAL_ERROR`   |

No new error codes are required by this phase. Messages are generic where security
demands it (§4.2) and never leak internals, secrets, or credential material.

## 5. Web Application — `apps/web` (authentication UI and session handling)

### 5.1 UI

Replace the Phase 2 placeholders on `/login` and `/register` with functional forms:

- **Register page** (`/register`): fields `name` (optional), `email`, `password`
  (matching the API contract bounds, D6). On success the user is signed in and routed to
  `/dashboard`. Errors from the API are displayed (validation, duplicate email, rate
  limited, generic).
- **Login page** (`/login`): fields `email`, `password`. On success routed to
  `/dashboard`. Invalid credentials, validation, and rate-limit errors are displayed.
- The auth pages redirect already-authenticated users to `/dashboard` (§5.2).
- No domain logic, no token handling, and no business rules live in the pages beyond
  presenting API results; validation mirrors the API contract for UX but the API remains
  authoritative.

### 5.2 Session handling and route protection

Phase 2 explicitly shipped **no** auth behavior; Phase 3 introduces it:

1. **In-memory access token:** an auth context/provider holds the access token in memory
   for the active session. It is never written to `localStorage`/`sessionStorage`
   (phase 1 §11.5). On reload, the web app restores a session by calling `/auth/refresh`
   (the refresh cookie round-trips automatically) — the API is the source of truth.
2. **Refresh cookie:** the browser stores the `HttpOnly` cookie set by the API; the web
   app never reads or logs it.
3. **API calls:** session-authenticated API calls attach `Authorization: Bearer <access
token>`; cookie-bearing calls (`/auth/refresh`, `/auth/logout`) use
   `credentials: "include"`. The web app treats a 401 from the API as "re-authenticate"
   (refresh, or route to `/login` when refresh fails).
4. **Route protection:** authenticated-area routes (`/dashboard/**` and its existing
   skeleton routes) reject unauthenticated visitors and redirect to `/login`;
   `/login` and `/register` redirect authenticated users to `/dashboard` (phase 1
   §11.2/§11.4). Routing-level gating may rely on session presence (refresh-cookie
   availability / in-memory token); the **API remains the enforcement point** — the web
   app never bypasses API-level authorization, and 401s are honored.
5. **Logout:** call `/auth/logout`, clear the in-memory token, and route to the public
   area. Logout works on the refresh cookie alone (no requirement to keep the access
   token alive).
6. **API base URL** for the web app is environment-configurable (`NEXT_PUBLIC`-style
   config; local default `http://localhost:3000/api/v1` per D7 of Phase 2); no secrets
   are embedded.

### 5.3 Boundaries

- `apps/web` remains a client of the API: no parallel backend, no password hashing, no
  session persistence logic beyond what §5.2 states, no domain rules (phase 1 §11).
- Sessions are managed through the API only; the dashboard shell remains otherwise
  placeholder content (dashboard features are Phases 4–16).
- No shared packages are created (no concrete reuse need yet, master specification).

## 6. Data Requirements

Domain tables are added by Phase 3 via the committed-migration workflow (ADR-0011),
applying the fixed conventions (UUIDv7 stored as `uuid`, `snake_case`, `created_at`,
`updated_at` where mutable, UTC).

### 6.1 `users`

| Column          | Type                 | Constraints / notes                                                                                               |
| --------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`            | `uuid`               | PK; UUIDv7 (ADR-0001).                                                                                            |
| `email`         | `varchar`            | Normalized (lowercase/trimmed, D8); **unique** (case-insensitive by normalization).                               |
| `name`          | `varchar` (nullable) | Display name (bounds per D6).                                                                                     |
| `password_hash` | `varchar`            | Argon2id encoded hash (algorithm, parameters, salt embedded in the encoded string). Never logged, never returned. |
| `created_at`    | `timestamptz`        | UTC.                                                                                                              |
| `updated_at`    | `timestamptz`        | UTC; updated on record changes (password changes arrive in a later phase).                                        |

### 6.2 `refresh_sessions`

| Column       | Type                     | Constraints / notes                                                                      |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| `id`         | `uuid`                   | PK; UUIDv7.                                                                              |
| `user_id`    | `uuid`                   | FK → `users.id` (cascade on user deletion); indexed.                                     |
| `token_hash` | `varchar`                | Hash of the opaque refresh token; **unique** (D3 reuse detection relies on hash lookup). |
| `expires_at` | `timestamptz`            | Session expiry (D10).                                                                    |
| `revoked_at` | `timestamptz` (nullable) | Null while active; set on rotation/logout.                                               |
| `created_at` | `timestamptz`            | UTC.                                                                                     |

### 6.3 Default organization (confirmed in Phase 3 per D4)

Minimal tables required by ADR-0010. The full organizations/RBAC schema (invitations,
role management, validation rules, UI) is owned by Phase 4; Phase 4 builds on these
tables and may add columns/tables by migration — this spec records the minimum and the
coordination requirement (§13).

| Table                  | Minimum columns                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`        | `id` (uuid PK), `name` (varchar, non-empty; derived per D5), `created_at`, `updated_at`                                                                                                      |
| `organization_members` | `id` (uuid PK), `organization_id` (FK), `user_id` (FK), `role` (`varchar` = `'owner'` for the default; Phase 4 defines the role system), `created_at`; unique (`organization_id`, `user_id`) |

### 6.4 Migration and integrity

- One committed migration (or a small set) creating the tables above on top of the
  Phase 2 base.
- Registration transactionality per D4: user + default organization + owner membership +
  first refresh session all-or-nothing.
- Indexes: `users.email` unique; `refresh_sessions.user_id`; `refresh_sessions.token_hash`
  unique; `organization_members(organization_id, user_id)` unique.
- No seed data in this phase. No real secrets or passwords in migrations.

## 7. Security Requirements

1. **Password hashing (ADR-0007):** Argon2id, the required/default algorithm. Encoded
   hash includes algorithm, parameters, and salt. Never stored in plaintext, never
   logged, never returned. No bcrypt exception is proposed in this phase.
2. **Session integrity:** access tokens are signed JWTs with short lifetime (D2).
   Signature/expiry/structure validated on every guarded route. Refresh sessions are
   revocable server-side; rotation and reuse detection per D3.
3. **Credential handling:** refresh tokens are opaque random values; only hashes stored;
   delivered exclusively via `HttpOnly` cookie (`Secure` appropriately, `SameSite`
   minimizing CSRF); never readable by browser JS; never logged.
4. **Brute-force protection:** rate limiting per IP and per account on auth endpoints
   (§4.4); generic, non-enumerating error messages on login failures.
5. **CSRF:** the refresh/logout mutations are cookie-authenticated; `SameSite=Lax` (D2)
   and the cookie `Path=/api/v1/auth` bound exposure. No state-changing cookie-read path
   exists in the web app.
6. **Secure logging:** the Phase 2 base redaction is verified to cover passwords, tokens,
   and auth cookies; auth tests assert no credential-shaped values in logs or responses.
7. **Secrets management:** JWT signing secret via environment, never committed; boot-time
   validation (minimum length, presence) so a weak/absent secret fails fast; `.env.example`
   documents non-secret defaults only.
8. **Enforcement is server-side:** `apps/web` never bypasses API-level authentication or
   authorization; the session guard is the single enforcement boundary for session
   requests.
9. **Enumeration trade-off (accepted):** register’s 409 `CONFLICT` inherently reveals
   that an email is registered. Accepted for the MVP sandbox; login responses do not
   enumerate.
10. **Error safety:** auth error responses never leak internals (stack traces, DB
    details, hashes, token material).
11. **No session-scoped data beyond identity:** Phase 3 guards only establish
    authentication. Authorization (RBAC, tenant isolation) is Phase 4 and must not be
    approximated in this phase.

## 8. Acceptance Criteria

1. `POST /auth/register` creates a user with an Argon2id-hashed password (ADRs 0007),
   returns **201** `AuthSession` (access token, `expires_in`, `user`) and sets the
   `brinnpay_refresh` `HttpOnly` cookie; the refresh token is not present in the body.
2. Registration is atomic: on any failure no partial user/org/member/session rows
   remain (D4).
3. Duplicate email (any case) → **409 `CONFLICT`**; emails are observed to be
   case-insensitive (D8).
4. `POST /auth/login` with correct credentials → **200** `AuthSession` + cookie; with
   unknown email or wrong password → **401 `UNAUTHENTICATED`** with an identical generic
   message in both cases.
5. `POST /auth/refresh` with a valid, active cookie → **200** `AccessTokenResponse`; the
   presented session is rotated (old revoked, new issued) (D3). With a revoked or expired
   session → **401**. With a revoked-but-unexpired token set → all of the user's sessions
   are revoked and **401** (reuse detection, D3).
6. `POST /auth/logout` revokes the session and clears the cookie (behavior with no valid
   session per D9).
7. `GET /auth/me` with a valid access token → **200** `User`; with missing/invalid/
   expired token → **401 `UNAUTHENTICATED`**.
8. Auth endpoints respond **429 `RATE_LIMITED`** when limits are exceeded (IP and
   account-scoped); limits are env-configurable (D7).
9. Cookie attributes verified: `HttpOnly` always; `Secure` in secure environments; path
   `/api/v1/auth`; `SameSite` per D2. The cookie is the only channel for the refresh
   token.
10. The `SessionAuth` guard is implemented as reusable infrastructure (usable by Phase 4+)
    and rejects missing/malformed/invalid tokens with the canonical 401 envelope.
11. No password, token, hash, or cookie value appears in logs or API responses
    (asserted by tests; Phase 2 redaction extended/verified for auth material).
12. `/login` and `/register` in `apps/web` implement the flows of §5.1; session handling
    follows §5.2 (access token in memory only; refresh cookie never read by JS; route
    protection redirects unauthenticated visitors to `/login` and authenticated visitors
    away from `/login`/`/register`; logout clears local state).
13. Prisma migration(s) committed; schema matches §6; `prisma migrate deploy` applies it
    in CI and clean environments.
14. `docs/openapi.yaml` is refined for the confirmed decisions (D2/D6/D9/D10 affected
    descriptions), contains no parallel contract, and remains Redocly-lint clean.
15. All repository checks green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm
test:e2e`, `pnpm build`, locally and in CI.

## 9. Testing Requirements

### 9.1 API (`apps/api`)

- **Unit tests:**
  - password service: Argon2id hash/verify round-trip; distinct salts; verify-failure on
    wrong password; never returns plaintext.
  - token service: access-token sign/validate (expiry, tampering, malformed input).
  - refresh-session service: rotation, revocation, expiry, reuse-detection logic, hash
    lookup.
  - session guard: accepts valid token; rejects missing/malformed/expired; returns the
    canonical 401 envelope.
  - rate limiting configuration: key derivation (IP, account) and limit application.
  - registration transactionality: rollback leaves no partial rows (service-level with
    stubbed DB or integration-level).
- **Integration/e2e (`test:e2e`) against the running app with real PostgreSQL/Redis**
  (CI service containers, Phase 2 D8):
  - full register → me round-trip; register duplicates (case variations) → 409.
  - login success / failure (generic 401 both for unknown email and wrong password).
  - refresh: valid rotation; revoked session → 401; reuse of a rotated token → 401 and
    all sessions revoked; expired session → 401.
  - logout: session revoked, cookie cleared.
  - cookie attributes asserted (HttpOnly, path, Secure in the matching environment,
    SameSite).
  - rate limiting: exceeding limits on login/register → 429.
  - no credential material in logs or response bodies (assertions over captured logs).
  - migrations apply cleanly (`prisma migrate deploy` step in CI, §13).

### 9.2 Web (`apps/web`)

- **Unit tests:** register/login page rendering and validation behavior; auth context
  behavior (in-memory token lifecycle, refresh, logout, 401 → re-authenticate); route
  protection redirects (unauthenticated → `/login`; authenticated away from
  `/login`/`/register`).
- **E2e (`test:e2e`):** extend the Phase 2 smoke pattern — e.g., auth pages render; a
  scripted flow against the real API is covered by the API e2e and/or a minimal web e2e
  stub; full browser e2e remains Phase 17 (D2).

### 9.3 Shared

- All checks run from the repository root (`pnpm -r …`) and in CI.
- Tests require no secrets; test config uses `.env.example`-style defaults; shorter
  token/session lifetimes and rate-limit values must be supported via environment so
  tests run fast and deterministic (D2/D10).

## 10. Definition of Done

Phase 3 is complete when:

- All roadmap checkboxes in §2 are implemented and traced (§11).
- All acceptance criteria in §8 pass.
- All checks (lint, typecheck, unit, integration/e2e, build) pass locally and in CI.
- Decisions D1–D10 are confirmed by the product authority; architecture-level policy is
  recorded as ADRs where applicable, and confirmed decisions are recorded in §12.
- `docs/openapi.yaml` is consistent with the confirmed decisions and lints clean (no
  parallel contract).
- No security-relevant issue remains open: Argon2id in place, no secrets committed, no
  credential material in logs, session guard is the single enforcement boundary.
- Phase 4 (Organizations & RBAC) can start without re-opening Phase 3 decisions
  (including the schema coordination in §13).

## 11. Traceability (Roadmap → Phase 3)

| Roadmap Phase 3 checkbox                 | Specification reference  |
| ---------------------------------------- | ------------------------ |
| User registration                        | §4.2, §6.1, §8.1–8.3     |
| User login                               | §4.2, §8.4               |
| Token/session management (JWT + refresh) | §4.2–4.3, §6.2, §8.5–8.7 |
| Password hashing (bcrypt/argon2)         | §7.1, ADR-0007           |
| Rate limiting (auth endpoints)           | §4.4, §8.8               |
| Authentication UI in `apps/web`          | §5                       |
| Login UI                                 | §5.1                     |
| Registration UI                          | §5.1                     |
| Session handling in the web application  | §5.2                     |
| Auth tests                               | §9                       |

## 12. Implementation Considerations

- **Argon2id dependency (ADR-0007 consequence):** a native/binding dependency is
  introduced in `apps/api`; verify Node 22 and Docker image compatibility (glibc,
  prebuilt binaries) early.
- **JWT:** HS256 with an env-driven signing secret is proposed (D1); the secret is
  validated at boot (length/presence). The `@nestjs/jwt` wrapper or a direct `jose`
  implementation both fit; keep the token claims minimal (D1).
- **UUIDv7:** the shared UUIDv7 generation utility anticipated by Phase 2 (§14.4) is
  needed for `users`, `refresh_sessions` (and per D4 organization rows); introduce it as
  a small base utility in `apps/api`.
- **Rate limiting storage:** Redis is already connected (Phase 2 `RedisModule`); use a
  Redis-backed throttling storage (D7). Trust-proxy configuration must be considered so
  client IPs are resolved correctly behind proxies (local default unaffected).
- **CI:** the API e2e suite will need migrations applied before tests: add
  `prisma migrate deploy` (or equivalent) to the CI e2e step (§9.1); locally
  `prisma migrate dev` applies them.
- **Schema coordination with Phase 4 (D4):** if Phase 3 creates the minimal
  organization/member tables, Phase 4 owns their extension (roles beyond `owner`,
  invitations, validation, UI). Record the minimum schema in this spec (§6.3) and require
  Phase 4 to build on it via migrations — no re-defined tables, no parallel models.
- **Refresh-session cleanup:** lazy cleanup of expired sessions on user operations
  (login/refresh); no background jobs — BullMQ is wired in Phase 10 (ADR-0013).
- **Environment-configurable durations/limits:** access-token lifetime (D2), refresh
  lifetime (D10), and rate-limit values (D7) must be env-driven so tests and sandbox
  deployments can tighten them.
- **Web app API configuration:** `apps/web` needs the API base URL as env config
  (default `http://localhost:3000/api/v1`); cookie round-trips require same-site/cross
  origin setup consistent with CORS config on the API (Phase 2).
- **OpenAPI refinements:** update auth operation descriptions (rotation/reuse semantics,
  cookie attributes, D9 logout behavior, D6 password bounds) in `docs/openapi.yaml`;
  no new endpoints are introduced; keep the file lint-clean (ADR-0012).
- **Anti-goals:** no background jobs, no email delivery, no MFA, no password
  reset/change, no account management beyond auth, no RBAC, no API keys, no audit
  logging (Phases 4/5/12), no dashboard data features.

## 13. Out of Scope

- Authorization, RBAC, tenant isolation beyond authentication (Phase 4).
- Organization management UI/API beyond the ADR-0010 default creation (Phase 4).
- API keys and environment-scoped credentials (Phase 5).
- Password reset, password change, email verification, MFA, SSO, account deletion (not
  in the MVP roadmap; tracking via account settings later).
- Email delivery/notifications of any kind (none in the MVP roadmap for auth).
- Audit logging of auth/security events (Phase 12).
- Rate limiting for non-auth routes, IP + API-key + endpoint-specific limits for the
  whole API, standard rate-limit headers (Phase 13).
- Background jobs / BullMQ wiring (Phase 10, ADR-0013).
- Dashboard features beyond session behavior (Phases 4–16).
- Browser e2e tooling (Phase 17), security hardening review (Phase 18).
- Real payment processing, billing, SSO, microservices (master specification).

## 14. Confirmed Decisions

> **Confirmed by the product authority on 2026-09-19.** All decisions below were adopted
> as recommended (marked **[rec]**) and are binding for the contract, schema, and UI. The
> affected acceptance criteria (§8) and `docs/openapi.yaml` descriptions reflect them.

| #   | Decision                                | Recommended option [rec] / alternatives                                                                                                                                                                                                                                                            |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | JWT algorithm and key management        | **[rec]** HS256 with an env-driven signing secret (validated at boot; min length enforced). Alternative: RS256 keypair (more future-proof, more config).                                                                                                                                           |
| D2  | Access-token lifetime and cookie policy | **[rec]** 15 minutes (env-configurable); cookie `SameSite=Lax`, `Secure` in secure/production environments. Alternative: shorter/longer lifetime; `SameSite=Strict`.                                                                                                                               |
| D3  | Refresh rotation and reuse detection    | **[rec]** Rotate on every refresh; presenting a revoked-but-unexpired token revokes all of the user's sessions (theft response). Alternative: rotation only, no reuse detection.                                                                                                                   |
| D4  | Default-organization creation timing    | **[rec]** Phase 3 creates user + default organization + `owner` membership + first refresh session in one transaction (ADR-0010 satisfied at registration). Alternative: Phase 3 creates user only; the default org is created in Phase 4 (requires a backfill for registrations made in Phase 3). |
| D5  | Default-organization name               | **[rec]** Derived from the display `name` if provided, else the email local part, else `"My Organization"` (bounded length; Phase 4 must accept the generated name). Alternative: fixed literal (e.g., `"Personal"`) for every user.                                                               |
| D6  | Password bounds and policy              | **[rec]** `minLength 8` (as contracted), `maxLength 128` (DoS bound), no composition rules (NIST-style). Alternatives: add composition rules; different max.                                                                                                                                       |
| D7  | Auth rate-limiting defaults and storage | **[rec]** Redis-backed throttling (shared across instances); default e.g. 10 attempts / 15 min per IP and per account email on login/register (env-configurable). Alternatives: in-process only (local-dev fallback); different values.                                                            |
| D8  | Email normalization                     | **[rec]** Store trimmed + lowercased; uniqueness is case-insensitive by normalization. Alternative: case-sensitive uniqueness (rejected: poor UX).                                                                                                                                                 |
| D9  | Logout without a valid session          | **[rec]** Idempotent **204** with cookie cleared. Alternative: **401** `UNAUTHENTICATED` with cookie cleared (matches the current OpenAPI 401 entry; requires contract alignment).                                                                                                                 |
| D10 | Refresh-session lifetime and cleanup    | **[rec]** 30 days per session (env-configurable); rotation opens a new window (effectively sliding); lazy cleanup of expired sessions; no background jobs (ADR-0013). Alternatives: absolute lifetime without sliding; periodic cleanup job.                                                       |

> **Consistency check with prior phases:** no proposed decision contradicts the master
> specification, phase 1/2 decisions, or ADRs 0001–0013. D2/D10 refine values the
> security baseline left open ("exact durations, rotation, and cookie domain details
> belong to Phase 3"). D4/D5 implement ADR-0010's deferred mechanics. D9 aligns logout
> semantics with the existing contract's 401 entry. If the product authority selects a
> non-recommended option, the affected acceptance criteria (§8) and the OpenAPI contract
> must be updated accordingly.

## 15. Dependencies

- Inputs: Phase 2 base (config, validation, error envelope, request IDs, secure logging,
  Prisma/Redis connectivity, CI service containers), phase 1 artifacts and ADRs 0001–0013,
  `docs/openapi.yaml` auth surface.
- Blocks: Phase 4 (Organizations & RBAC) and all subsequent phases.
- Coordination obligations out of this phase: Phase 4 inherits the session guard and the
  minimal organization/member tables (D4); Phase 12 records auth security events; Phase
  13 generalizes rate limiting; Phase 5 introduces API-key authentication alongside the
  session guard.
