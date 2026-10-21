# ADR-0044: Runtime Configuration and Secrets Model

- **Status:** Accepted
- **Date:** 2026-10-16
- **Phase:** 21
- **Scope:** Where production configuration comes from, what may be a build
  argument, the required-key inventory per process, the secrets-injection
  model (D4), and the forward mapping to Phase 24's secrets store (Phase 18
  §5 handover) — so Phases 22/23/24 consume one model instead of inventing
  their own.

## Context

All runtime behavior was already environment-driven through
`apps/api/src/config/configuration.ts` with boot-time validation (secret
strength, bounded ints, non-empty CORS allowlist, metrics path rules — F6),
and production defaults already change observable behavior (`COOKIE_SECURE`
true under production, `WEB_SECURE` gating HSTS, `METRICS_ENABLED` false in
production — F7/F9). What did not exist was the *production contract*: a
documented inventory of every key per process, a committed non-secret
template, and a model for how secrets reach containers without entering
images (Phase 18 §5 handover: "secrets injected via Phase 21").

## Decision

- **D4(a): runtime environment injection by whatever runs the container.**
  Secrets arrive as environment at start time — developer shell /
  uncommitted `.env` for the local validation run, CI secrets in Phase 23,
  AWS Secrets Manager in Phase 24 (recorded mapping, §17 of the phase spec).
  Docker secrets files were rejected as a second mechanism to keep in sync
  with this one; build-time `ARG` was rejected outright (recoverable from
  image history, violating §4 rule 3).
- **Configuration-free images** (§4 rule 2): no environment-specific value is
  baked into a layer; no image reads a committed `.env`; the runtime reads
  the environment only. The single documented exception class is the web
  image's *non-secret build arguments* (`NEXT_PUBLIC_API_BASE_URL`,
  `WEB_SECURE` — ADR-0043), which are build-time by framework semantics,
  listed explicitly, and never secret.
- **One committed template:** `docker/production.env.example` is the
  production configuration contract — every key the three processes consume,
  classified REQUIRED/OPTIONAL and SECRET/NON-SECRET, with production
  defaults and the reason for each (the F7/F9 inventory sourced from
  `apps/api/.env.example` and the Phase 18 §5 / Phase 20 handover tables).
  Secrets are empty on purpose; generation commands are documented
  (`openssl rand -base64 48` for `JWT_SECRET` and the metrics token,
  `openssl rand -base64 32` for `WEBHOOK_ENCRYPTION_KEY`). A unit suite
  (`apps/api/test/production-docker-artifacts.spec.ts`) enforces
  completeness and emptiness on every `pnpm test`.
- **Per-process required keys:**
  - **api** — `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `JWT_SECRET`,
    `WEBHOOK_ENCRYPTION_KEY` (all boot/contract-required);
  - **worker** — `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
    `WEBHOOK_ENCRYPTION_KEY` (the same module graph's boot validation; F8's
    silent-failure case if the key differs from the API's);
  - **web** — build args `NEXT_PUBLIC_API_BASE_URL`, `WEB_SECURE`; runtime
    `PORT` (default 3001), `HOSTNAME`.
- **Cross-process key equality (F8):** API and worker must receive identical
  `JWT_SECRET` and `WEBHOOK_ENCRYPTION_KEY`; a mismatch is silent at boot and
  only surfaces as failed webhook signatures. The validation procedure checks
  equality from the resolved compose environment (ADR-0046), and the
  production compose file sources both services from the same variables so
  one run cannot diverge.
- **Posture facts are documented, not re-invented:** for each Phase 18 §5
  fact the contract states what a real environment must set (proxy
  hops/CIDRs per ADR-0025, `COOKIE_SECURE=true`, `WEB_SECURE=true`,
  dashboard CORS origin, deliberate webhook destination lists), while the
  Phase 21 validation environment sets only what it can honestly know
  (D8(a) run-scoped plain-HTTP overrides — ADR-0046, never written back as
  defaults).
- **Metrics exposure (F9/ADR-0040):** production default
  `METRICS_ENABLED=false`; the Phase 21/24 firewall obligation (internal
  network only, scrape token when enabled) is recorded in the contract and
  demonstrated by the default-off posture.
- **Forward mapping (Phase 18 §5 / Phase 24 handover — discharged here,
  implementation downstream):** the D4 model is the contract; Phase 24 maps
  each SECRET key to AWS Secrets Manager and injects the resolved values as
  the same runtime environment. Nothing in this ADR requires a store.

## Consequences

- **Positive:** one inventory ends "which env does production need?"; the
  fail-fast boot validation (F6) is preserved unchanged and *proven* by the
  negative runs (ADR-0046) — a production image that boots without
  `JWT_SECRET` would be a regression, not a convenience; secrets never touch
  layers, build args, labels, or committed files (verified by layer/history
  scan).
- **Negative:** secrets exist unencrypted on the container host/container
  filesystem as environment (accepted: D4(a), the platform-native mechanism;
  file-based alternatives were rejected above); the web build-time inputs
  mean an origin/HSTS change is a rebuild.
- **Neutral:** no new configuration *semantic* was invented — only existing,
  documented keys are supplied differently (§4 rule 1); the ADR-0037
  accepted-risk register is read, not modified.
