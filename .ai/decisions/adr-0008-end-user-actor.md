# ADR-0008: End User Actor Interpretation

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Actor model (roadmap Phase 1 checkbox), domain model, MVP boundaries.

## Context

The roadmap lists "end user" as an actor to identify. The master specification defines no BrinnPay platform actor of that name; it defines `Customer` as an API entity created by developers and used in simulated payment flows. The label is ambiguous and could be misread as requiring a customer-facing product area, which the master specification does not include.

## Decision

- The "end user" actor of the roadmap represents the developer's **simulated `Customer`**.
- The end user **does not have a BrinnPay account**, **does not access the dashboard**, and has no authentication identity in BrinnPay.
- **No customer-facing product area exists in the MVP.**
- The `Customer` entity exists only at the API level (created and managed by developers through the API/dashboard).

## Consequences

- Removes the ambiguity and prevents inventing a customer-facing product area.
- Customer CRUD is a developer-facing feature (roadmap Phase 6), not an authentication domain.
- No guest/shopper flows, authentication, or UI are built for end users.