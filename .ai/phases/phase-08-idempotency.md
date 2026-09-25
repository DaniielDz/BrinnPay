# Phase 8 — Idempotency

|                   |                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------- |
| Phase             | 8                                                                                       |
| Name              | Idempotency                                                                             |
| Status            | **Draft — implementation-ready except D6 response-storage confirmation (2026-09-25)**     |
| Depends on        | Phase 7 (complete), Phase 5 (complete), Phase 4 (complete), Phase 3 (complete), Phase 2 (complete) |
| Blocks            | Phase 9 (Refunds), Phase 10 (Webhooks), Phase 17 (critical-flow testing)               |
| Roadmap reference | [ROADMAP.md](../../ROADMAP.md) — Phase 8                                               |

---

## 1. Objective

Deliver BrinnPay's **idempotency capability** for critical mutations so retries are safe and
duplicate side effects are prevented.

- The capability is **cross-cutting application infrastructure** (phase 1 §6.3), not a
  payments-owned submodule.
- Phase 8 makes the `Idempotency-Key` contract **real** for the first live consumer,
  `payments.create`, whose Phase 7 behavior explicitly deferred replay/deduplication to this
  phase.
- Idempotency scope is already fixed by phase 1 §7.4 / ADR-0004:
  **(project, operation_scope, idempotency_key)** with a **24-hour retention window**.
- Within that window, the same project + same operation scope + same key must return the
  **original stored response without re-executing the mutation**.
- After the window expires, the same key is treated as a **new operation**.

Phase 8 delivers the database-backed idempotency record model, transaction-safe claim/replay
semantics, concurrency guarantees, and the in-place API-contract/documentation refinements for
the now-live behavior.

## 2. Scope

In scope (mapped to the roadmap Phase 8 checkboxes):

| Roadmap checkbox                               | Specification reference |
| ---------------------------------------------- | ----------------------- |
| Idempotency key support                        | §4.2, §4.3             |
| Database constraints for uniqueness            | §5                      |
| Transaction-safe operations                    | §4.4                    |
| Concurrency tests                              | §7, §8                  |
| Idempotency behavior reflected in API documentation | §4.5, §7            |

Required to keep the phase self-consistent:

- The first runtime consumer is **`payments.create` only**; the capability itself must remain
  reusable for later operation scopes, especially `refunds.create` in Phase 9.
- The phase must resolve **when an idempotency record is created and what is replayed**,
  because the current Phase 7 implementation accepts/validates the header but deliberately does
  not deduplicate.
- The phase must define the **concurrency contract** for two or more simultaneous requests with
  the same key, because the roadmap explicitly requires transaction safety and concurrency tests.

## 3. Context

Constraints reused from the master specification, Phase 1, prior phase specifications, and the
current codebase:

- BrinnPay is a modular monolith: NestJS API + Next.js web app; PostgreSQL + Prisma; Redis is
  available but Phase 8 is not required to depend on it.
- Phase 1 §7.4 and ADR-0004 already fix the normative idempotency behavior:
  - critical mutations accept `Idempotency-Key`;
  - scope = `(project, operation_scope, key)`;
  - replay within 24 hours returns the original stored response;
  - same key in another operation scope is independent;
  - reuse after 24 hours is a new operation.
- Phase 1 §6.1 includes `IdempotencyRecord` as an internal entity under `Project`, and phase 1
  §6.3 classifies idempotency as a **cross-cutting capability**.
- The canonical contract already exposes the `Idempotency-Key` header on
  `payments.create` and `refunds.create` (`docs/openapi.yaml`, component
  `parameters/IdempotencyKey`).
- Phase 7 is implemented in source code:
  - `payments.create` currently **accepts and validates** `Idempotency-Key` but **does not**
    replay or deduplicate (`apps/api/src/payments/payments.service.ts`);
  - repeated requests with the same key can currently create duplicate payments;
  - payment creation is a fast, synchronous, single-DB-write mutation plus event emission,
    making DB-transaction-backed idempotency the smallest correct fit.
- The current Prisma schema has `projects`, `customers`, `payments`, and `api_keys`, but **no
  idempotency table**.
- Refunds are not implemented yet (Phase 9), so Phase 8 cannot make `refunds.create` a live
  runtime consumer, but it must not design the infrastructure in a payments-specific way.
- API request IDs are mandatory per phase 1 §7.7, so replayed responses must remain compatible
  with per-request tracing.

