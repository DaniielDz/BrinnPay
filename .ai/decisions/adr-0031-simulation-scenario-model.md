# ADR-0031: Simulation Scenario Model — Create-time Immutable Scenario Persisted on the Payment Row

- **Status:** Accepted
- **Date:** 2026-10-07
- **Phase:** 16
- **Scope:** How a payment's simulated outcome (success / decline / timeout) is selected,
  persisted, and applied — the `scenario` request field, the `failure_code` catalog, the
  nullable column, and the atomic failed-edge write (Phase 16 D1, D2, D4, D6; §4.2–§4.8,
  §7).

## Context

Phases 1–15 ship a single default-success simulation: `scheduledTransition()` already
models a `failed` outcome, but the caller (`advance()`) never passes one, so no public
path can produce `failed`, and `payments.failure_code` (a `varchar(50)` column added by
Phase 7) is never written. Phase 7 D2/OQ-3 and Phase 7 §15 explicitly deferred decline,
timeout, and the `failure_code` catalog to this phase; Phase 14 handed over a dashboard
hook, Phase 15 reserved the sandbox-guide extension.

Constraints that shape the choice:

1. **The schedule is derived, not stored.** Settlement is computed from `created_at` plus
   env-driven delays and applied later by a queue-driven sweep or read-time catch-up with
   no request context. Any per-payment intent therefore *must be readable from the row*
   minutes after creation — an in-memory or request-scoped option cannot survive the gap,
   nor a process restart (Phase 7 restart-safety rule; ADR-0013 sweep).
2. **The lifecycle is normative.** Phase 7 §4.3 admits only `pending → processing`,
   `processing → succeeded`, `processing → failed`, with absorbing terminal states and no
   user-initiated transitions; "the simulation is the only driver". A failure trigger must
   not add an edge or a new operation on an existing payment.
3. **Backwards compatibility is absolute** (AGENTS.md, ADR-0005): a payment created
   without the new fields, and every pre-existing row, must behave exactly as today.
4. **`applyEdge()` writes only `status`.** The `payment.failed` event payload and the
   Phase 12 audit entry are currently built from the pre-edge row, where `failure_code` is
   `null`. Adding a trigger without changing the write would ship `failed` payments with
   `failure_code: null` in the API response, the webhook payload, and the audit entry —
   violating Phase 7 §4.6 ("`failure_code` is stored when a payment fails").
5. The request must stay a single additive contract change: no new route, no new rate-limit
   class, no new capability, no new environment variable.

## Decision

**A create-time immutable `scenario` field on `payments.create`, persisted in one nullable
column on `payments`, with a closed `failure_code` catalog and a single atomic failed-edge
write.**

- **Selection (D1 (a), confirmed 2026-10-07):** `POST /projects/{project_id}/payments`
  accepts two new *optional* fields (additive, ADR-0005, no version bump):
  - `scenario` — closed enum `succeed` (default) | `decline` | `timeout`; absent ⇒
    `succeed`, i.e. exactly today's behavior.
  - `failure_code` — a value from the catalog, **only valid with
    `scenario: "decline"`**; absent ⇒ the catalog default `card_declined`; explicit `null`
    is rejected (400).
  Validation happens at the DTO boundary (closed enums, never free strings) *before* the
  idempotency claim, so an invalid scenario leaves the `Idempotency-Key` reusable
  (Phase 8 rule). Both auth modes behave identically: no new capability, no new route, no
  new rate-limit class.
- **Timing (D2 (a)):** the scenario is fixed when the payment is created and is immutable
  afterwards — no update/patch endpoint for scenarios, no project/organization defaults,
  no force-fail action on an existing payment. A scenario *configures* the simulation; the
  simulation remains the only driver of transitions.
- **Persistence (§7):** one new nullable column, `simulation_scenario varchar(50)`,
  app-validated as a closed enum (Phase 4 D10 pattern), committed through the ADR-0011
  migration workflow. Nullable-not-defaulted: `NULL` ⇒ default success, so existing rows
  need no backfill and "absent" and "succeed" are the same state. Determinism and restart
  safety are preserved because the outcome stays a pure function of
  `(persisted scenario, created_at, configured delays)`.
