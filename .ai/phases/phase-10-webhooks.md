# Phase 10 — Webhooks

| | |
| --- | --- |
| Phase | 10 — Webhooks |
| Status | **Approved — decisions D1–D16 confirmed by product authority (2026-09-28)** |
| Depends on | Phases 7 (payments + event catalog), 9 (refunds + event catalog), 8 (idempotency), 6 (customers), 5 (projects/API keys), 4 (RBAC), 2 (foundation, Redis), 1 (architecture, event system) |
| Blocks | Phase 11 (request logging), 12 (audit logs), 13 (rate limiting), 15 (webhooks guide), 16 (sandbox webhook failure simulation), 17 (testing), 18 (security hardening), 20 (observability) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 10 |

## 1. Objective

Make the event system real: **persist** domain events, **deliver** them to developer-registered
endpoints with **HMAC-SHA256 signatures**, **retry** failed deliveries with backoff, and support
**manual replay** — plus the versioned REST surface and the dashboard webhooks area that the
Phase 1 contract already declares.

Phase 10 discharges the explicit obligations left open by earlier phases:

- Phase 1 §9.1/§9.5/§10: persistence, delivery, retry and replay behavior for the event system.
- Phase 7 §4.7: the payments event sink is a no-op; the payment/refund event seam is only
  best-effort. Phase 10 gives it durable persistence and delivery.
- Phase 9 §5: `refund.created` is emitted into a no-op sink; persistence and delivery belong here.
- ADR-0013: BullMQ dependencies, queues and workers are introduced **here**, not in Phase 2.
- `docs/security-baseline.md` §3/§5: "webhook signing secrets: returned exactly once at
  endpoint creation" and "HMAC-SHA256 webhook signing → Phase 10".

No money moves, both environments stay simulated, and the event catalog is **not** extended here.

## 2. Scope

| Roadmap checkbox | Specification reference |
| --- | --- |
| Event system | §4.1–§4.3, §5 (persistence, envelope, scope) |
| Webhook registration | §4.4, §6 (endpoint CRUD on the contracted routes) |
| HMAC-SHA256 signature verification | §5.2 (produced by BrinnPay; verified by the consumer) |
| Redis/BullMQ queue for delivery | §5.3, §5.5 (durable event store + delivery queue + worker) |
| Retry policy (exponential backoff) | §5.4, D5 |
| Webhook replay | §4.4, §5.6, D12 |
| Webhook management UI | §7 |
| Webhook event and delivery visibility in the dashboard | §7 |

Also required to keep the phase self-consistent (§3 findings F2, F3, F7):

- Introduce BullMQ and a queue worker (ADR-0013) without breaking the single-process local
  development experience.
- Extend the RBAC capability registry with webhook capabilities (§4.5, D10).
- Replace the dashboard webhooks placeholder.
- Refine the canonical contract **in place** (ADR-0012): the `webhooks.*` operations already
  exist; this phase rewrites the descriptions that say behavior "is refined in Phase 10" and
  resolves the 422 semantics, without adding a new API version.

Explicitly **not** extended here: the event catalog, the payment state machine, refund rules,
idempotency coverage of webhook mutations, and any new resource route.

## 3. Context and current-state findings

**What exists today**

- `docs/openapi.yaml` already declares the full webhook surface: `webhooks.listEndpoints`,
  `createEndpoint`, `retrieveEndpoint`, `updateEndpoint`, `deleteEndpoint`, `listDeliveries`,
  `listEvents`, `replayEvent`, and the `WebhookEndpoint`, `WebhookEndpointCreated`,
  `WebhookEndpointCreate`, `WebhookEndpointUpdate`, `WebhookEvent`, `WebhookDelivery` schemas and
  their list envelopes. Both auth modes are already declared on every operation.
- `apps/api/src/payments/payment-events.ts` and `apps/api/src/refunds/refund-events.ts` define the
  catalog and the `*_EVENT_SINK` DI seams; both modules bind a **no-op** sink
  (`NoopPaymentEventSink`, `NoopRefundEventSink`).
