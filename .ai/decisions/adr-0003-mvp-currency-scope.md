# ADR-0003: MVP Currency Scope — USD Only

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Payment and refund API (Phase 7/9) for the MVP.

## Context

Full multi-currency support introduces complexity that is irrelevant to an MVP payment sandbox: exchange rates, per-currency formatting rules, minor-unit scale tables, and cross-currency validation. The master specification does not require multi-currency.

## Decision

- **USD is the only supported currency in the MVP.**
- The `currency` field remains present on payment and refund models and API payloads to preserve forward compatibility.
- For the MVP, `currency` must be `usd`; requests with any other value are rejected by validation.
- No currency conversion, rates, or cross-currency money logic is introduced.

## Consequences

- Single minor-unit scale (2) in practice, although the storage model (ADR-0002) remains scale-aware for the future.
- Simple validation rules and documentation.
- Additional currencies can be introduced without adding a new field or API version, but client behavior must be considered when expanding supported currency values.