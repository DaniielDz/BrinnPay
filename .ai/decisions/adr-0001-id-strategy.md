# ADR-0001: ID Strategy — UUIDv7

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** All persistent entities of the BrinnPay domain model.

## Context

Every entity needs a globally unique identifier. The candidates considered were UUID (v4/v7), CUID, and ULID. Requirements driving the choice:

- **Cursor-based pagination** (roadmap Phase 6) benefits from time-ordered IDs that can serve as an opaque sort key without a secondary index walk.
- PostgreSQL natively supports the `uuid` type, avoiding custom/proprietary ID storage.
- IDs exposed through the API must be treated as **opaque values** by clients: they carry no semantic, security, or ordering contract for consumers.
- Collision-free generation at application scale with no centralized ID service (modular monolith).

## Decision

- Use **UUIDv7 (RFC 9562)** for all entity IDs.
- Store IDs as PostgreSQL `uuid`.
- Expose IDs in API responses and requests as opaque strings; clients must not parse, sort, or infer properties from them (except where the server explicitly documents an ordering guarantee for pagination cursors).
- The server derives pagination cursors from IDs; cursors are opaque to clients.

## Consequences

- Time-sortable IDs give dense, index-friendly ordering that naturally supports cursor-based pagination.
- No proprietary ID scheme or external dependency beyond a UUIDv7-capable generator (implemented in Phase 2 foundation).
- Time-ordered IDs are partially guessable (temporal locality); this is acceptable because authorization must never rely on ID secrecy — tenant isolation and per-resource authorization are enforced independently (see Security Baseline).
- Existing rows cannot be retrofitted to a different ID scheme without data migration; this decision is binding for all later phases.