## 4. API Application — `apps/api` (cross-cutting idempotency)

### 4.1 Module purpose

Provide reusable application infrastructure that critical mutations can invoke to:

1. resolve the authenticated **project scope**;
2. validate and normalize an optional `Idempotency-Key` header;
3. claim uniqueness for `(project, operation_scope, key)` within the active retention window;
4. execute the mutation exactly once when the claim is new;
5. store the resulting API response for replay;
6. return the stored response for subsequent retries without re-executing business logic.

This capability belongs to the API application only. The web application remains a client and
introduces no parallel idempotency behavior.

### 4.2 Domain rules

1. **Operation scope**
   - The operation-scope catalog is string-based and shared infrastructure.
   - Phase 8 activates **`payments.create`**.
   - `refunds.create` remains a documented reserved scope for Phase 9; Phase 8 must not require
     a schema redesign to add it.

2. **Header semantics**
   - `Idempotency-Key` remains **optional** at the contract level (`required: false`).
   - If the header is **absent**, the mutation executes normally and no idempotency record is
     created.
   - If the header is **present**, the system must apply the Phase 8 semantics for that
     operation.
   - Header validation from Phase 7 remains in force: empty-after-trim or overlong values are
     **400 `VALIDATION_ERROR`**.

3. **Scope of uniqueness**
   - A key is unique within **one project + one operation scope + one active retention window**.
   - The same key in another project is independent.
   - The same key in another operation scope of the same project is independent.
   - The same key used through another authentication mode but for the **same project** is **not**
     independent; project scope, not auth mode, is the boundary fixed by ADR-0004.

4. **Replay semantics**
   - A retried request inside the retention window must return the **original stored HTTP status
     and response body** of the first successful execution.
   - For `payments.create`, the replayed response is the original **201** `Payment` body,
     including the original `payment.id`, timestamps, and original lifecycle snapshot (typically
     `status: pending` if the first response was returned before later state advancement).
   - Replay must **not** execute payment creation again, create another payment row, or emit
     another `payment.created` event.
   - Clients may retrieve the payment later to observe its current lifecycle state; replay does
     not substitute for `payments.retrieve`.

5. **Retention window**
   - Active retention is **24 hours** from the stored record's creation, per ADR-0004.
   - After expiry, reuse of the same key is treated as a **new operation**.
   - The system must ensure expired records do not block reuse of the same key.

6. **Execution boundary**
   - Idempotency applies to the **mutation execution**, not to unauthenticated or malformed
     traffic.
   - Authentication, authorization, path validation, and request-shape validation must still run
     first.
   - Requests rejected before the side-effecting mutation begins do **not** create an
     idempotency record.
   - A failed mutation that rolls back without creating the business side effect does **not**
     leave behind a replayable successful record.

### 4.3 API behavior

#### 4.3.1 `POST /projects/{project_id}/payments` — `payments.create`

Phase 7 introduced the header as accepted-but-nonfunctional. Phase 8 replaces that temporary
behavior with the live semantics below.

When `Idempotency-Key` is present and valid:

1. The request is authenticated and authorized exactly as defined by Phase 7.
2. The request is evaluated in the addressed **project** and operation scope **`payments.create`**.
3. If no active idempotency record exists for `(project_id, payments.create, key)`, the system:
   - claims the key atomically;
   - creates the payment exactly once;
   - stores the **201 `Payment`** response for replay;
   - returns that response.
4. If an active idempotency record already exists for that tuple, the system:
   - does **not** create another payment;
   - does **not** emit another `payment.created` event;
   - returns the previously stored response.
5. If the same key is reused **after expiry**, the request is treated as a new payment creation.

When `Idempotency-Key` is absent, `payments.create` behaves as a normal non-idempotent create.

#### 4.3.2 Response-shape and request-ID rules

- Replayed responses must preserve the original **HTTP status code and JSON body**.
- Request-scoped tracing data is **not replayed verbatim**:
  - the current request receives its own `X-Request-Id` header;
  - if an error envelope is produced for the current request outside the replay path, its
    `request_id` remains the current one.
- No API contract change is required for replayed payment-create success responses because the
  shape remains the contracted `Payment` schema.

#### 4.3.3 Future consumer: `refunds.create`

- The `Idempotency-Key` contract on `refunds.create` remains documented in `docs/openapi.yaml`.
- Phase 8 does **not** implement runtime refund behavior because refunds do not exist yet.
- Phase 9 must consume the same cross-cutting capability with operation scope
  **`refunds.create`**, not introduce a parallel design.

