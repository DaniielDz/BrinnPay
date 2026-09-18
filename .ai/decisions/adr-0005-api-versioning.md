# ADR-0005: API Versioning — URL Prefix

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Public REST API (`apps/api`).

## Context

API consumers must be able to depend on stable contracts. The versioning strategy must be explicit, simple to implement in a modular monolith, and visible in URLs and logs without extra machinery.

## Decision

- All public API endpoints are versioned via URL prefix: `/api/v1/...`.
- The version is pinned per request by the URL; there is no negotiation header or default-version fallback.
- **No breaking changes within a version.** Additive, backwards-compatible changes (new fields, new endpoints, new optional parameters) are permitted.
- Breaking changes require a new version (e.g., `/api/v2/...`) with isolated paths; old versions continue to operate until formally deprecated.
- `v1` is the only version during the MVP.

## Consequences

- Simple, explicit, cacheable versioning with no negotiation complexity.
- Versioned paths make support and debugging straightforward from request logs.
- Maintaining multiple versions imposes a future cost; acceptable because breaking changes are expected to be rare.