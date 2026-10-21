# ADR-0045: Migration Execution Ownership (Pre-Start Step)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Phase:** 21
- **Scope:** Who runs `prisma migrate deploy` in a production deployment and
  when (D3/Q1), why readiness is deliberately not schema-aware (Phase 2 D9
  preserved), and how each later phase adopts the same step — so no phase
  re-derives migration ownership.

## Context

Migrations existed (`apps/api/prisma/migrations`, ADR-0011) but had no
deploy-time owner (F5): `prisma migrate deploy` was invoked by hand (the
load-test runner does `docker compose exec api pnpm prisma:migrate:deploy`),
nothing ran migrations when an image started, and `/health/ready` checks
Postgres/Redis *reachability only* (Phase 2 D9) — an API booted against an
unmigrated database reports ready and then fails every request (F16). Two
ownership models were on the table and the ambiguity was escalated, not
guessed (§4 rule 9).

## Decision

- **D3(a)/Q1: an explicit pre-start one-shot step.** `prisma migrate deploy`
  runs as a documented, separate action *before* the API/worker start:
  - the Phase 21 validation procedure runs it first (ADR-0046), from the
    **builder stage** of `docker/api/Dockerfile.prod` (the one stage that
    legitimately carries the Prisma CLI — a devDependency that never enters
    the runtime image);
  - the production compose definition models it as a `migrate` service
    (`target: builder`, command `pnpm --filter @brinnpay/api
    prisma:migrate:deploy`); `api` and `worker` depend on it with
    `service_completed_successfully`;
  - Phases 22/23/24 adopt the same step in their own vehicle (task,
    pipeline job, deploy hook) — the *step* is the contract, the vehicle is
    phase-owned.
- **Rejected: an image entrypoint that migrates on start** — replica races,
  the image silently owning the schema, and boot conflating "schema ready"
  with "reachable" (readiness can never tell them apart — F16).
- **Readiness stays non-schema-aware** (Phase 2 D9 preserved): this phase
  changes no health semantics (§12); instead the validation procedure proves
  the gap explicitly — an unmigrated database answers `/health/ready` 200
  while the domain smoke call fails, which is exactly why the step precedes
  traffic.
- **The runtime image never contains the Prisma CLI** (§8 rule 3): the
  production dependency install excludes it; the builder stage is the only
  place migrations can run from inside Docker.

## Consequences

- **Positive:** schema rollout is an explicit, reviewable, idempotent action
  with a clear owner in every environment; `prisma migrate deploy` on an
  already-migrated database is a no-op, so retries are safe; replicas can
  start after one migration pass without racing each other.
- **Negative:** one more step in every deploy vehicle; a deployment that
  forgets it gets a green readiness and failing traffic (mitigated by the
  documented procedure and the M5 pre/post-migration evidence, ADR-0046) —
  an accepted, recorded limitation of the reachability-only readiness
  contract.
- **Neutral:** no schema or migration *content* changes (ADR-0011); the
  load-test harness's hand-rolled exec continues to work unchanged.
