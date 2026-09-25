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
| 429    | Rate limited                        |
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
