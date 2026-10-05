# BrinnPay — API Conventions

> Architecture artifact of **Phase 1 — Architecture & MVP Spec** (phase 1 specification §7, §8, §13.1).
> These conventions bind all endpoint-level phases (3–13). The canonical contract is
> [`openapi.yaml`](openapi.yaml); this document explains and records the conventions behind it.

## 1. Base path and versioning

- Versioned via URL prefix: `/api/v1/...` (ADR-0005).
- The version is part of the URL; consumers pin to a version explicitly. There is no negotiation
  header or default-version fallback.
- No breaking changes within a version. Breaking changes require a new version (e.g., `/api/v2`).
- First version: `v1` (the only version during the MVP).

### Versioning concepts

Three distinct version numbers exist and are **not assumed to be identical**:

| Concept | Meaning | Value |
| --- | --- | --- |
| Product release | Version of the whole BrinnPay product, released at MVP milestone | `v0.1.0` (roadmap Phase 26) |
| API path version | The version segment in request URLs, pinned by consumers | `/api/v1` (only version in the MVP) |
| OpenAPI document version | Version of the contract document (`info.version` in `docs/openapi.yaml`) | `1.0.0`, tracking `<api-major>.<document-revision>.<patch>` |

The OpenAPI `info.version` is a **document version**, not the product release. The API path version
(`v1`) is what consumers depend on; the contract document may be revised independently of the
product release. The product release (`v0.1.0`) is decoupled from both.

## 2. Naming

- Resources are named as plural nouns (`/customers`, `/payments`).
- Nested resources are expressed with path hierarchy where ownership is strict
  (`/payments/{payment_id}/refunds`).
- Path parameters use `snake_case`; request and response JSON uses `snake_case`.
- Query parameters for filtering and pagination use `snake_case`.
- Endpoint names in OpenAPI follow `operationId` conventions derived from module + action
  (e.g., `payments.create`, `organizations.listMembers`).

## 3. Authentication modes per route

- API access via `Authorization: Bearer <api_key>` (ADR-0006). Keys are
  `sk_test_...` / `sk_live_...` and are scoped to exactly one project + environment.
- Dashboard/user endpoints authenticate via session (JWT access token).
- The two authentication modes are **not equivalent** and are documented and enforced separately
  per route (see the `security` key of each operation in `docs/openapi.yaml`): API-key requests
  act only within the key's project/environment scope; session requests are scoped to the user's
  organization memberships and are subject to RBAC. The web session model is defined in
  phase 1 §11.5 (access token in memory; refresh token only in an `HttpOnly` cookie).

| Route area                                                        | Auth mode(s)           | Rationale                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `auth/*`, `organizations/*`, `projects/*`, `api-keys/*`, `logs/*` | Session only           | Dashboard/user management surfaces.                                                                                         |
| `customers/*`, `payments/*`, `refunds/*`, `webhook-*`             | API key **or** session | Developer integration surface; the dashboard also renders these pages by fetching under the user's session (phase 1 §11.4). |

For API-key-authenticated requests the project environment is derived from the key; payload/query
environment values must match the key's environment. With session authentication the environment
must be provided explicitly in the payload (`environment` field) or query filter.

## 4. Idempotency

- Critical mutations (payment creation, refund creation) accept an `Idempotency-Key` header.
- The scope of a key is the tuple **(project, operation_scope, idempotency_key)**, where
  `operation_scope` identifies the specific idempotent operation (`payments.create`,
  `refunds.create`; the catalog can grow in later phases).
- Within the retention window:
  - same project + same operation scope + same key → replay of the original stored response
    without re-executing the operation (ADR-0004);
  - same project + different operation scope + same key → an independent operation (keys never
    collide across operations of the same project).
- **After 24 hours**, reuse of the same key is treated as a new operation.
- The 24-hour retention window is a single configurable constant shared by storage and API
  documentation (ADR-0004, `IDEMPOTENCY_RETENTION_HOURS`).
- Concurrency is handled by the database: the claim, the mutation and the stored response share one
  transaction, so concurrent same-key retries produce exactly one side effect and every caller
  observes the committed response (Phase 8).
- Only **committed successful** responses are replayed. A request rejected by validation,
  authentication, authorization or a business rule stores nothing, so the same key remains usable
  by a later, correct request.
- The project is part of the scope, not the authentication mode: the same key replayed through a
  different authentication mode for the same project is still a replay.
- A replayed response is served with the current request's `X-Request-Id`; request-scoped tracing
  data of the original request is never replayed.
- Idempotency behavior is documented and reflected in the OpenAPI contract
  (`Idempotency-Key` header on `payments.create` and `refunds.create`).
- Consumer status: **`payments.create` is the first live consumer** (Phase 8); `refunds.create` is
  the next planned consumer and reuses the same capability (Phase 9).