### 4.4 Transaction and concurrency semantics

The system must prevent duplicate side effects under concurrent retries of the same key.

Required behavior:

1. Two or more concurrent `payments.create` requests with the same `(project, operation_scope,
   key)` must result in **exactly one payment row**.
2. Exactly one request path may win the right to execute the mutation for a fresh key.
3. Loser paths must obtain the stored response of the winning execution once it commits, rather
   than creating a second payment.
4. If the winning execution rolls back and produces no committed side effect, a later retry with
   the same key must still be able to execute as a fresh operation.
5. The implementation must rely on **database-backed atomicity and uniqueness**, not on
   best-effort in-memory coordination.

This phase intentionally prefers a database-transaction-backed design over Redis locks because the
roadmap explicitly calls for database constraints and transaction-safe behavior, and the current
consumer (`payments.create`) is a short synchronous mutation.

### 4.5 API documentation behavior

Phase 8 must refine the canonical contract **in place** (ADR-0012), not by introducing a
parallel spec.

Required documentation updates:

- `payments.create` description must no longer say replay/deduplication is deferred; it must
  describe the live replay behavior.
- `IdempotencyKey` parameter description must remain aligned with ADR-0004 and Phase 8 runtime
  behavior.
- The API conventions/idempotency documentation must reflect that `payments.create` is the first
  active consumer and `refunds.create` is the next planned consumer.
- If confirmed in D6, documentation must explicitly state that only committed successful mutation
  responses are replayed.

## 5. Data Requirements

Phase 8 introduces an internal persistence model for idempotency records via the committed
migration workflow.

### 5.1 `idempotency_records` (new table)

Required fields and responsibilities:

| Column                | Type          | Constraints / notes |
| --------------------- | ------------- | ------------------- |
| `id`                  | `uuid`        | PK; UUIDv7 (ADR-0001). |
| `project_id`          | `uuid`        | FK → `projects.id` **`ON DELETE CASCADE`**; idempotency is project-scoped. |
| `operation_scope`     | `varchar(...)`| Stores values such as `payments.create`, `refunds.create`. |
| `idempotency_key`     | `varchar(255)`| The validated client key as used for uniqueness within scope. |
| `response_status`     | integer       | Original HTTP status to replay. |
| `response_body`       | `jsonb`       | Original JSON response body to replay. |
| `created_at`          | `timestamptz` | UTC; start of retention window. |
| `expires_at`          | `timestamptz` | UTC; `created_at + 24h`. |
| `updated_at`          | `timestamptz` | UTC; required if the persisted claim row is completed by update inside the transaction. |

Notes:

- The table is **internal infrastructure** and has no public API resource.
- The stored body is the **API response projection**, not a Prisma row dump, so replay remains
  contract-correct and avoids raw `BigInt` serialization problems.
- The schema must remain **operation-agnostic**; it must not carry payment-specific foreign keys
  that would prevent reuse by refunds.

### 5.2 Uniqueness and expiry

- The database design must guarantee at most one **active** record for a given
  `(project_id, operation_scope, idempotency_key)`.
- Expired records must not block reuse after 24 hours.
- Functional correctness must not depend solely on asynchronous cleanup; request-path behavior
  must still allow correct post-expiry reuse even if stale expired rows remain in storage.
- Additional cleanup of expired rows is required to keep storage bounded, but the exact cleanup
  mechanism is an implementation detail so long as functional correctness is preserved.

### 5.3 Migration and integrity

- One committed migration on top of the Phase 7 schema creates `idempotency_records`, adds the
  `project_id` FK cascade, and adds the uniqueness/indexing needed for efficient claim/replay by
  `(project_id, operation_scope, idempotency_key)` and expiry.
- No secrets or seed data are introduced.
- Prisma schema updates must keep the infrastructure generic and decoupled from domain-specific
  tables other than `projects`.

## 6. Security Requirements

1. **Scope isolation:** idempotency is scoped by project, so a key never replays across projects.
2. **Authorization first:** authentication and authorization remain the first gate; idempotency
   must not create a bypass allowing unauthorized callers to retrieve prior responses.
3. **No duplicate side effects:** concurrency races with the same key must never create multiple
   payments.
4. **No existence oracle expansion:** replay behavior must not disclose resources outside the
   caller's already-authorized project scope.
