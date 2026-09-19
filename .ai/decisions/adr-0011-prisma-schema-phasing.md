# ADR-0011: Prisma Schema Phasing — Base Schema in Phase 2, Domain Models in Owning Phases

- **Status:** Accepted
- **Date:** 2026-09-17
- **Phase:** 2
- **Scope:** Data layer (`apps/api/prisma/schema.prisma`, migrations).

## Context

Phase 1 assigns the definitive Prisma schema to "Phase 2 + domain phases", but all domain entities
(organizations, projects, api keys, customers, payments, refunds, webhooks) belong to later
phases. Modeling them in Phase 2 would force field-level design for Phases 3–13 (payment states,
key hashing formats, idempotency records) before those requirements exist, guaranteeing rework.

## Decision

- Phase 2 `schema.prisma` contains only the datasource and generator configuration — **zero domain
  models**.
- Domain entities are added by their owning phases via committed migrations.
- The following schema conventions are fixed for all later phases (recorded, not modeled, here):
  - Entity IDs are PostgreSQL `uuid` columns storing UUIDv7 (ADR-0001).
  - `snake_case` table and column names.
  - Every record carries `created_at`; mutable records carry `updated_at`; timestamps in UTC.
  - Money in integer minor units where applicable (ADR-0002).
- No domain tables, no seed data, and no fake/seed entities in Phase 2.

## Consequences

- Phase 2 introduces a minimal, stable base; schema design happens in the phase that also defines
  the behavior, avoiding premature modeling.
- A migration workflow is exercised early, so later domain migrations have a proven path.
- Domain phases must each add schema through migrations; there is no pre-built entity skeleton.