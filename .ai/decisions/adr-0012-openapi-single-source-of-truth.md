# ADR-0012: OpenAPI Single Source of Truth — Serve Canonical Contract via Swagger UI

- **Status:** Accepted
- **Date:** 2026-09-17
- **Phase:** 2
- **Scope:** API documentation (`apps/api`, `docs/openapi.yaml`).

## Context

Phase 1 (§13.2) establishes `docs/openapi.yaml` as the single canonical contract. Phase 2 must
surface the contract in the running system via Swagger UI. An alternative — generating the
contract from @nestjs/swagger decorators — would create a second source of truth that can drift
from the canonical document, weakening the validated single contract.

## Decision

- Swagger UI is served from the API and reads the canonical `docs/openapi.yaml`.
- **No generated parallel contract in Phase 2.** @nestjs/swagger codegen is not adopted as a
  primary source; adopting it later requires an explicit ADR reversing this decision.
- `docs/openapi.yaml` remains the authoritative contract and must remain Redocly-lint clean (CI).
- Health endpoints (`/health/live`, `/health/ready`) are operational and stay outside the
  OpenAPI contract.

## Consequences

- A single reviewed contract document with one validation path in CI.
- Swagger UI depends on the contract file being available/embedded to the API at runtime.
- The API does not derive its contract from code, so contract changes are explicit and reviewed.