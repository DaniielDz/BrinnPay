# ADR-0002: Money Representation

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Payment and refund amounts (Phase 7/9), and any monetary field introduced later.

## Context

Monetary values exchanged with developers must be unambiguous and familiar, while internal arithmetic must be exact. Floating-point representations cause rounding errors that are unacceptable for payment operations, even in a sandbox, because they corrupt expected integration behavior.

## Decision

- **Persistence (internal):** amounts are stored as **integers in the smallest minor unit** of the currency. USD uses 2 minor units, so `10.00` USD is stored as `amount_minor = 1000`.
- **API (external):** amounts are represented as **decimal strings** together with the currency code.

Example request/response payload:

```json
{
  "amount": "10.00",
  "currency": "usd"
}
```

- Conversion between the two representations happens at the API boundary. No internal code path operates on floating-point money.
- The minor-unit scale of a currency is defined by the currency itself (USD = 2); scale handling lives in a single currency/money helper module.

## Consequences

- Exact arithmetic; no rounding drift.
- API consumers see familiar decimal notation isolated from internal representation.
- Boundary conversion code is required and must be covered by tests (valid formats, leading/trailing zeroes, invalid amounts, scale mismatches).
- Currency scope is constrained per ADR-0003 (USD-only for the MVP).