## 5. Pagination

- Cursor-based pagination (roadmap Phase 6 requirement).
- List endpoints accept `limit` and `cursor`; responses include a `next_cursor` (nullable) and
  result metadata (`has_more`).
- Cursor values are opaque to clients; the server derives them from the time-ordered entity IDs
  (UUIDv7, ADR-0001).
- Clients must not decode, persist for reuse across unrelated lists, or infer ordering guarantees
  beyond the documented `next_cursor` contract.

## 6. Errors

Consistent JSON error envelope across all endpoints:

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

- `code` is a stable machine-readable string; `details` is optional structured information
  (validation fields etc.). General codes include `VALIDATION_ERROR`, `UNAUTHENTICATED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`; domain phases add business-specific codes
  such as `PAYMENT_ALREADY_REFUNDED`.
- Error responses never leak internals (stack traces, database details, secrets).
- HTTP status codes follow standard REST semantics:

| Status | Meaning                             |
| ------ | ----------------------------------- |
| 400    | Validation failure                  |
| 401    | Unauthenticated                     |
| 403    | Forbidden (RBAC / tenant isolation) |
| 404    | Not found                           |
| 409    | Conflict                            |
| 422    | Business rule violation             |
| 429    | Rate limited (see §10)              |
| 5xx    | Server error                        |

## 7. Request IDs

- Every request is assigned a request ID at ingress.
- Every response carries it in the `X-Request-Id` header; the error envelope repeats it in
  `error.request_id`.
- It is propagated through logs, error responses, and outbound webhook-delivery records.
- Clients can reference a request ID when reporting issues.

## 8. Time, IDs, and format conventions

