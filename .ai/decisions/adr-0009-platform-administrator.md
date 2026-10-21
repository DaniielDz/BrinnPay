# ADR-0009: Platform Administrator — No MVP Product Functionality

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Actor model, API surface, web application, MVP boundaries.

## Context

The roadmap Phase 1 asks for actor identification, which includes a "platform administrator". The master specification describes no platform-administration product functionality: no admin UI, no admin API, no operational console. Internal operations (infrastructure, database, deployment) are handled outside the product surface.

## Decision

- **No product functionality for platform administrators in the MVP.**
- Any internal operational need is handled outside the public product scope of the MVP (direct infrastructure tooling, not a BrinnPay feature).
- **No platform-admin UI or API** is built in Phase 1 or any later MVP phase.
- The platform administrator is recognized in the actor model as an operational, non-product role.

## Consequences

- No admin console, no admin routes, no admin RBAC role is designed or built during the MVP.
- Saves scope and reduces attack surface; operational concerns remain infrastructure-level.
- If an admin surface is ever needed post-MVP, it becomes a separate product decision.