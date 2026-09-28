# Phase 9 — Refunds

| | |
| --- | --- |
| Phase | 9 — Refunds |
| Status | **Specified — D1–D5 confirmed; implementation pending** |
| Depends on | Phases 7 (payments), 8 (idempotency), 4–6 (tenant, projects/keys, customers) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 9 |

## 1. Objective

Support full and partial refunds of simulated payments, with safe amount accounting, validation, a versioned REST API and an environment-scoped refunds view in the existing dashboard. Neither environment processes real money. This phase owns the refund domain rules and refund event catalog; Phase 10 owns event persistence and webhook delivery.

## 2. Scope and dependencies

- Implement the existing `refunds.list`, `refunds.create`, `refunds.retrieve` operations at `/api/v1/payments/{payment_id}/refunds[/{refund_id}]` as defined in `docs/openapi.yaml`; do not add an alternate project-nested endpoint.
- Support omitted `amount` for the full remaining balance and explicit `amount` for a partial refund; validate against the payment and all existing refunds.
- Add a refund record tied to one payment, inheriting its project, environment and currency. Expose the contracted `Refund` and `RefundList` projections.
- Activate the existing cross-cutting idempotency capability for `refunds.create` (Phase 8 / ADR-0004), including safe concurrency with other refund attempts against the same payment.
- Replace the dashboard refunds placeholder with an API-backed, project/environment-aware list/create/detail experience; connect refunds to their parent payment in the user flow.
- Define refund events and their emission points for the Phase 10 handoff without building webhook persistence, queues or delivery in Phase 9.
- Refine the canonical OpenAPI contract **in place** and keep the existing `/api/v1` response conventions.

The current repository has `Payment` and `IdempotencyRecord` models but no `Refund` model or refunds API. The web refunds route is a placeholder (its text incorrectly says Phase 8). Payments use project-scoped dual-mode auth, USD minor-unit `bigint` money, read-time simulation, and an in-memory/no-op event sink. The payment create path currently looks up a customer with an environment predicate only for API keys; this is an existing gap against the Phase 7 same-project-and-environment invariant, not permission to weaken refund isolation. Phase 8 idempotency stores a successful response per `(project, operation_scope, key)` for 24 hours and replays it independently of auth mode.

## 3. Domain rules

1. Each refund targets exactly one payment; project, environment and currency are inherited from that payment, not chosen by a caller. A refund must never mix TEST and LIVE or reference another project's payment.
2. Only a **succeeded** payment is eligible for a new refund. Pending, processing and failed payments must not be refunded; a payment that becomes succeeded through the existing read-time advancement can then be evaluated. Eligibility must be checked against authoritative payment state at creation time.
3. Payment amounts and refund amounts use positive **integer minor units** (USD, scale 2) internally and decimal strings externally. Let `remaining = payment.amount_minor − sum(succeeded refund.amount_minor)` for this payment. A new refund amount must be strictly positive and at most `remaining`. An omitted amount means **the full remaining balance**, not the original payment amount (D1). `remaining = 0` rejects another refund. Never use floating-point arithmetic.
4. An explicit partial amount less than `remaining` leaves the remainder available for later refunds. An explicit amount equal to `remaining` exhausts the refundable balance. These checks apply to every request, not only requests with an idempotency key.
5. Refunds are not deletable or editable through the v1 contract. No new payment status is assumed: the existing payment status remains `succeeded` after refunding; refund history is represented by refund records (D3).
6. Refund creation completes synchronously with status `succeeded` and HTTP 201 (D2). Phase 9 does not create `pending`, `processing` or `failed` refunds and does not simulate status transitions or failure triggers. The broader existing `Refund.status` enum remains in the contract for compatibility; these other values are not produced by Phase 9. Each committed refund immediately reduces the remaining balance.
7. An optional developer-provided `reason` is trimmed on input, must be nonempty after trimming when supplied, and must contain at most 255 characters after trimming (D4). Non-string/null, blank or overlong supplied values are invalid (400); omission persists no reason and returns `reason: null`. Do not place secrets or sensitive data in the reason.

## 4. API behavior and authorization

All three operations accept **either** a session JWT or an `sk_…` API key using the existing dual-mode boundary. Because refund paths carry `payment_id` instead of `project_id`, resolve the parent payment's project and environment and authorize against that scope **before revealing the payment or any of its refunds**. Invalid/revoked credentials return 401. An API key may access only payments in its own project **and** environment; another scope or missing payment returns 404. A session user must belong to the payment's owning organization (non-member or inaccessible payment → 404); a member lacking the required capability → 403. Apply the same rule to both path IDs on retrieve. Invalid resource IDs are not-found, consistent with payments; invalid request fields return 400 in the standard error envelope. The API, not the web UI, enforces authorization. Session `refunds.read` belongs to all four organization roles; `refunds.create` belongs to owner/admin only (D5).