- **Catalog (D4 (a)):** `card_declined` (default), `insufficient_funds`,
  `processing_timeout` — exactly Phase 7 OQ-3's stated examples. Stored in the existing
  `failure_code` column; the catalog is a **single shared constant** in the API, surfaced
  to the contract and (via the Phase 15 D8 consistency mechanism) to the docs, so contract,
  guides and tests cannot drift. Extending the catalog later is an additive contract
  change.
- **Atomic failed edge (F2 — correctness requirement):** the decline edge is written as one
  transaction containing together (a) the CAS `status = failed` **and**
  `failure_code = <catalog value>`, (b) the `payment.failed` event row whose payload
  already reflects the new values, and (c) the `payment.failed` audit entry carrying the
  same `failure_code`. Event payload and audit capture are built from the **post-edge**
  values. A rollback leaves none of the three behind; contention still yields exactly one
  writer and one emission. The success edge keeps writing `failure_code = null`.
- **Timeout semantics (D3 (a)):** `scenario: "timeout"` advances `pending → processing` on
  the normal pending delay and then **never settles** — no settlement edge ever becomes
  due, so the payment remains `processing` indefinitely (no terminal event, `failure_code`
  stays `null`, refunds stay unavailable). `processing_timeout` remains in the catalog as a
  *decline* code, so "gateway hangs" and "gateway fails" are two distinct, individually
  testable cases.
- **Visibility (D6 (a)):** the scenario is **not** exposed on the `Payment` response;
  terminal outcomes remain visible via `status`/`failure_code`. No new public field, no
  mapper change.

## Consequences

- One nullable column plus one committed migration; no new tables, indexes, environment
  variables, modules, services, or routes (§7).
- The failed edge's `updateMany` data becomes `{ status, failureCode, updatedAt }`, and the
  existing audit line that reads `current.failureCode` must be read *after* the edge — a
  subtle, easy-to-regress change guarded by AC2/AC3's three-surface rollback test.
- `scheduledTransition` stays pure: the scenario is passed in as data (like today's
  `outcome` parameter); the caller supplies it from the row it already holds.
- A never-settling (timeout) payment matches the sweep's `createdAt ≤ cutoff` due-filter
  forever, occupying bounded batch slots each pass; the filter must become scenario-aware
  (§16/F8) so global-scan pressure does not grow with timeout usage.
- The state machine admits **no new edge and no new event** (AC12); `payment.processing`
  stays out of the catalog (D7 (a)) — `payment.created` plus terminal events bracket the
  lifecycle, and a stuck payment emitting nothing further is exactly what D3(a) simulates.
- Backwards compatibility holds by construction: `NULL` scenario ⇒ today's behavior, and
  pre-phase tests keep passing as the regression gate (AC1).
- Rate limiting is untouched: scenario creates ride the existing `write` class, counted
  exactly once (D8 (a), AC8).

## Alternatives rejected

- **Project/organization-level default scenario setting** (D1 (b)) — invisible to
  API-only users, needs new storage, endpoints, and a UI surface, and fits "test this one
  payment" poorly.
- **Magic triggers** (D1 (c)) — special amounts or descriptions as hidden behavior; brittle
  and impossible to document honestly.
- **Dashboard-only control** (D1 (d)) — excludes the primary audience (API integrators).
- **Force-fail operation on existing payments** (D2 (b)) — a user-initiated transition:
  new operation, rate class, and audit questions, and it re-reads Phase 7's
  "simulation is the only driver" rule as violated.
- **Terminal failure for timeout** (D3 (b)) — collapses the roadmap's separate timeout
  bullet into a decline variant and leaves nothing exercising "never completes".
- **Omitting `processing_timeout` from the catalog** (D3 (c)) — loses the distinct
  "gateway returned a timeout failure" case; keeping it as a decline code costs nothing.
- **A larger card-style failure catalog** (D4 (c)) — invented beyond any requirement;
  a single `declined` code (D4 (b)) is too thin to exercise code-driven handling.
- **Exposing `scenario` on the `Payment` response** (D6 (b)) — a new public field, mapper,
  and docs surface for a value the creator already knows.
- **Encoding intent in `description`** — corrupts user data; **reusing `failure_code`
  pre-failure** — violates the null-unless-failed invariant; **a separate 1:1 scenario
  table** — overkill; **Redis/in-memory intent** — not restart-safe (§7).
