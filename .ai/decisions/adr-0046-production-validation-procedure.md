# ADR-0046: Production Validation Procedure (Local Plain-HTTP Proof)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Phase:** 21
- **Scope:** The committed production runtime validation (D5(a)) — what it
  asserts (the §6 M5 checklist), its TLS posture and run-scoped overrides
  (D8(a)/Q2), its hygiene rules, and where its evidence lives — so Phases
  22/23/26 consume this procedure instead of re-deriving one.

## Context

F15/F16: production-mode proof could not be taken cheaply. Authenticated
flows break over plain HTTP under the production `COOKIE_SECURE=true`
default (browsers drop the refresh cookie), readiness is reachability-only
so it cannot prove the schema (F16), and no specification assigned
validation-vehicle ownership: D5 (vehicle), D8 (TLS posture), and Q2 ("what
must validation prove?") were escalated and answered by the product
authority on 2026-10-16 — D5(a) + D8(a): local plain-HTTP proof with
run-scoped overrides; CI wiring deferred to Phase 23.

## Decision

- **Vehicle (D5(a)):** `docker/compose.production.yml` (committed
  production-mode compose definition, compose project `brinnpay-production`
  — isolated from the dev project `brinnpay` and the load-test project
  `brinnpay-loadtest`) plus `docker/production/validate.mjs` (committed,
  idempotent Node script; no dependencies beyond Docker + the repo). It
  replaces no dev file; CI wiring is explicitly Phase 23's (§12).
- **TLS posture (D8(a)/Q2):** the validation run is plain HTTP with
  **run-scoped overrides** `COOKIE_SECURE=false` and `WEB_SECURE=false`,
  supplied only through the per-run generated env file (never committed, never
  defaults — the production template documents `true` as the expectation). The
  overrides exist so authenticated flows can be exercised for the right
  reason (transport), not to weaken any application control: guards, rate
  limits, redaction, and tenancy run unmodified (§4 rule 5). TLS-terminated
  proof belongs to Phases 22/24. The `web` image receives `WEB_SECURE` as a
  build argument for this run (HSTS is baked at build — ADR-0043).
- **What the procedure asserts** (the eight §6 M5 assertions, plus two
  extensions the spec's "at minimum" allows, all checkable with plain HTTP):
  1. **M5-1** API `/health/live` and `/health/ready` → 200 with the
     documented Phase 2 payloads;
  2. **M5-2** (§6 M4 negative run) API refuses to boot on missing
     `JWT_SECRET` and on weak `JWT_SECRET`/`WEBHOOK_ENCRYPTION_KEY`, with no
     secret material in the refusal output;
  3. **pre-migration negative run** (F16) API against the unmigrated
     database answers `/health/ready` 200 while a domain call fails —
     demonstrating why the migration step precedes traffic;
  4. **M5-3** post-migration domain smoke: register + authenticated
     organization read through the documented flow (schema proof, not just
     reachability);
  5. **M5-4** worker runs and `/health/live` answers on
     `WORKER_METRICS_PORT` (9464, unpublished);
  6. **M5-5** web serves the home page (200) and the API reference renders
     from the canonical contract (`auth.register`);
  7. **M5-6/6b** metrics exposition **off** by default; when deliberately
     enabled for the run it answers only with the documented posture
     (401 without the bearer token, documented path);
  8. **M5-7** neither image contains a secret, an `.env` file, or the dev
     toolchain — asserted against image **layers/history** and the runtime
     filesystem;
  9. **M5-8** D8 posture: plain-HTTP run with the run-scoped overrides works
     (no HSTS, authenticated flow succeeds);
  10. **M5-9** (§6 M4 / F8) cross-process key equality: API and worker
      receive identical `JWT_SECRET` and `WEBHOOK_ENCRYPTION_KEY`, resolved
      from `compose config` (parsed in memory, never echoed).
- **Procedure flow:** preflight (Docker/compose available) → build both
  images with local tags `brinnpay/{api,web}:<version>-<git-sha>` (D6(a)) →
  negative secret runs (M5-2) → throwaway PostgreSQL/Redis → pre-migration
  negative run → **migrations first** (the `migrate` service, builder stage —
  ADR-0045) → start API + worker + web from the production images → run the
  checks above → tear down (`down -v`, always, including on failure).
- **Hygiene rules (§16):** idempotent; self-cleaning; project-isolated;
  secrets generated per run with `openssl`-equivalent crypto
  (`JWT_SECRET`/metrics token 48-byte base64, `WEBHOOK_ENCRYPTION_KEY`
  32-byte hex/base64), written to a mode-`0600` temp env file deleted on
  exit, **never printed to any log** (including `compose config` output,
  which is parsed in memory only); non-zero exit on any failed assertion;
  completes with only Docker + the repository (no CI-only services, no
  registry).
- **Evidence location:** the procedure and a recorded run (what was run,
  what passed) live in `docker/README.md` "Production images and validation
  (Phase 21)"; the assertion inventory and posture reasoning live here.
  Phase 22 reuses the procedure as its staging template (§17); Phase 23
  decides pipeline wiring; Phase 26 consumes the recorded evidence.
  Raw container logs stay local-only (Phase 19 evidence precedent:
  distilled evidence in-repo, raw runs local).

## Consequences

- **Positive:** AC5 evidence is reproducible from a clean checkout with one
  command; F16 is proven by the pre/post-migration pair instead of asserted;
  F8's silent key divergence and F11's "no secret in image" are executable
  checks; the dev and load-test compose projects are untouched.
- **Negative:** local plain HTTP is not a production-faithful transport —
  TLS-terminated proof is explicitly deferred (D8, Phases 22/24); the
  procedure needs Docker and several minutes (kept out of the Phase 17
  suite by D5 rejection (c)); `WEB_SECURE=false` for the run means the
  validation web image is built with HSTS off — documented as run-scoped
  and never reused as a default.
- **Neutral:** no health/metric/OpenAPI semantics change (§12, AC6); CI
  gains no job from this ADR (Phase 23 owns it, §9).