5. **Header validation:** invalid `Idempotency-Key` values are rejected as 400 validation errors.
6. **Secure logging:** `Idempotency-Key` values must not be written to structured logs, error
   messages, request logs, or audit logs in plaintext unless a later logging phase explicitly and
   safely defines redaction rules. Phase 8 assumes the safe default: **do not log them**.
   Any request-header logging that remains enabled must redact the `Idempotency-Key` header once
   `payments.create` becomes a live idempotent consumer.
7. **Exact replay correctness:** replayed responses must preserve the stored status/body exactly,
   avoiding accidental recomputation that could leak changed state or produce drift.
8. **Atomic failure handling:** if the mutation transaction fails, no partial idempotency success
   record may remain committed.
9. **Contract hygiene:** OpenAPI/docs updates remain in-place and lint-clean.

## 7. Acceptance Criteria

1. All roadmap Phase 8 checkboxes (§2) are implemented and traced (§11).
2. `payments.create` with a valid `Idempotency-Key` stores a replayable result on first success
   and returns the same status/body on subsequent same-project, same-scope retries within 24
   hours.
3. A replayed `payments.create` request does **not** create a second payment row and does **not**
   emit another `payment.created` event.
4. Two or more concurrent `payments.create` requests with the same key produce **exactly one**
   payment and all successful callers observe the same resulting `Payment` response.
5. The same key used for another project does not collide.
6. The same key used for another operation scope does not collide.
7. Reuse of the same key after expiry is treated as a new operation and can create a new payment.
8. Invalid `Idempotency-Key` values (empty after trim, >255 characters) still return **400
   `VALIDATION_ERROR`**.
9. Requests rejected before mutation execution (authentication/authorization/validation failures)
   do not create a replayable success record.
10. The new idempotency persistence exists with project scoping, expiry support, and database
    uniqueness/integrity guarantees suitable for transaction-safe claim/replay behavior.
11. `docs/openapi.yaml` and related documentation reflect live `payments.create` idempotency
    behavior and remain lint-clean.
12. All repository checks required by `AGENTS.md` remain green after the Phase 8 implementation:
    lint, typecheck, unit tests, relevant integration/e2e tests, and build.

## 8. Testing Requirements

### 8.1 API (`apps/api`)

- **Unit tests**
  - header validation remains correct;
  - key scope resolution by `(project, operation_scope, key)`;
  - first-use claim path vs replay path;
  - replay returns stored status/body exactly;
  - post-expiry reuse behaves as a new operation;
  - replay does not re-run the wrapped mutation callback;
  - failed/rolled-back execution leaves no committed success record;
   - request-scoped tracing data still uses the current request ID;
   - request logging/redaction tests prove `Idempotency-Key` is not emitted in plaintext.

- **Integration/e2e tests with real PostgreSQL**
  - `payments.create` first request with key → **201** creates one payment;
  - immediate retry with same key → same **201** body, still one payment row;
  - same key without expiry in another project → independent create;
  - same key after expiry → independent new create;
  - concurrent same-key retries (parallel HTTP requests) → one payment row, one emitted
    `payment.created` event, replayed identical responses for the rest;
  - invalid header values → **400**;
  - requests failing authorization/validation do not poison the key.

### 8.2 Documentation / contract

- `docs/openapi.yaml` passes lint/validation after the Phase 8 description refinements.
- Idempotency documentation remains consistent across:
  - `.ai/SPEC.md` / phase references,
  - `docs/api-conventions.md`,
  - `docs/openapi.yaml`,
  - this phase specification.

### 8.3 Web application

- No new dashboard feature is required.
- Existing web/API clients that send `Idempotency-Key` on payment creation must remain compatible
  with the documented contract.

## 9. Definition of Done

Phase 8 is complete when:

- All acceptance criteria in §7 pass.
- The `payments.create` Phase 7 handoff is discharged: the header is no longer accepted-only;
  replay/deduplication is live.
- The idempotency capability is implemented as shared infrastructure rather than payment-owned
  one-off logic.
- The solution is transaction-safe under real database concurrency.
- The data model supports expiry and future reuse after 24 hours.
- The contract and documentation are updated in place and remain lint-clean.
- No unresolved security issue remains around duplicate side effects, cross-project leakage, or
  logging of idempotency keys.
- Phase 9 can adopt the same capability for `refunds.create` without redesigning the persistence
  model or semantics.

## 10. Implementation Considerations