- `payment.created` and `refund.created` are emitted from the idempotency capability's
  `afterCommit` hook, which is deliberately fire-and-forget ("a post-commit failure must not fail an
  already-committed mutation"). `payment.succeeded`/`payment.failed` are emitted from
  `PaymentsService.advance()` **only when the payment is read** (list/retrieve catch-up) and
  outside any domain transaction.
- `apps/api/prisma/schema.prisma` has no webhook tables. `redis.service.ts` proves connectivity
  only; there is no BullMQ dependency, queue, or worker, and `docker/compose.yml` has no worker
  service (ADR-0013 defers all of this to this phase).
- The dashboard webhooks page is a placeholder whose text says "Webhooks arrive in Phase 9".
- The dual-mode project-scoped guard is now duplicated three times (customers, payments, refunds).

**Findings that this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | Phase 1 §6.2 calls `WebhookDelivery` "one delivery attempt", but the contract's `WebhookDelivery` has an `attempts` counter and the states `pending`/`delivered`/`failed` — i.e. an aggregate over attempts, not one attempt. | D4 — the contract wins (ADR-0012); phase 1's phrasing is conceptual. |
| F2 | No reads ⇒ no `payment.succeeded`. Without a driver, terminal payment webhooks are never emitted or delivered. | D3 — a scheduled advancement sweep; read-time catch-up stays as a backstop. |
| F3 | Event emission is post-commit and best-effort: a crash between commit and enqueue loses the event, and a Redis outage would fail nothing but deliver nothing. | D2 — persist the event inside the domain transaction; enqueue is best-effort plus a reconciliation job. |
| F4 | Phase 1 §7.7 requires the request ID to be propagated to "outbound webhook-delivery records", but the event envelope (§9.5) has no request ID and the contract's `WebhookDelivery` has none either. | D4/§5.1 — the delivery record carries the originating `request_id`; the envelope shape is not changed. |
| F5 | A webhook secret must be **recoverable** to sign, unlike API keys which are hashed (ADR-0014). The contract says "returned exactly once", not "stored hashed". | D8 — storage scheme is an explicit decision, not an inference. |
| F6 | `webhook-endpoints` list takes `environment` as a query parameter, `create` carries it in the body, and retrieve/patch/delete/deliveries/replay have **no** environment parameter. | §4.4 — the endpoint is the address; its environment is derived, and cross-environment access is a 404 in API-key mode (Phase 7 D1 pattern). |
| F7 | No queue topology exists; running a worker inside the request-serving process couples delivery latency to API traffic. | D14 — worker process topology is an explicit decision. |
| F8 | The contract declares 422 on `create`, `update`, `delete`, and `replay` without naming the business rules. | §4.4/D12 — map each 422 to a named rule; no delete-time rule is invented. |
| F9 | `webhook-events` and `deliveries` accept no filters (`type`, `status`), which limits dashboard usability. | D15 — additive optional query parameters; **confirmed**, §4.4. |
| F10 | The dashboard webhooks placeholder is stale ("Phase 9"). | §7 — replaced by this phase. |

## 4. API application — `apps/api`

### 4.1 Module purpose

A `webhooks` domain module owns three responsibilities and nothing else:

1. **Event persistence** — an inbound port (the Phase 7/9 `*_EVENT_SINK` seams) that durably
   records an event in the emitting module's transaction and then schedules delivery.
2. **Endpoint registry** — CRUD for `webhook_endpoints` with environment and subscription rules.
3. **Delivery** — the outbound HTTP client, HMAC signing, retry/backoff, delivery records, and
   manual replay.

Boundaries (phase 1 §6.3/§6.4): the payments and refunds modules keep owning their event
catalogs and emission points; they call the webhooks module's port and never touch
`webhook_*` tables. The webhooks module never writes to payments/refunds tables. A
transaction handle produced by the cross-cutting idempotency capability may be passed across the
port so an event commits atomically with its mutation.

### 4.2 Event catalog (unchanged, inherited)

| Event type | Owner | Trigger | `data` |
| --- | --- | --- | --- |
| `payment.created` | Phase 7 §4.7 | payment committed with status `pending` | contracted `Payment` |
| `payment.succeeded` | Phase 7 §4.7 | `processing → succeeded` edge applied | contracted `Payment` |
| `payment.failed` | Phase 7 §4.7 | `processing → failed` edge applied | contracted `Payment` |
| `refund.created` | Phase 9 D2 | refund committed as `succeeded` | contracted `Refund` |

Phase 10 adds **no** event type, changes no payload, and does not revisit the absence of
`payment.processing` (Phase 16 owns that question). The catalog is a single shared constant so
endpoint validation (§4.4) and delivery matching cannot drift from the emitters.

### 4.3 Event rules

1. An event is an **immutable record** scoped to exactly one (project, environment) with a UUIDv7
   `id`, a `type`, a `created_at`, and the phase 1 §9.5 `data` snapshot. TEST and LIVE events are
   never mixed and are never delivered to an endpoint of the other environment.
2. The **outbound envelope is fixed** by phase 1 §9.5 (`id`, `type`, `created_at`, `data`,
   `environment`, `project_id`). It is both the stored payload and the exact request body, so a
   replayed event is byte-identical to the original. Nothing request-scoped may be injected into
   the envelope.
3. `data` is a **point-in-time snapshot**. Later changes to the payment or refund do not rewrite a
   stored event.
4. An event exists if and only if the business transaction that produced it committed. A
   rolled-back mutation and an idempotency replay (§4.4) produce no event.
5. Persistence is **at-least-once safe**: the emitter owns the event `id`, so re-persisting the
   same event is a no-op, never a duplicate row.
6. An event produces **at most one delivery per matching endpoint**. Matching means: same project,
   same environment, `enabled = true`, and the event `type` present in the endpoint's
   `event_types`. Non-matching endpoints get no delivery row and no job.
7. Enqueueing is **best-effort by design** and must never fail a domain request: if Redis or the
   queue is unavailable, the event stays persisted, the API request still succeeds, and a
   reconciliation pass creates the missing deliveries later (D2).
8. Delivery is **at-least-once** with **no ordering guarantee**. A destination may receive the
   same event more than once (for example, a timeout after the destination already processed the
   request), and events may arrive out of order or concurrently. This is a documented
   non-guarantee, not a defect to be engineered away in the MVP; consumers dedupe on the envelope
   `id`.
9. `enabled = false` gates **enqueueing only**. Deliveries already queued are still attempted
   (D11); the flag is a switch for future events, not a cancellation.
10. Deleting an endpoint stops all further deliveries to it and removes its delivery records;
    the project-scoped events survive, so retained events remain replayable to other endpoints
    (§5.6).
11. The request ID that caused an event is recorded on the delivery rows it produces (phase 1
    §7.7, F4). It is not part of the envelope and is not sent to the destination.

### 4.4 API behavior and authorization

Every route is project-nested and dual-mode, exactly like customers/payments/refunds: API-key
mode pins the path project to the key's project and derives the environment from the key; session
mode resolves project → organization → membership → capability with the established 404/403
non-disclosure semantics. The API — never the web UI — is the authority.

**Environment rule (mirrors Phase 7 D1):** `webhooks.listEndpoints` requires `environment` as a
query parameter under session authentication (missing → 400 field error) and derives it from the
key under API-key authentication (explicit conflicting value → 422). `webhooks.createEndpoint`
carries `environment` in the body and follows the same required/match rules. All other operations
derive the environment from the addressed endpoint (F6) and are therefore **not** environment
parameters; in API-key mode an endpoint of the key's project but the other environment is a 404.

| Operation | Behavior | Result |
| --- | --- | --- |
| `GET /projects/{project_id}/webhook-endpoints` | Authorize; list the environment's endpoints with `limit` (default 20, max 100) and `cursor`, UUIDv7 ascending, `{ data, next_cursor, has_more }`. Never returns secrets. | 200 `WebhookEndpointList`; 400 malformed pagination/missing session environment; 401/403/404. |
| `POST /projects/{project_id}/webhook-endpoints` | Authorize; accept `WebhookEndpointCreate` (`environment`, `url`, `event_types` ≥ 1 catalog types, optional `enabled` default `true`). Validates the URL and the subscription (D1). | 201 `WebhookEndpointCreated` (secret returned **only** here); 400 invalid body; 401/403/404; 422 environment mismatch. |
| `GET /projects/{project_id}/webhook-endpoints/{endpoint_id}` | Authorize; resolve the endpoint within the addressed project/environment. Never returns the secret. | 200 `WebhookEndpoint`; 401/403/404. |
| `PATCH /projects/{project_id}/webhook-endpoints/{endpoint_id}` | Authorize; partial update of `url`, `event_types`, `enabled`; at least one field; same validation as create. Never rotates the secret (D8). | 200 `WebhookEndpoint`; 400 invalid/empty body; 401/403/404; 422 environment mismatch. |
| `DELETE /projects/{project_id}/webhook-endpoints/{endpoint_id}` | Authorize; delete the endpoint; stop deliveries; cascade its delivery records (D11). | 204; 401/403/404. |
| `GET /projects/{project_id}/webhook-endpoints/{endpoint_id}/deliveries` | Authorize; cursor-paginated attempts for that endpoint only, newest-last ordering consistent with the shared cursor helper. Optional `status` filter (D15). | 200 `WebhookDeliveryList`; 400 malformed pagination or invalid `status`; 401/403/404. |
| `POST /projects/{project_id}/webhook-endpoints/{endpoint_id}/events/{event_id}/replay` | Authorize; the event must belong to the same project **and** environment as the endpoint and must still be retained; the endpoint must still be enabled and subscribed (D12). Creates a new delivery for the same event. | 202 accepted and queued; 401/403/404 (unknown/foreign/expired event, unknown/foreign endpoint); 422 replay preconditions not met. |
| `GET /projects/{project_id}/webhook-events` | Authorize; cursor-paginated events of the environment, ascending by id, exposing the exact stored envelope. Optional `type` filter (D15). | 200 `WebhookEventList`; 400 malformed pagination/missing session environment/invalid `type`; 401/403/404. |

Additional rules:

- **Ids**: `project_id`, `endpoint_id`, and `event_id` follow the existing convention — a
  malformed id is a 404, never a 400, and never reveals whether a foreign resource exists.
- **Errors**: the canonical envelope and codes only. Malformed URLs, malformed/empty
  `event_types`, unknown event types, unknown body fields, and unknown `type`/`status` filter
  values → 400 `VALIDATION_ERROR` with a `details.fields` entry. Non-member/unknown project/foreign
  or cross-environment endpoint/event → 404 `NOT_FOUND`. Member without the capability → 403
  `FORBIDDEN`. API-key environment mismatch → 422 `BUSINESS_RULE_VIOLATION`. The contract's 422 on
  `delete` is **reserved and unused** in this phase: no delete-time business rule is invented (F8).
  Do not add a new error code silently.
- **Filters (D15)**: `type` on `webhook-events` and `status` on `.../deliveries` are optional,
  additive query parameters. `type` must be a catalog type; `status` must be a `WebhookDelivery`
  status. An absent filter returns everything; a filter never changes cursor semantics and
  pagination remains stable under filtering.
- **Secrets**: the signing secret is returned exactly once, in the 201 create response, and never
  by list/retrieve/patch, never in an error, and never in a log line. It is not recoverable
  through any v1 operation (D8).
- **Idempotency**: `Idempotency-Key` is **not** accepted on webhook mutations. Phase 1 §7.4 scopes
  idempotency to payment and refund creation; adding a scope here is a contract change and is out
  of scope (§11).
- **Rate limiting**: no new limits; the all-route limits are Phase 13. A per-project endpoint cap
  is not introduced (D16).
- Request IDs, alternative security requirements, cursor semantics, and response conventions are
  inherited unchanged from `docs/api-conventions.md`.

### 4.5 Authorization model (D10)

Extend the Phase 4 capability registry (single source of truth in `organizations/roles.ts`) with
`webhooks.read`, `webhooks.create`, `webhooks.update`, `webhooks.delete`, `webhooks.replay`:

| Capability | owner | admin | member | viewer |
| --- | --- | --- | --- | --- |
| `webhooks.read` (endpoints, events, deliveries) | ✓ | ✓ | ✓ | ✓ |
| `webhooks.create` | ✓ | ✓ | — | — |
| `webhooks.update` (incl. `enabled`) | ✓ | ✓ | — | — |
| `webhooks.delete` | ✓ | ✓ | — | — |
| `webhooks.replay` | ✓ | ✓ | — | — |

The contract states that `delete` and `replay` "require an administrative role". Under session
authentication that is owner/admin. Under **API-key** authentication no role exists; per D10 a
project-scoped API key may perform every webhook operation within its own project and
environment, exactly as it may create payments — mirroring Phase 5/6/7, where a project credential
is a full project operator and capabilities are not evaluated. **Confirmed.**

### 4.6 Validation rules (WHAT, not HOW)

- `url`: absolute `http`/`https` URL, no credentials in the authority, no fragment, length ≤
  2048, host present. Normalization is limited to lowercasing scheme/host and stripping a trailing
  `/` on the path; the stored value is what is delivered to.
- `event_types`: non-empty array of distinct, catalog-known types (§4.2). Unknown or malformed
  types are rejected rather than stored (D1) — the catalog is closed and owned by the domain
  modules, so silently accepting an unknown type would create an endpoint that can never fire.
- `enabled`: boolean, default `true` on create; omitted means unchanged on patch.
- Body validation follows the existing global pipe behavior used by the other modules (no unknown
  fields, strict types).

## 5. Event persistence, delivery, signing and retry

### 5.1 Persistence model (WHAT must be durable)

`webhook_events` (project-scoped, immutable):

| Column | Notes |
| --- | --- |
| `id` | PK, UUIDv7 (ADR-0001). Supplied by the emitter; re-persistence is a no-op. |
| `project_id` | FK → `projects.id` `ON DELETE CASCADE` (tenant isolation, ADR-0011). |
| `environment` | `test`/`live`, app-validated. |
| `type` | Catalog type, app-validated. |
| `payload` | `jsonb` — the complete phase 1 §9.5 envelope body. |
| `created_at` | UTC, the event's own timestamp. |

`webhook_deliveries` (endpoint-scoped aggregate, D4):

| Column | Notes |
| --- | --- |
| `id` | PK, UUIDv7. Identifies the delivery and is exposed to the destination as a header (D7). |
| `endpoint_id` | FK → `webhook_endpoints.id` `ON DELETE CASCADE` (D11). |
| `event_id` | FK → `webhook_events.id` `ON DELETE CASCADE`. |
| `status` | `pending` \| `delivered` \| `failed` (contract enum). |
| `attempts` | HTTP attempts made so far (0 before the first attempt). |
| `response_status` | Nullable; the status code of the **last** attempt. |
| `last_error` | Nullable, bounded and sanitized summary of the last failure (never a response body, never a secret). |
| `next_attempt_at` | Nullable; when the next retry is scheduled (D5). |
| `request_id` | Nullable; the request that caused the event (phase 1 §7.7, F4). |
| `is_replay` | Marks a replay-created delivery (D12). |
| `created_at`, `updated_at` | UTC. |

`webhook_endpoints`:

| Column | Notes |
| --- | --- |
| `id`, `project_id` (FK `CASCADE`), `environment`, `url`, `enabled` | Contract fields. |
| `event_types` | Subscription; array of app-validated catalog types. |
| `secret_ciphertext` (+ IV/auth-tag columns as required by D8) | Signing secret at rest (D8). |
| `created_at`, `updated_at` | UTC. |

- Indexes serve the environment-scoped cursor scans: `(project_id, environment, id)` for endpoints
  and events, `(endpoint_id, id)` for deliveries, plus the event-type match query
  `(project_id, environment)`.
- Retention and cleanup: events and deliveries older than the configured retention window are
  removed by a periodic cleanup job (D9). After expiry, a replay request is a 404 and the event
  no longer appears in listings. Retention must be documented in the developer guide (Phase 15).
- Migration is committed (ADR-0011); the schema is added by this phase, not retrofitted into
  Phase 2.

### 5.2 Signature scheme (D7)

Every outbound request carries, in addition to `Content-Type: application/json` and a BrinnPay
`User-Agent`:

- `BrinnPay-Signature: t=<unix-seconds>,v1=<lowercase-hex HMAC-SHA256>` where the signed material
  is the exact string `` `${t}.${rawBody}` `` and the key is the endpoint's signing secret.
- `BrinnPay-Event-Id` and `BrinnPay-Event-Type` (convenience; also present in the body).
- `BrinnPay-Delivery-Id` and `BrinnPay-Attempt` (1-based) so a destination can deduplicate and
  identify retries.

Rules: the HMAC covers the **exact bytes sent** (the envelope is serialized once and reused for
every attempt and for a replay, so a signature never mismatches its own body); the timestamp is
regenerated per attempt; the hex digest is compared in constant time by the consumer; a
recommended consumer tolerance window (a few minutes) is documented in Phase 15. BrinnPay itself
never emits an unsigned delivery, and never signs a body that differs from the transmitted one.

The signing secret is generated with a CSPRNG at endpoint creation with at least 256 bits of
entropy, shown once, and stored per D8.

### 5.3 Queue and worker (ADR-0013, D2, D14)

- **Persistence is transactional (recommended, D2):** the event row is written **inside** the
  business transaction that produced it, through the cross-module port (the idempotency
  capability's transaction handle). This removes the current "post-commit, best-effort, possibly
  lost" gap (F3) and guarantees no phantom event for a rolled-back mutation. Where an emitter has
  no ambient transaction (the payment terminal edges applied by the CAS in `advance()`), the port
  opens its own transaction; correctness holds because only the CAS winner emits.
- **Enqueue is best-effort:** after commit, delivery jobs are added to the BullMQ queue. A queue or
  Redis failure must never fail the already-committed domain request (§4.3.7); the error is logged
  and the reconciliation job picks the work up.
- **Reconciliation:** a periodic job scans for events that have no delivery for a matching enabled
  endpoint and creates them. This is the safety net for both "enqueue failed" and "endpoint was
  created/enabled after the event".
- **Worker:** a BullMQ consumer performs the HTTP attempt, signs the request, and updates the
  delivery row. It re-reads the endpoint before each attempt so a deleted endpoint or a missing
  job is a safe no-op.
- **Advancement sweep (F2, D3):** a periodic job asks the payments module to advance due
  non-terminal payments so `payment.succeeded`/`payment.failed` are emitted without any read.
  Read-time catch-up remains as a backstop, and all advancement stays CAS-guarded, so the sweep
  cannot double-advance or regress a payment. This adds a **driver**, not new lifecycle rules.

### 5.4 Retry classification (D6)

- **Success:** any `2xx` ⇒ the delivery becomes `delivered`; no further attempts.
- **Retryable:** network/DNS/TLS errors, timeouts, `408`, `425`, `429`, and `5xx`.
- **Not retryable:** other `4xx` (including `401`/`403`/`404`/`410`) and any `3xx` — the delivery
  is marked `failed` immediately with the observed status.
- **Redirects are never followed.** A `3xx` is recorded as a failed attempt; this closes the
  redirect-based SSRF and signature-confusion path and keeps the delivered URL equal to the
  registered URL.
- On `429`/`503`, a `Retry-After` header is honored when present and parseable, clamped to the
  configured maximum backoff (D5).
- Response **bodies are never stored** and never logged in full; at most a bounded, sanitized
  error summary is retained (§5.1).
- Timeouts are explicit and bounded (connect and total); a hung destination must not hold a
  worker slot indefinitely.

### 5.5 Retry policy (D5)

Recommended default: **5 attempts total** with exponential backoff and full jitter, e.g. attempts
at approximately 0 s, 30 s, 2 min, 10 min, 1 h, capped by a maximum backoff, with the whole
sequence bounded well under the event retention window (D9) so a failing endpoint cannot be retried
against events that have already expired. All values are environment-driven, following the
existing configuration pattern (`configuration.ts`), so tests can run with near-zero delays and
the sandbox can shorten the schedule. The policy must be documented in the Phase 15 webhooks guide
and reflected in the refined OpenAPI descriptions.

`pending` means "not yet finally succeeded" — it covers a first attempt in flight and any
scheduled retry — so the contract's three-value status enum remains sufficient; `attempts` and
`next_attempt_at` convey progress. `failed` is terminal for that delivery; the only way to try
again is a manual replay (D12).

### 5.6 Replay (D12)

- Replay targets **one** (event, endpoint) pair and creates a **new** delivery row referencing the
  **same** event, so the destination sees the same envelope `id`, `created_at`, and payload as the
  original delivery. The earlier delivery's outcome is never modified; the new delivery's
  `attempts` starts at 0 and `is_replay` is set.
- Preconditions: the endpoint exists in the addressed project/environment; the event exists,
  belongs to the same project **and** environment, and is still within retention; the endpoint is
  `enabled` and still subscribes to the event type. Violations of the last two are 422
  `BUSINESS_RULE_VIOLATION` with a generic message; a foreign or unknown event is 404.
- The response is 202 with no body. Replay is **not** idempotency-key protected: repeated calls
  intentionally create repeated deliveries.
- A replay must never create a new `webhook_events` row, and must not be blocked by the endpoint
  having been disabled after the original delivery (the precondition is evaluated at replay time).

### 5.7 Outbound destination safety (D13)

- Only `http`/`https`, bounded length, no embedded credentials, no fragments (§4.6).
- No redirect following, bounded timeouts, bounded response reads.
- The default posture **allows private, loopback, and link-local destinations**, because a payment
  *sandbox* whose developers cannot receive webhooks on `localhost`/tunnel URLs fails its primary
  purpose. This is an accepted, explicit decision with a compensating control set (no redirects,
  timeouts, no credential forwarding, sanitized logs, tenant isolation) and must be recorded as an
  architectural decision. An optional denylist/allowlist is available as configuration for
  environments that need it, defaulting to permissive.
- Destination hosts and delivery outcomes are logged structurally; secrets, authorization headers,
  and response bodies are never logged.

## 6. Data and event requirements summary

- Three new tables via one committed migration; the `webhook_events` payload is the canonical
  envelope; the endpoint secret is stored per D8 and never returned by any read.
- Project deletion cascades endpoints → deliveries → events (tenant-scoped data, Phase 5 D7
  pattern). Events and deliveries are never mutated except delivery attempt bookkeeping.
- The payments and refunds modules keep their catalogs and emission points; the only change to
  them is that emission now persists durably through the port instead of dropping the event
  (§5.3). No payment/refund behavior, payload, or timing semantics change.

## 7. Web application

Replace the placeholder at `/dashboard/projects/[projectId]/webhooks` with an API-backed
management and observability area using the existing project shell and environment selector
(`test` default):

- **Endpoints:** list, create, edit (URL, subscription, enabled toggle), delete; per-project
  pagination; the create response displays the signing secret **exactly once** with an explicit
  "shown once — copy it now" notice, and the UI must not persist it beyond that interaction
  (no web storage). It is unrecoverable afterwards (D8).
- **Events:** paginated list of the environment's events with type, timestamp, environment, and
  the stored envelope payload viewable on demand; optional type filter (D15).
- **Deliveries:** per-endpoint delivery list showing status, attempts, last response status, and
  last error, with the optional status filter (D15); a replay action for owners/admins with the
  API's 202/422/404 outcomes surfaced.
- Member and viewer roles see the read-only views; create/update/delete/replay controls are
  rendered only for owner/admin. The **API** remains the authority — the UI must not become a
  second policy engine, must not mix environments, and must not reveal another project's data
  through a direct URL or a stale selection.
- Handle empty, loading, and error states, and refresh event/delivery data after a create or a
  replay. Public documentation for webhooks is Phase 15.

## 8. Security requirements

- **Tenant isolation on every path**: endpoint/event/delivery lookups are scoped by project
  (and by the key's environment in API-key mode) with 404 non-disclosure; ID opacity is never
  treated as a control. Replay cannot cross project or environment boundaries.
- **Authorization before disclosure**: the capability matrix is evaluated before any endpoint,
  event, or delivery data is read or returned, and before replay is enqueued.
- **Secret handling**: CSPRNG generation, display-once, never returned again, never logged, never
  in error messages, never in structured log fields, never in the dashboard after dismissal.
  Storage per D8; a missing/short encryption key fails fast at boot (matching the Phase 3
  `JWT_SECRET` behavior).
- **Input validation** at the boundary for URL, subscription, pagination, and ids; no dynamic
  string interpolation into queries (Prisma parameterization only).
- **Cryptographic correctness**: HMAC-SHA256 over `` `${t}.${rawBody}` `` using Node's `crypto`,
  constant-time comparison wherever a signature is compared, no custom primitives, no reuse of the
  API-key hashing path for a secret that must be recoverable.
- **Input handling of destinations**: no redirect following, bounded timeouts and response sizes,
  sanitized and truncated error capture.
- **Secure logging**: request IDs, delivery ids, event ids, endpoints ids, and outcomes are
  logged; secrets, authorization headers, full payloads of failures, and destination response
  bodies are not.
- **Rate limiting** for the webhook API routes is Phase 13; this phase must not add ad hoc limits.
- An explicit **security review** of IDOR, SSRF, secret exposure, signature correctness, and
  cross-environment leakage is required before sign-off (AGENTS.md).

## 9. Acceptance criteria

1. Every Phase 10 roadmap item (event system, registration, HMAC signing, queue, retry policy,
   replay, management UI, event/delivery visibility) has an implemented and tested path, and
   `docs/openapi.yaml` reflects the confirmed behavior and lints clean.
2. A payment creation and a refund creation each produce exactly one persisted `webhook_events`
   row for a subscribed endpoint of the same project and environment, and no event for a rolled
   back mutation or an idempotency replay.
3. A `payment.succeeded` webhook is delivered **without any read of the payment** (sweep-driven),
   and a payment advanced concurrently by the sweep and by a read produces exactly one
   `payment.succeeded` event and one delivery per endpoint.
4. Each outbound request carries a verifiable HMAC-SHA256 signature over the exact transmitted
   bytes; a third-party receiver can validate the signature, the event id, and the delivery id;
   repeated attempts are byte-identical apart from the signature timestamp and attempt header.
5. A failing destination (500, then 429, then 404) follows the confirmed classification: retried
   per the exponential backoff with bounded attempts, `Retry-After` honored where applicable,
   `404` not retried, terminal `failed` recorded with the last response status and no response
   body stored; a `3xx` is never followed.
6. Delivery is at-least-once with no ordering guarantee, and that is documented; a destination
   that times out after processing receives the event again, and deduplication by envelope `id`
   is the documented consumer contract.
7. Replay re-delivers a retained event to an enabled, subscribed endpoint as a **new** delivery
   with the original envelope; a foreign/expired event is 404 and a disabled or unsubscribed
   endpoint is 422; the original delivery record is unchanged.
8. A Redis/queue outage during event production never fails the business request; the event
   remains persisted and the reconciliation job creates the missing deliveries afterwards.
9. Deleting an endpoint stops further deliveries and removes its delivery records, while the
   project-scoped events remain listable and replayable; deleting the project cascades endpoints,
   deliveries, and events.
10. API-key requests cannot read or mutate endpoints, events, or deliveries outside their
    project/environment, and cannot replay another environment's event; session requests cannot
    touch another organization's data (404); member/viewer are read-only (403 on mutations);
    401/403/404 remain distinguishable exactly as the conventions require.
11. The signing secret is returned only in the 201 create response; no log line, error body, list,
    retrieve, or patch response ever contains it, and the dashboard surfaces it exactly once.
12. Events and deliveries older than the configured retention are removed by the cleanup job, and
    replaying an expired event returns 404.
13. The optional `type` and `status` filters (D15) narrow results within the caller's
    project/environment, an absent filter returns the unfiltered set, an unknown filter value is a
    400 field error, and cursor pagination remains stable and non-overlapping while a filter is
    applied. Filtering by a type or status that exists in another environment returns nothing.
14. An endpoint subscribed to an event type outside the catalog is rejected with a 400 field error
    at create and at patch (D1), and duplicate URLs are accepted for the same
    project/environment with no uniqueness conflict (D16).

## 10. Testing requirements

- **Unit**: signature computation and material construction; URL validation and normalization;
  catalog validation and subscription matching; environment resolution for both auth modes;
  retry classification (2xx/3xx/4xx/408/429/5xx/network/timeout) and `Retry-After` clamping;
  backoff schedule bounds and jitter; capability matrix; delivery status/attempt bookkeeping;
  retention cutoff; replay preconditions; secret generation/redaction.
- **Integration (real PostgreSQL + real Redis + real worker)**: migration and indexes; the
  three tables' FKs and cascades; payment create → `payment.created` delivered and verified by a
  local HTTP receiver asserting the signature, body bytes, and headers; a receiver that fails
  first and succeeds later to observe the full retry ladder; non-retryable 404; a destination
  that times out; `endpoint.enabled` gating new events only; event persistence when Redis is
  stopped and reconciliation afterwards; sweep-driven `payment.succeeded` with no reads; sweep and
  read advancing the same payment concurrently (exactly one event); replay producing a second
  delivery with the same envelope; endpoint deletion during queued deliveries; retention cleanup;
  project deletion cascade.
- **E2E (API)**: all eight operations under both auth modes; pagination boundaries; every error
  status in the table above; secret shown once and never again; cross-project/cross-environment
  IDs returning 404; viewer/member receiving 403 on mutations; idempotent replay of a
  `payments.create` producing no second event.
- **Web**: environment selector scoping; endpoint create showing the secret once and not after
  reload; edit/disable/delete; events and deliveries pagination; replay action and its error
  states; read-only roles; direct-URL isolation; empty/loading/error states.
- Tests must not require real payment credentials, must not log secrets, and must run
  deterministically (env-driven near-zero delays/retries). Repository-required checks (lint,
  typecheck, unit, relevant integration/e2e, build) and OpenAPI validation in CI must pass.

## 11. Out of scope

- New event types, payload changes, event ordering guarantees, exactly-once delivery, batching, or
  streaming — the catalog stays as defined by Phases 7 and 9.
- Webhook signature verification helpers, SDKs, sample receivers, or CLI tooling (Phase 15 /
  roadmap Future); in-dashboard signature verification.
- Sandbox failure/timeout simulation for webhook delivery (Phase 16), including forcing a
  destination to fail on demand.
- Secret rotation or regeneration endpoints, secret recovery, per-endpoint secret versioning
  (contract expansion; D8 records the MVP position).
- Per-attempt delivery history rows, dead-letter queues, per-event delivery fan-out views,
  aggregate delivery analytics, bulk replay, and automatic replay of failed deliveries.
- Per-project endpoint quotas, and `Idempotency-Key` on webhook mutations (D16).
- **Abuse-prevention follow-ups, deferred to Phase 13 (rate limiting).** The phase 10 security review
  confirmed §8 but recorded findings whose remediation the specification itself assigns to Phase 13,
  so they are carried here rather than implemented ad hoc in this phase. Each requires authenticated,
  project-scoped write authority (project admin or project API key) to reach; there is no
  unauthenticated amplification path, which is why deferring is defensible for a sandbox that moves
  no money:
  - **Replay is an unbounded request amplifier.** Replay is deliberately repeatable (D12) and replay
    rows are excluded from the uniqueness index, so nothing caps how many deliveries one event can
    produce. A project admin or a project API key can loop the replay route and amplify outbound
    traffic. Phase 13 should cap replays per `(endpoint, event)` per window and bound pending
    deliveries per endpoint.
  - **Uncapped endpoints multiply the in-transaction fan-out.** D16 allows unlimited endpoints per
    project/environment, and each new endpoint adds a row to the `createMany` that runs inside the
    payment's own transaction. A project that registers many endpoints can make payment creation slow
    enough to fail. Phase 13 should pair its quotas with an endpoint cap.
  - **Two batch scans are global and unscoped, so tenants can starve each other.** The
    advancement sweep takes a bounded batch ordered by `id` (UUIDv7, so approximately creation order)
    across all projects; a static backlog drains as rows advance, so volume alone produces delay, but
    sustained arrival above the drain rate — or repeated `applyEdge` rollbacks, which leave rows
    permanently due at the head of the `id` order — can hold a batch indefinitely. `requeueDueDeliveries`
    has the same shape, ordered by `createdAt` across all projects with no project filter. Both delay
    rather than lose work: read-time catch-up is a partial backstop for the sweep, and the 15 s requeue
    grace means healthy rows are not duplicated. Unlike F1/F2 this is an **availability and fairness
    defect, not abuse prevention**, so Phase 13's rate-limiting mandate does not obviously cover it and
    it needs per-project fairness (round-robin, or bounding open work per project) in a later phase.
- Request logs, audit logs, metrics/monitoring, and dashboards for delivery health
  (Phases 11, 12, 20); API-key/IP rate limiting (Phase 13); public webhook documentation
  (Phase 15); broader dashboard polish (Phase 14).
- Any change to payment/refund domain rules, the payment state machine, the refund balance
  invariants, or the idempotency capability's public behavior.

## 12. Decisions (D1–D16 — all confirmed 2026-09-28)

Every decision below was put to the product authority and **confirmed as recommended**. They are
now binding requirements of this phase, not proposals. The alternative column is retained to record
what was rejected and why, so the reasoning survives future change requests.

| # | Decision | Confirmed position | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Unknown event types on create/patch | Reject: `event_types` must be a non-empty subset of the closed catalog → 400. | Accept any `<resource>.<verb>` string — future-proof but creates endpoints that can never fire and hides typos. |
| D2 | Event durability | Persist the event **inside** the business transaction (transactional outbox via the cross-module port); treat enqueue as best-effort plus reconciliation. | Keep post-commit best-effort emit (loses events on crash — unacceptable for the phase goal); persist post-commit in a new transaction (still lossy); poll-only delivery with no queue (violates the roadmap's BullMQ item). |
| D3 | Terminal payment events without reads | Add a periodic advancement sweep (via the queue) that asks the payments module to apply due edges; read-time catch-up remains the backstop. | Leave advancement read-driven (webhooks for `payment.succeeded` would effectively never fire — rejects the phase goal); change the payment lifecycle to event-driven transitions (out of scope, larger change to Phase 7 semantics). |
| D4 | Delivery record granularity | One `webhook_deliveries` row per (event, endpoint) with an `attempts` counter and the last attempt's outcome — the contract's model (F1, F4); no per-attempt history rows. | One row per attempt as phase 1 §6.2's phrasing suggests (breaks the contract's `attempts` field and makes the delivery list unreadable); a child attempts table (more data, not exposed, deferred). |
| D5 | Retry policy | 5 attempts, exponential backoff with full jitter (≈ 0 s, 30 s, 2 min, 10 min, 1 h), maximum backoff cap, env-driven; bounded well inside the retention window. | Unlimited retries (a dead endpoint retries forever); 3 attempts (too brittle for a sandbox); fixed delays (thundering herd against a recovering destination). |
| D6 | Response classification | Success on 2xx; retry on network errors, timeouts, 408/425/429/5xx; **never** retry other 4xx; never follow redirects; honor `Retry-After` when parseable and clamp it. | Retry every non-2xx (amplifies permanent misconfiguration such as a wrong URL returning 404); follow redirects (SSRF and signature-confusion risk). |
| D7 | Signature scheme | `BrinnPay-Signature: t=<unix>,v1=<hex>` over `` `${t}.${rawBody}` ``, plus `BrinnPay-Event-Id`, `BrinnPay-Event-Type`, `BrinnPay-Delivery-Id`, `BrinnPay-Attempt` headers; hex encoding, constant-time comparison by consumers, per-attempt timestamp. | Vendor-prefixed name mimicking another provider (confusing); base64 digest (equivalent, less common); omitting the timestamp (removes replay protection for consumers). |
| D8 | Secret storage and recovery | Encrypt the secret at rest (AES-256-GCM) with a key injected via environment and validated at boot; returned once; **no** rotation endpoint in v1 (recovery = delete and recreate the endpoint). | Store the secret reversibly/plain (simpler, but a database compromise yields every endpoint's signing secret — inconsistent with the API-key posture); hash the secret (impossible — signing needs the plaintext); add a rotate/regenerate operation (additive contract change, justified only on explicit request). |
| D9 | Event and delivery retention | Configurable retention (default 30 days) for events; deliveries live with their endpoint; periodic cleanup job; expired events are 404 on replay and absent from listings; retention is documented in the Phase 15 guide. | Retain forever (unbounded growth); retain briefly (replay window too small to be useful). |
| D10 | Authorization matrix and API-key authority | `webhooks.read` for all four roles; create/update/delete/replay for owner+admin; an API key may perform all webhook operations within its own project and environment (§4.5). | Restrict delete/replay to sessions only (endpoints become unmanageable from integrations); give `member` write access (inconsistent with every other project resource). |
| D11 | `enabled` and delete semantics | `enabled=false` stops enqueueing of new deliveries only (queued deliveries still run); deleting an endpoint cancels all future work and cascades its delivery records; events survive. | `enabled=false` also cancels queued deliveries (a delivery disappears without a record of why); retain delivery history after endpoint deletion (dangling history with no addressable endpoint, or a contract change to list deliveries by event). |
| D12 | Replay preconditions | Replay requires a retained, same-project, same-environment event and an endpoint that is still enabled and subscribed; otherwise 422; new delivery row, original envelope, no event duplication, 202 with no body. | Replay regardless of subscription (useful for debugging but produces deliveries the endpoint's own configuration disclaims); mutate the original delivery (destroys history). |
| D13 | Outbound destination policy (SSRF) | Allow private/loopback/link-local destinations by default — a sandbox must be able to deliver to local and tunnel URLs — with the compensating controls of §5.7 and an optional configurable allow/deny list; no redirects, bounded timeouts, sanitized logs. | Block private ranges by default (breaks the sandbox's primary use case, §5.7); block everything except an allowlist (operationally heavy before staging exists). |
| D14 | Worker topology | A separate worker process/entrypoint over the same Prisma and Redis dependencies, with its own local-Docker Compose service; the API process only enqueues. | Run the worker in the API process (smallest change, but couples delivery latency and failure modes to request traffic and blocks a second API replica from duplicating consumers). |
| D15 | Optional list filters | Add optional `type` on `webhooks.listEvents` and optional `status` on `webhooks.listDeliveries` (additive, backward-compatible) so the dashboard is usable at volume (§4.4). | Keep the contract exactly as written and filter in the UI (poor at scale, and pagination breaks); defer entirely (the dashboard then degrades to a raw id-ordered list). |
| D16 | Endpoint duplicates and quotas | Duplicate URLs are allowed (no uniqueness constraint) and no per-project endpoint quota is enforced in v1; abuse control is Phase 13's rate limiting. | Unique (project, environment, url) (rejects a legitimate pattern of splitting subscriptions across endpoints); a hard cap (arbitrary limit without product input). |

## 13. Architectural decisions to record

The following decisions warrant ADRs, to be authored and approved during implementation, continuing
the existing `.ai/decisions/` series:

- **Event durability**: transactional event persistence (outbox) + best-effort enqueue +
  reconciliation (D2, D3).
- **Webhook delivery model and retry classification**: aggregate delivery row, retryable classes,
  no redirect following (D4, D6, D7).
- **Webhook secret handling**: CSPRNG, encrypt-at-rest, display-once, no rotation in v1 (D8).
- **Delivery aggregate vs phase 1's one-attempt wording** (F1) — recorded as a clarification of
  the Phase 1 entity catalog.

## 14. Implementation considerations (not new requirements)

- Reuse the existing dual-mode guard pattern — it is now duplicated three times, so extracting the
  shared project-scoped dual-mode guard and scope decorator is preferable to a fourth clone.
  Phase 9 made the same observation.
- Replace the two no-op sinks with a single implementation of the webhooks inbound port; keep the
  catalog constants in the owning modules and derive the validation catalog from them rather than
  duplicating a list.
- The payments/refunds change is limited to routing emission through the durable port; the
  idempotency `afterCommit` hook stays for non-transactional side effects only, and the payment
  CAS-winner rule keeps terminal events exactly-once.
- Keep the delivery worker idempotent: re-read the endpoint and delivery before acting, and treat a
  missing row (deleted endpoint) as a successful no-op so job removal races are harmless.
- Reuse the existing cursor helper, UUIDv7 utility, configuration loading, error envelope, and
  request-ID resolution; extend `configuration.ts` with a `webhooks` section (timeouts, backoff,
  attempts, retention, sweep intervals, optional encryption key) following the existing
  env-driven pattern and the `JWT_SECRET` fail-fast precedent.
- BullMQ adds the first Redis dependency beyond connectivity; keep the readiness contract
  (Phase 2 D9) intact and do not make API readiness depend on queue drain health (Phase 20 owns
  worker observability).
- The dashboard must consume only the documented API; the API contract in `docs/openapi.yaml` is
  the single source of truth (ADR-0012), so no ad hoc web-only endpoint may be introduced.
- Do not modify application source as part of specification work.
