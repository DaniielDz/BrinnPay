# ADR-0004: Idempotency Retention Window

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Idempotency behavior (Phase 8) and any mutation that accepts an `Idempotency-Key`.

## Context

Idempotency protects clients from duplicate side effects when retrying a mutation. Retained responses must be stored long enough to cover realistic retry windows while the storage remains bounded. The timeframe must be documented and implemented consistently with the API contract.

Alternatives considered:

- **Indefinite retention:** simplest semantics, but unbounded table growth for a long-lived service; replay of keys used months earlier returns stale state.
- **Short TTL (< 24h):** risks re-executing operations when clients retry within a day.
- **24-hour retention:** aligns with widely observed practices in the payments industry; bounded storage; covers realistic retry/network windows for an MVP sandbox.

## Decision

- Idempotency records are retained for **24 hours** (default; single configurable constant shared by storage and API documentation).
- The scope of an idempotency key is the tuple **(project, operation_scope, idempotency_key)**:
  - `project` — the project the mutation belongs to;
  - `operation_scope` — the specific idempotent operation, at minimum `payments.create` and `refunds.create`;
  - `idempotency_key` — the client-supplied `Idempotency-Key` value.
- Within the retention window:
  - the same key in the same project **and** the same operation scope → **replay of the original stored response** without re-executing the operation;
  - the same key in the same project but a **different operation scope** → an **independent operation** (no collision).
- After the retention window expires, reusing the same key is **treated as a new operation**.
- The storage design must allow a key to be reused after expiry (e.g., TTL-based cleanup or equivalent); uniqueness applies to active records within the window.
- The policy is documented in the API documentation and reflected consistently in the Phase 8 implementation and tests.

## Consequences

- Bounded storage; simple, industry-aligned semantics.
- Keys cannot collide across different operations of the same project, so payment and refund retries remain isolated.
- A client retrying a mutation more than 24 hours after the first attempt may receive a second, distinct result — acceptable for a sandbox and documented.
- Phase 8 must implement the TTL/cleanup lifecycle and prove the boundary behavior with tests (replay within window → original response; different operation scope → independent operation; reuse after expiry → new operation).