- Prefer the **smallest correct design**: a database-backed claim/replay mechanism in the API
  layer, integrated into the payment-create path, rather than Redis locks or a separate service.
- Keep idempotency as a **cross-cutting module/boundary** consumed by payments now and refunds
  later.
- Reuse the existing project/auth scope already resolved by the payment routes; do not invent a
  second authorization model.
- Store the **serialized API response projection** for replay, not internal ORM objects.
- Ensure payment event emission happens only on the first committed execution.
- Ensure expiry handling supports both correctness (reusing expired keys) and bounded storage.
- Keep the implementation generic enough that Phase 9 adds `refunds.create` by configuration or
  a thin integration layer, not by cloning the Phase 8 logic.

## 11. Traceability (Roadmap → Phase 8)

| Roadmap Phase 8 checkbox                      | Specification reference |
| --------------------------------------------- | ----------------------- |
| Idempotency key support                       | §4.2, §4.3, §7.2       |
| Database constraints for uniqueness           | §5.1–§5.3, §7.10       |
| Transaction-safe operations                   | §4.4, §6.8             |
| Concurrency tests                             | §7.4, §8.1             |
| Idempotency behavior reflected in API documentation | §4.5, §8.2, §7.11 |

## 12. Out of Scope

- Refund business rules and refund endpoint implementation (Phase 9), although the
  infrastructure must be reusable for `refunds.create`.
- New public endpoints for idempotency inspection, deletion, or manual replay.
- Request logging and audit logging behavior for idempotency operations (Phases 11 and 12).
- Global rate limiting changes (Phase 13).
- Redis/BullMQ-based deduplication workflows.
- Webhook delivery changes (Phase 10) beyond ensuring duplicate payment events are not emitted.
- Browser/dashboard UX work specific to idempotency (Phase 14 / 15 if developer docs need UI
  exposure).
- Real-money processing, multi-currency logic, microservices, or infra rewrites.

## 13. Decisions

> **Status (2026-09-25):** D1-D5 are already fixed by accepted source-of-truth artifacts
> (Phase 1, ADR-0004, docs/api-conventions.md, and the Phase 7 handoff). Only D6 remains an
> explicit product-authority confirmation point because prior specifications define replay scope
> and retention, but do not explicitly decide whether non-success outcomes should also be stored.

| # | Decision | Recommended option [rec] / alternatives |
| - | -------- | ---------------------------------------- |
| D1 | First live consumer | **Resolved by Phase 7 / roadmap:** activate idempotency for **`payments.create` only** in Phase 8 while keeping the infrastructure generic for `refunds.create` in Phase 9. |
| D2 | Scope of uniqueness | **Resolved by Phase 1 / ADR-0004:** uniqueness scope is **(project, operation_scope, idempotency_key)**, independent of auth mode or user identity. |
| D3 | Replay behavior | **Resolved by Phase 1 / ADR-0004:** replay the **original stored HTTP status and JSON body** for same-scope retries within 24 hours, including returning **201** again for `payments.create`. |
| D4 | Concurrency behavior | **Resolved by Phase 1 + roadmap intent:** use database-backed transactional claiming so concurrent same-key requests yield **one committed mutation** and the losers replay the winner's stored response. |
| D5 | Post-expiry reuse | **Resolved by ADR-0004:** reuse after 24 hours is a **new operation** and expired rows must never block it, even if cleanup has not yet run. |
| D6 | Which responses are stored | **Pending confirmation. [rec]** Persist and replay only the response of a **committed successful mutation execution**; pre-execution failures (auth/validation/not-found before side effect) do not create a replayable success record. Alternative: persist and replay all 4xx/5xx outcomes too (heavier semantics, more surprising key poisoning, not required by current product requirements). |

## 14. Dependencies

- Inputs: Phase 7 (`payments.create` header handoff), Phase 5 (project/API-key scope), Phase 4
  (RBAC semantics), Phase 3 (session auth), Phase 2 (Prisma/migrations/testing base), Phase 1
  and ADR-0004.
- Blocks: Phase 9 (`refunds.create` should reuse this capability), and downstream critical-flow
  testing/documentation phases that assume safe retries.
- Coordination obligations out of this phase:
  - Phase 9 must integrate `refunds.create` with operation scope `refunds.create` using the same
    infrastructure.
  - Phase 15 developer documentation should explain the now-live payment idempotency behavior.
  - Phase 17 should include broader end-to-end retry coverage across payment/refund flows.
