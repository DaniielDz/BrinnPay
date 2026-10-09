# ADR-0035: Contract Conformance — Bounded Response-Schema Validation Against the Canonical Contract

- **Status:** Accepted
- **Date:** 2026-10-09
- **Phase:** 17
- **Scope:** How the running API is checked against `docs/openapi.yaml` — the
  mechanism, the covered-operation allowlist, the dependency chosen, and why
  validation of every response was deferred (Phase 17 D5; F6).

## Context

ADR-0012 makes `docs/openapi.yaml` the single source of truth, and until this phase
nothing compared an actual response to it. Redocly lint proves the *document* is
well-formed; the docs-consistency specs prove the *guides* agree with it. Neither
catches the implementation drifting away from the contract (F6) — a renamed field, a
changed status code, a loosened enum would ship with a fully green pipeline.

Constraints:

1. **The specification is the source of truth** — drift must fail the build, not warn
   (AGENTS.md, ADR-0012).
2. **Bounded.** D5 confirmed a bounded scope: response-schema validation of core
   resources plus the error envelope, not validation of every response of every
   operation.
3. **Additive changes must not fail.** The goal is catching drift, not freezing the
   schema: a legitimately new response field is not drift (§17).
4. **Assertions must not leak.** A failure message names the operation, status and
   failing schema paths — never the response body, which can carry secrets (§9 rule 1).

## Decision

**Bounded response-schema validation of curated `(operationId, status)` pairs, executed
against real responses inside the API e2e layer (D5(a), confirmed 2026-10-09).**

- **Mechanism.** `apps/api/test/support/conformance.ts` parses the canonical contract
  once per process, resolves the JSON pointer of the documented response schema
  (following `$ref` chains such as `components/responses/NotFound`), compiles it, and
  validates a real response body. `apps/api/test/contract-conformance.e2e-spec.ts`
  boots the real application, drives a real journey (project → customer → webhook
  endpoint → payment → delivery → refund) plus the error envelope (400/401/404), and
  validates each body through `conformance.assert()`. A mismatch is an assertion error
  listing the failing paths; the build fails (AC12).
- **The allowlist is the bound.** Coverage is expressed as an explicit list of
  `(operationId, status)` pairs — `projects`, `customers`, `payments`, `refunds` and
  the webhook endpoint/event/delivery projections, each with its success status, plus
  the documented 400/401/404 error envelope responses. Two meta-tests keep the list
  honest: every listed pair must exist in the contract, and every listed pair must be
  exercised against a real response by that file — the allowlist cannot rot into a
  list of untested claims (rule 5).
- **Additive tolerance.** `additionalProperties: false` is stripped from a deep copy
  before compilation (the raw document other suites assert against is untouched), so a
  newer API adding a field never fails the build; OpenAPI keywords that are not JSON
  Schema (`example`, `description`, …) are tolerated (`strict: false`). Formats
  (`date-time`, `uuid`, `email`, `uri`) are validated.
- **Dependency.** `ajv` (2020 dialect, `ajv/dist/2020`) plus `ajv-formats`, with the
  `yaml` parser the API already ships for the contract — all development dependencies
  of `@brinnpay/api`, none of them on a runtime path.
- **Testability of the tool itself.** The helper is pure logic and has its own unit
  suite (`test/support/conformance.spec.ts`, layer L1): `$ref` resolution, path
  reporting, additive tolerance, unknown-operation and undocumented-status failures.
- **Not in scope here:** request-body validation of every operation, response
  *headers*, and any validation of undocumented pairs — Q4 keeps the open
  `payments.retrieve` description (Phase 7 OQ-4) untouched unless a drift fix is
  actually required.

## Consequences

- Implementation↔contract drift in the covered surface now fails `pnpm test:e2e`
  (and therefore CI) with a message naming the exact schema paths.
- The allowlist is a maintained artifact: adding a resource area to the covered
  surface means adding its pairs **and** exercising them in the same file.
- The contract file itself is parsed by tests and by Swagger UI from one path
  (ADR-0012); `/docs-json` is asserted to serve exactly the canonical document, so
  decorator-generated parallel contracts are caught too.
- Full-coverage validation remains open for a later phase if drift in uncovered
  operations ever becomes a problem; widening it later is a list change, not a
  redesign.

## Alternatives rejected

- **Status quo — Redocly lint plus docs facts (D5(b)):** no new dependency, but the
  implementation↔contract gap F6 describes stays undetected; lint validates the
  document against itself, never against a response.
- **Validating every response of every operation (full coverage):** rejected by the
  confirmed bounded scope — it needs fixtures for every code path (error branches,
  pagination, throttling) and would couple the suite to incidental response details,
  raising flake for no additional drift signal on the core resources.
- **Schema-generating the contract from the implementation (or the reverse):** rejected
  — ADR-0012 forbids a parallel contract; generation would move the source of truth
  back into code.
- **Snapshot-testing responses:** rejected — snapshots record whatever the code
  currently returns (they cannot detect drift from the specification) and churn on
  every legitimate additive change.