| Operation | Behavior | Result |
| --- | --- | --- |
| `GET /payments/{payment_id}/refunds` | Authorize parent; list **only** that payment's refunds, with the established cursor `limit` (default 20, max 100), `cursor`, UUIDv7 ascending ordering and `{ data, next_cursor, has_more }`. No undocumented environment, project, status or search query is added. | 200 `RefundList`; 400 malformed pagination; 401/403/404 as above. |
| `POST /payments/{payment_id}/refunds` | Authorize parent; accept `RefundCreate` with optional `amount`, optional `currency` (if provided, must be `usd`; omission defaults to payment currency), optional `reason`, optional `Idempotency-Key` header. Validate eligible payment and remaining amount atomically; return the new `Refund` projection. | 201 `Refund`; 400 invalid body/header; 409 key reused for another refund target; 422 ineligible/exhausted/excess refund (canonical business-rule envelope); 401/403/404 as above. |
| `GET /payments/{payment_id}/refunds/{refund_id}` | Authorize parent; refund ID must belong to that parent payment; do not disclose a refund from another payment, project or environment. | 200 `Refund`; 401/403/404 as above. |

- Use the same `MoneyAmount` format and USD-only rules as payments; bad format, zero or negative explicit amounts → 400 `VALIDATION_ERROR`. Eligibility and remaining-balance violations → 422 `BUSINESS_RULE_VIOLATION` unless a more specific code is expressly confirmed and documented (e.g. `PAYMENT_ALREADY_REFUNDED` from the conventions' example). Do not invent an additional error code silently.
- `Idempotency-Key` is optional; present values use Phase 8 validation (trimmed, 1–255 chars). First committed success stores/replays the original **201 status and original refund body** for `refunds.create` within 24 hours in the **parent payment's project**. Replays do not recalculate remaining balance, create another refund or emit another event; they carry the current request's `X-Request-Id`. A key reused for a different parent payment returns a generic 409 `CONFLICT` instead of leaking the original refund response (including across TEST/LIVE). Failed/unauthorized requests do not claim a replayable success. The same key for `payments.create` is independent. Even without a key, simultaneous different-key/no-key attempts may never over-refund.
- Preserve canonical request IDs, error shapes, and the existing OpenAPI alternative security requirements. There is no new rate limit in this phase (all-route limits are Phase 13); no secret/header/body leakage in error messages or logs.

## 5. Data and event requirements

- Add a `refunds` persistence model via a committed migration: UUIDv7 `id` (PostgreSQL `uuid`), required parent `payment_id` FK, positive `amount_minor` as `bigint`, `currency` (`usd`), `succeeded` status, optional `reason` (max 255 after trimming), UTC `created_at` and `updated_at`; provide parent-scoped indexed lookup and cursor pagination. The API's `project_id` and `environment` must come from the parent payment: avoid redundant mutable copies unless a concrete requirement warrants them. A refund cannot outlive its parent; deletion behavior must not break existing project/customer deletion policies (`payments.customer_id` is `RESTRICT`).
- The parent payment amount remains immutable. Enforce the balance invariant under concurrent refund attempts in the database transaction; reading the sum then inserting without serialization is insufficient. Design must prevent write skew for different idempotency keys and no-key calls as well as replays. Every Phase 9 refund is immediately succeeded and counts toward the balance.
- Phase 1 assigns the refund **event catalog** to Phase 9: emit `refund.created` once for each committed new succeeded refund through the internal event seam. No separate `refund.succeeded` event or invented status transition occurs on synchronous creation (D2). Payload is the contracted refund snapshot inside `{ id, type, created_at, data, environment, project_id }` (UUIDv7 event id). No event for a replay or rolled-back write. Persistence, delivery, HMAC, retries and replay belong to Phase 10. Note: today's payment event sink is best-effort post-commit and no-op; guarantee durable delivery only when Phase 10 explicitly designs it.

## 6. Web application

- `/dashboard/projects/[projectId]/refunds` uses the existing project shell and environment selector (`test` default). Since the refund API has only payment-nested routes, first load payments for the selected project/environment using the existing API; present refunds in the context of a selected payment, not via an invented cross-payment list endpoint. Allow navigation from a payment detail to its refunds. Do not present or mix other environments' refunds.
- Show parent payment, amount/currency/status, existing refunds and remaining refundable balance as informational UI derived from API data; the **API** decides actual eligibility and available balance at submission. Expose full (omit amount) and partial (supply amount) create controls to owner/admin only, along with the optional reason. Show validation/business-rule errors, empty/loading/not-found states and refund detail; provide cursor pagination for the selected payment. Member/viewer can inspect but not submit. No parallel web backend or web-side authoritative accounting.
- UI must not accidentally expose cross-environment records through a direct refund URL or selection state; preserve the existing authenticated-route protection and non-member not-found behavior.

## 7. Security requirements

- Enforce project/organization and TEST/LIVE isolation on **parent lookup and child lookup**, including guessed `payment_id`/`refund_id`; do not derive security from UUID opacity. A session has no path project ID on these routes, so membership must be established from the resolved parent without leaking whether a foreign parent exists.
- Apply an explicitly confirmed RBAC matrix per operation; an API key grants only its scoped project/environment without bypassing that boundary. Authorization precedes idempotency replay.
- Validate all inputs at the API boundary. Guard amount conversion and total arithmetic from overflow; return decimal-string API projections, never raw `BigInt`. Ensure concurrent writes cannot exceed the payment amount or produce duplicate results for the same idempotency key.
- Never log API keys, session tokens, `Idempotency-Key` values or sensitive reasons; avoid raw request bodies in structured logs. Return generic not-found errors for cross-scope IDs. Perform explicit security review of IDOR, race safety, replay and information disclosure before sign-off.

## 8. Acceptance criteria

1. Each Phase 9 roadmap item (full refund, partial refund, validation, API, UI) has an implemented and tested path; `docs/openapi.yaml` reflects the confirmed behavior and lints clean.
2. A succeeded payment can be refunded for its remaining balance by omitting `amount`; an explicit valid smaller amount can be followed by further refunds up to (not over) the original amount. Zero, negative, excessive and malformed amounts fail with the documented statuses; an exhausted or non-succeeded payment cannot yield a new refund.
3. Concurrent refund submissions, including different/no keys, cannot create a total effective refunded amount greater than the payment amount. Same-key retries within 24h return the identical original 201 body with no additional refund/event; after expiry they are evaluated as new operations against the **current** balance.
4. API-key requests cannot read/create refunds outside their project/environment; session requests cannot inspect other organizations' payments; cross-parent `refund_id` returns 404. Owner/admin may create; all organization roles may read; 401/403/404 remain distinguishable only where authorized by convention.
5. Refunds list and detail match the existing OpenAPI shapes, parent scoping, pagination and request-ID conventions; no extra refund routes are introduced.
6. A migrated database stores refund money exactly in minor units, preserves payment/refund referential integrity, and returns no `BigInt` in JSON. Refund event types/payloads/timing are recorded and emit only for committed first executions through an internal seam; webhook delivery is not implemented.
7. Dashboard lists refunds of a selected payment in the selected project/environment, provides authorized full/partial actions and details, handles empty/errors/loading states, and never makes the UI an authorization or balance-accounting authority.

## 9. Testing requirements

- Unit: money formatting/validation; full-remaining vs explicit partial and exhaustion; non-succeeded state; reason/currency validation; refund response mapping; capability matrix; event catalog and no event on rollback/replay; idempotency scope and original snapshot replay.
- Real PostgreSQL integration/e2e: migrated FKs/indexes; payment create → simulate succeeded → partial → full remaining → excess rejected; create/list/retrieve and cursor pages with both auth modes; foreign payment/refund IDs, other environments, non-member/member lacking capability; same-key retries and expiry; **parallel different-key and no-key refunds** that together exceed balance; same-key concurrency. Assert no over-refund, no duplicated event for a replay, and unchanged payment status.
- Web tests: environment selector and selected payment scoping, full/partial submit payloads, read-only roles, direct route isolation, empty/loading/error states and refresh of remaining balance after creation.
- Run repository-required lint, typecheck, unit, relevant integration/e2e and build checks; validate OpenAPI in CI. Tests must not need real payment credentials or disclose idempotency keys in logs.

## 10. Definition of done

All acceptance criteria and required checks pass; the migration is committed and deployable; security review covers cross-scope access and concurrent refund accounting; Phase 10 receives the settled `refund.created` event catalog.

## 11. Out of scope

- Real money, real cards, payment network calls, multi-currency/exchange rates, payout or settlement operations.
- Payment cancellations, payment status changes caused by refunds, refund editing/deletion, refunds across projects, extra list/search/filter endpoints or a new API version.
- Webhook event persistence, delivery, signing, retries and replay (Phase 10); request/audit logs (Phases 11/12); global rate limiting (Phase 13); sandbox decline/timeout scenarios (Phase 16); broader dashboard polish (Phase 14).
- New idempotency infrastructure or alternate client-side idempotency engine (Phase 8 already owns it).

## 12. Confirmed decisions and implementation considerations

| # | Decision | Confirmed behavior |
| --- | --- | --- |
| D1 | Omitted `amount` | Refund the remaining balance, including after prior partial refunds. |
| D2 | Lifecycle and event timing | Create a succeeded refund synchronously (201); count it immediately; emit `refund.created` once on committed creation, with no artificial transition or second event. |
| D3 | Payment status | Leave payment `succeeded`; refund records convey refund history. |
| D4 | Optional `reason` | Trim, reject blank or over 255 characters after trimming, return `null` when absent. |
| D5 | Session roles | All four organization roles may read; owner/admin may create. API keys remain project/environment scoped. |

Implementation considerations (not new requirements): reuse the existing money helper, UUIDv7/cursor utilities, project membership/API-key authentication, idempotency service and migration workflow; consider extracting the shared dual-mode guard now that refunds are a third consumer, rather than cloning its authentication rules. Resolve payment state consistently when creating a refund (the simulation may advance a due payment on reads). Couple balance protection with refund insertion in one atomic unit **inside** the idempotency mutation where a key is supplied; avoid relying on idempotency to prevent different-key races. Review the existing session customer/environment mismatch in the payment create path separately so the Phase 7 invariant is not silently inherited or obscured by this phase. Replace the dashboard placeholder when implementing the spec; do not modify application source as part of specification work.