- All timestamps are UTC, ISO 8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`).
- All entity IDs are UUIDv7 (ADR-0001) and must be treated as **opaque strings** by clients;
  authorization never relies on ID secrecy.
- The `ApiKey` credential string (`sk_test_…`/`sk_live_…`, ADR-0006) is **credential material, not
  an entity ID**; it follows its own scheme. Request IDs follow the `req_...` scheme.
- Monetary amounts are decimal strings in the API paired with a lowercase currency code; integer
  minor units internally (ADR-0002):

```json
{ "amount": "10.00", "currency": "usd" }
```

- Environment values in the API are lowercase: `test` and `live` (see the outbound event envelope,
  phase 1 §9.5). Conceptually and in UI copy the environments are written uppercase (`TEST`, `LIVE`);
  API keys carry the prefix `sk_test_…`/`sk_live_…`. The two spellings map by context and are never
  mixed within a single artifact (phase 1 §5.2).

## 9. Data requirements (domain level)

- **IDs**: UUIDv7 for all entity IDs (ADR-0001); stored as PostgreSQL `uuid`; exposed to the API as
  opaque strings.
- **Money**: integer minor units internally; decimal strings in the API (ADR-0002).
- **Currency scope**: USD only in the MVP; `currency` remains on payments/refunds for forward
  compatibility; validation rejects non-`usd` values (ADR-0003).
- **API keys**: prefixed `sk_test_…`/`sk_live_…`; shown once at creation; only a hash stored; never
  logged; unique per project environment (ADR-0006).
- **Idempotency**: database-level uniqueness on (project, operation_scope, key) for active records;
  24-hour retention; keys reusable as new operations after expiry (ADR-0004).
- **Request logs**: API-wide records; `request_id` is mandatory; project/organization/user/API key
  scope is optional so public and authenticated requests are both representable (phase 1 §8,
  Phase 11).
- **Audit logs**: append-only; entries are never updated or deleted.
- **Timestamps**: UTC; every record carries `created_at`; mutable records carry `updated_at`.
- **Sessions**: short-lived JWT access tokens (never stored in web storage) + revocable
  refresh sessions exposed to the browser only via an `HttpOnly` cookie (phase 1 §11.5).
- **Environments**: a project supports both `TEST`/`LIVE` (API: `test`/`live`) by default; each
  environment-scoped resource belongs to exactly one environment and TEST/LIVE data is never mixed
  (phase 1 §5.2).

## 10. Rate limiting

> Authoritative policy source for **Phase 13 — Rate Limiting** (phase 13
> specification §4, §6.2). Phase 15 renders this section publicly; the same
> numbers appear in `openapi.yaml` (`info.description` → *Rate limiting*) and in
> `components/headers`.

Every request under `/api/v1` is rate limited. The limits exist to bound
credential guessing, scraping, enumeration and outbound amplification — they are
an abuse control, not a quota product.

### 10.1 Dimensions (scopes)

| Scope | Discriminator | Applies to |
| --- | --- | --- |
| `ip` | Normalized client identity | Every request under the prefix |
| `api_key` | The resolved API key's id (never the presented plaintext) | API-key-authenticated operations of a class that declares it |
| `account` | Normalized account email | `POST /auth/register`, `POST /auth/login` |

- There is **no** session-user dimension and **no** per-organization dimension.
  Session-authenticated requests are covered by `ip`, and credential guessing is
  already covered per `account`.
- An API-key-authenticated request consumes **both** its `ip` and its `api_key`
  budget; a session-authenticated request consumes only `ip`.
- Budgets are isolated: exhausting one key's budget does not throttle a second
  key, a key of another project, or session traffic from the same client.
- The `ip` budget is the one dimension that is **shared across tenants**: every
  client behind one egress address (a corporate NAT, a shared proxy) spends the
  same `ip` bucket, so one tenant's traffic can exhaust it for the others. That
  is inherent to keying on an address rather than on an identity, and it is why
  `ip` limits are deliberately generous.

### 10.2 Operation classes

Every operation belongs to exactly one class of this closed catalog. There is no
per-operation limit table; the catalog *is* the endpoint-specific policy. The
values below are deployment configuration (environment variables), and the
numbers shown are the sandbox defaults.

| Class | Operations | Limit / window | Scopes |
| --- | --- | --- | --- |
| `auth.session-creation` | `POST /auth/register`, `POST /auth/login` | 10 / 900 s | `ip`, `account` |
| `auth.refresh` | `POST /auth/refresh`, `POST /auth/logout` | 60 / 900 s | `ip` |
| `auth.read` | `GET /auth/me` | 100 / 900 s | `ip` |
| `read` | every other `GET` | 600 / 60 s | `ip` |
| `write` | every other `POST`/`PATCH`/`DELETE` | 120 / 60 s | `ip`, `api_key` |
| `webhook.replay` | `POST /projects/{project_id}/webhook-endpoints/{endpoint_id}/events/{event_id}/replay` | 20 / 300 s | `ip`, `api_key` |
| `webhook.endpoint-create` | `POST /projects/{project_id}/webhook-endpoints` | 10 / 3600 s | `ip`, `api_key` |

- Each class uses one **fixed** window, anchored at the **first** counted request
  in that window rather than at a calendar boundary. Counting and window creation
  are atomic and shared through Redis, so replicas cannot disagree about a budget.
- Limits are deliberately generous: a sandbox whose own developer cannot run a
  payment/retry/replay loop is not usable. Raising one is an environment change,
  never a code change.
- Configuration is validated at boot: a non-integer or non-positive limit or
  window fails to start the service rather than silently disabling throttling.

### 10.3 What counts

A request that reaches the limiter consumes one unit of every applicable scope —
**including** requests later rejected with `400`, `401`, `403`, `404`, `409`,
`422` or `5xx`, and including idempotent replays. Excluded before any counting:
CORS preflight requests, `GET /health/live`, `GET /health/ready`, Swagger UI
traffic, and anything outside `/api/v1`.

The `ip` check runs **before** route authentication, so an unauthenticated flood
is bounded without a database lookup. The `api_key` check runs after the key has
been resolved.

One case is deliberately outside this: a request to a path that matches no route
returns `404` without consuming budget, because a guard cannot run for a route
that was never matched. It is still request-logged, so an attacker who scans
nonexistent paths writes a row per request while spending nothing. The scan
itself does no handler work, and write amplification belongs to Phases 19/20
(spec §16), which own the request-log and load-test work.

### 10.4 Response headers

| Header | On | Meaning |
| --- | --- | --- |
| `RateLimit-Limit` | every response of a limited route | Limit of the reported budget |
| `RateLimit-Remaining` | every response | Units left in the current window |
| `RateLimit-Reset` | every response | Whole seconds until the window resets |
| `Retry-After` | `429` only | Whole seconds until the reported budget's window resets |

- When more than one scope applies, the reported budget is the one **closest to
  exhaustion** (lowest remaining, ties broken by the catalog's scope order), so a
  caller is never told there is headroom on a request that is about to be
  rejected.
- `RateLimit-Reset` and `Retry-After` come from the same atomic read as
  `RateLimit-Remaining`; they are never estimated and are never zero or negative.
- These four headers are listed in `Access-Control-Expose-Headers`, so a
  cross-origin browser client can read its own remaining budget without a proxy
  change. Nothing else is exposed, and no header discloses a discriminator, a key,
  or an internal class or scope name.

### 10.5 What a 429 means for retries

- `429 RATE_LIMITED` is **retryable**, not an authorization or data problem. The
  handler did not run, no state changed, and `Retry-After` says when to return.
- `error.details` carries budget numbers only: `limit`, `remaining`,
  `window_seconds`. It never carries an identity, a scope, a class name, or a
  Redis key.
- A `429` reveals nothing about whether a credential, key, project or
  organization exists. The `ip` stage runs before authentication, so its `429`
  is identical whether or not a presented key exists. The `api_key` stage runs
  only after a key has resolved to a valid, unrevoked record, so an unknown or
  revoked key is rejected with `401` first; a `429` from that stage discloses
  only the budget the caller has already been told about.
- **The `account` scope is per-account, not per-attacker.** Login and register
  charge it on the submitted email *before* the request is validated, so anyone
  who can guess an address can spend its budget and keep it spent — 10 attempts
  per 900 s, refreshed as fast as the attacker repeats. The address's real owner
  then sees `429` for the rest of that window. That is deliberate: an
  unauthenticated attacker must not be able to buy unlimited attempts against
  one account. The cost is a targeted, repeatable lockout of any address the
  attacker can name, and nothing distinguishes the attacker's attempts from the
  owner's. Recovering from it belongs to the auth experience, not to the limiter.
- A throttled request is still request-logged and writes no audit entry.
- A `429` stores no idempotency record, so the same `Idempotency-Key` remains
  usable afterwards.

### 10.6 Redis unavailability

- **Default (fail open).** Enforcement degrades to a bounded in-process store
  with a single non-identifying warning. Limits are then enforced per process
  only. A Redis error never becomes a `5xx`, and readiness is unaffected.
- **Optional (fail closed).** `RATE_LIMIT_FAIL_MODE=closed` rejects with `429`
  instead, for deployments that prefer enforcement over availability.
- The in-process store starts counting from the request that first reaches it,
  so during the crossover — after a process start, or after Redis comes back
  following an outage — a bucket can admit up to about twice its limit before
  the Redis counter takes over. The window ends when the connection reaches
  `ready`, command timeout and reconnect backoff included, and lasts one
  crossover per episode.

### 10.7 Client identity and proxy trust

The client identity is the direct socket peer unless the deployment explicitly
configures a bounded proxy trust, and then only as far as that configuration
allows:

- `TRUST_PROXY_CIDRS` lists the proxy addresses and is **mandatory with any
  positive `TRUST_PROXY_HOPS`**; boot refuses the combination without it,
  because a hop count bounds how much of the chain is read and never who
  wrote it. Name only the proxy addresses (a `/32` or `/128` each). The floor
  is `/8` for an IPv4 entry and `/32` for an IPv6 one — an IPv6 block is 4
  billion times larger per prefix bit: `2000::/8` is every globally routable
  peer and `::/8` contains the whole IPv4-mapped range, so either would put
  the peer gate open to the internet rather than to a fleet. An IPv6 entry in
  the IPv4-mapped range (`::ffff:0:0/96`) is an IPv4 range in disguise and is
  held to the IPv4 floor as well.
- `TRUST_PROXY_HOPS` must equal the real proxy depth. Set it too small and the
  chain is read no further than that, so every client behind the chain lands
  in one shared bucket; too large is harmless, the walk still stops at the
  first untrusted entry.
- The proxy must **append** to `X-Forwarded-For`. A proxy that forwards the
  caller's header unchanged cannot be told apart from the caller, so no
  configuration can recover a client identity behind it.
- Forwarded headers from any other source are ignored for limit purposes, and
  the identity is canonicalized before use so one client cannot hold several
  budgets by varying the textual form of its address.

### 10.8 Environment variables

| Variable | Class / purpose | Default |
| --- | --- | --- |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `auth.*` window (unchanged names, Phase 3) | `900` |
| `AUTH_RATE_LIMIT_IP_LOGIN_MAX` | `auth.session-creation` (`ip`) | `10` |
| `AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX` | `auth.session-creation` (`account`) | `10` |
| `AUTH_RATE_LIMIT_IP_REFRESH_MAX` | `auth.refresh` (`ip`) | `60` |
| `AUTH_RATE_LIMIT_IP_READ_MAX` | `auth.read` (`ip`) | `100` |
| `RATE_LIMIT_READ_MAX` | `read` | `600` |
| `RATE_LIMIT_WRITE_MAX` | `write` | `120` |
| `RATE_LIMIT_WINDOW_SECONDS` | shared `read`/`write` window | `60` |
| `RATE_LIMIT_WEBHOOK_REPLAY_MAX` | `webhook.replay` | `20` |
| `RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS` | `webhook.replay` window | `300` |
| `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX` | `webhook.endpoint-create` | `10` |
| `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS` | `webhook.endpoint-create` window | `3600` |
| `RATE_LIMIT_FAIL_MODE` | `open` \| `closed` | `open` |
| `TRUST_PROXY_HOPS` | trusted proxy hops (`0` trusts nothing forwarded) | `0` |
| `TRUST_PROXY_CIDRS` | CIDR allowlist of trusted proxies | empty |

No value is a secret: rate-limit configuration is non-secret operational tuning.
