# ADR-0030: API Reference Mechanism — Embedded, Display-only Reference Generated from the Canonical Contract

- **Status:** Accepted
- **Date:** 2026-10-06
- **Phase:** 15
- **Scope:** How the API reference is presented to developers in the docs area
  (Phase 15 D2 and Q4, §15/§16; §6).

## Context

The canonical contract `docs/openapi.yaml` is already rendered publicly in two places:
Redocly lint in CI, and the API's Swagger UI mounted at `{API origin}/docs` (Phase 2 D5,
`apps/api/src/openapi/swagger.ts`, unconditional mount path `docs`). Phase 15 must make
the reference discoverable from the web app's own `/docs` area, which lives on a
**different origin** than the API.

Constraints:

1. **ADR-0012** — the contract is the single source of truth; a hand-written reference is
   a parallel contract and guaranteed to drift.
2. **Phase 14 CSP** — `connect-src` allows only `'self'` plus the configured API origin;
   `'unsafe-eval'` is forbidden in production and the "zero CSP violations" criterion
   must hold (§11.6, F9).
3. **Static and API-independent docs** — the docs area must render with no API, database,
   or Redis running (§4.2, §9.3); fetching the contract from the API at runtime would add
   a runtime dependency and a CORS surface (§17).
4. **Relative server URL** — the contract declares `servers: url: /api/v1`, so any
   absolute base URL shown to a reader must be resolved against the configured API origin
   (`NEXT_PUBLIC_API_BASE_URL`), never invented (§6).

## Decision

**An embedded, display-only API reference at `/docs/api-reference`, generated at build
time from `docs/openapi.yaml` with a bundled renderer; the API's Swagger UI is kept as a
documented secondary path.**

- **Generated, never hand-written:** the reference is produced from the canonical file at
  build time (workspace build context is the repo root, so the file is available). No
  second contract may be authored; `pnpm lint:openapi` stays at zero errors (§6).
- **Bundled renderer:** the renderer ships from the workspace dependency set — no remote
  asset origins (fonts, scripts, CDN), no `'unsafe-eval'`, no HTML-injection path from
  the contract file (`dangerouslySetInnerHTML` is not used for contract-derived content,
  §11.5). Validated against the running build's CSP (§11.6).
- **Display-only (Q4):** the reference presents paths, parameters, schemas, and
  documented responses; it sends no requests. No "try it out" console, no widened
  `connect-src`, no CORS expectations from the docs origin. Swagger UI remains the
  surface that can offer interactivity.
- **Base URL:** resolved against `NEXT_PUBLIC_API_BASE_URL` + `/api/v1` for display, or
  presented as an explicit placeholder to prefix — never a wrong absolute host (§6).
- **Secondary path:** `/docs` and the API reference page link to the API's Swagger UI as
  an alternative. Both render the same file, so they cannot contradict each other; the
  Swagger mount is left unchanged.
- **Contract edits in this phase** are limited to non-breaking documentation refinements
  (descriptions, examples, tag summaries) under D7 confirmed (a); semantic changes
  (path, schema, status code, required field) escalate instead of landing here.

## Consequences

- One origin for all docs, no cross-origin navigation from `/docs` into the API's
  Swagger UI, and the docs area stays static (§9.3).
- One new runtime dependency for the renderer, plus a CSP validation step on a running
  build; both are explicit acceptance criteria (§12.6, §12.12).
- The contract file becomes a build-time input to the web app; if it ever moves outside
  the Docker build context or mounts, `docker/web/Dockerfile` and `docker/compose.yml`
  must be extended (§17).
- Because the reference is display-only, testing "try it" flows (auth from the browser,
  preflight behavior) stays the Swagger UI's and Phase 17's concern, not this phase's.
- Drift is structurally impossible between the reference and the contract (same file);
  residual drift risk exists only between guides and the contract, covered by D8 checks.

## Alternatives rejected

- **Link-out to the API's Swagger UI only:** viable and zero-code, but cross-origin UX,
  the docs area would depend on Swagger remaining exposed in the deployment, and the
  roadmap bullet "API reference docs" would be satisfied by a link rather than a docs
  surface. Kept as the documented secondary path instead of the primary mechanism.
- **Hand-written reference:** rejected — ADR-0012 forbids a parallel contract; drift is
  guaranteed the first time the contract changes.
- **Runtime fetch of `openapi.yaml` from the API:** rejected — introduces a runtime
  dependency on a running API into a static docs area and a CORS surface for the file,
  for no benefit (the file is available at build time).
- **"Try it out" interactivity in the embedded reference:** rejected (Q4) — widens
  `connect-src`/CORS expectations, duplicates what Swagger UI already offers, and turns
  documentation into an API-backed product feature (§14).
