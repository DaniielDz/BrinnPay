# Phase 21 — Production Docker

| | |
| --- | --- |
| Phase | 21 — Production Docker |
| Status | **Confirmed (2026-10-16).** D1–D8 confirmed and Q1–Q5 answered by the product authority; answers recorded in §14. The specification is ready for implementation on `feature/phase-21-production-docker`. |
| Depends on | Phase 2 (compose stack, dev Dockerfiles, `/health/live` + `/health/ready` contract, config and env patterns), Phase 3 (`JWT_SECRET` boot validation), Phase 10/ADR-0018 (worker as a second process from the same codebase), Phase 15/ADR-0012/ADR-0030 (`docs/openapi.yaml` canon consumed by API boot and by the web API reference), Phase 17 (test harness, required checks), Phase 18 (§5 deployment-fact handovers: proxy trust, `COOKIE_SECURE`/`WEB_SECURE`, secrets, webhook destination lists, CORS; ADR-0037 accepted-risk register), Phase 19 (load harness that must keep working; no invented performance absolutes), Phase 20 (probe facts, metrics port/path/env keys, the D4 firewall obligation recorded for Phase 21/24), ADR-0011 (Prisma schema/generated client), ADR-0028 (HSTS/`WEB_SECURE` posture), ADR-0036 (dependency audit gate), ADR-0040 (metrics exposure posture) |
| Blocks | Phase 22 (staging deploys *these* images and reuses this phase's config contract and validation procedure), Phase 23 (CI builds/tags/validates the images this phase defines), Phase 24 (AWS: Secrets Manager consumes this phase's secrets model; network/firewall obligations recorded here), Phase 26 (release QA consumes the validation evidence) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 21 |
| Branch | `feature/phase-21-production-docker` |

## 1. Objective

**Build production-grade Docker images for the API, the webhook worker, and the web
application, and define how they are configured, how their secrets reach them at runtime,
and how their production behavior is proven before anything deploys them.**

Like Phases 17–20 this is an *enabling* phase: it produces build and runtime artifacts for
infrastructure, not product features. It introduces no new business behavior, no contract
change, and no schema change. Its ambiguities — who executes migrations, what "runtime
validation" must prove, whether a registry is involved this early, whether Swagger ships in
production — were escalated in §13/§14 rather than assumed and were answered by the product
authority on 2026-10-16 (D1–D8 confirmed, Q1–Q5 answered); the phase is ready for
implementation.

### Roadmap traceability

| Roadmap Phase 21 checkbox | Where |
| --- | --- |
| Production Dockerfile for API | §6 M1, D1, AC1 |
| Production Dockerfile/build strategy for web | §6 M2, D2, AC2 |
| Configuration management | §6 M3, D4, AC3 |
| Secrets injection | §6 M4, D4, AC4 |
| Production runtime validation | §6 M5, D5/D8, AC5 |

The roadmap goal sentence — "Optimized Docker images for production deployment" — has no
numeric size target in any specification; "optimized" is interpreted as *content and
behavior* requirements (multi-stage build, production dependencies only, no dev toolchain,
no secrets, non-root, pinned base) rather than an invented byte budget (Phase 19
"no invented absolutes" posture).

## 2. Scope

In scope:

- **API production image** (M1): a multi-stage build producing a runtime image that runs
  `dist/main.js`, plus the worker entrypoint `dist/worker.js` from the *same* image
  (ADR-0018 topology), with production dependencies only, non-root, pinned base, and the
  runtime artifacts the boot path requires (compiled output, generated Prisma client,
  canonical OpenAPI contract).
- **Web production image** (M2): a production `next build` strategy and runtime image,
  including whatever build-time inputs the app already requires (`NEXT_PUBLIC_API_BASE_URL`,
  `docs/openapi.yaml`).
- **Configuration management** (M3): one documented production configuration contract —
  required/optional keys, secret/non-secret classification, per-process (api / worker /
  web) — with a committed non-secret template and no configuration baked into images.
- **Secrets injection** (M4): the runtime-only delivery model for `JWT_SECRET`,
  `WEBHOOK_ENCRYPTION_KEY`, database/Redis credentials, and any optional tokens; the
  existing boot-time refusal behavior is the enforcement and must be proven, not relaxed.
- **Production runtime validation** (M5): a reproducible, documented procedure that builds
  the images, boots them with production configuration against throwaway dependencies, and
  asserts the documented checks — runnable from a clean checkout.
- **Documentation and handover**: update `docker/README.md` (or its successor location per
  Q5/D5) with the production procedure and hand Phases 22/23/24 the recorded facts.

Explicitly **not** in scope (§12): registry push and image distribution, CI/CD pipeline
work, staging or production deployment, cloud infrastructure, Kubernetes, TLS certificate
provisioning, monitoring-stack deployment, application behavior changes of any kind, and
ROADMAP.md bookkeeping beyond this phase's own checkboxes (report-only; `chore/*` at merge —
Phase 16 Q2 / Phase 18 F14 precedent).

## 3. Context and current-state findings

**What exists today** (Phases 0–20; branch `feature/phase-21-production-docker`):

- **Dev images only:** `docker/api/Dockerfile` and `docker/web/Dockerfile` run
  `nest start --watch` / `next dev` with source bind-mounted from the host
  (`docker/compose.yml`). `docker/README.md` states production Docker configuration "will
  be introduced during the production and deployment phases" — this phase.
- **Compose services:** `postgres`, `redis`, `api`, `web`, opt-in `worker` profile, opt-in
  `monitoring` profile; API/worker healthchecks call `/health/ready` and the worker's
  `/health/live` on `WORKER_METRICS_PORT` (9464, not published).
- **Config:** all runtime behavior is environment-driven through
  `apps/api/src/config/configuration.ts` with boot-time validation (secret strength,
  bounded ints, non-empty CORS allowlist, metrics path rules).
- **CI:** `.github/workflows/ci.yml` runs lint/typecheck/tests/build/browser e2e with
  Postgres/Redis service containers — **no Docker build step** (Phase 23 owns pipeline
  expansion).
- **Load harness:** `pnpm loadtest` drives a dedicated compose project
  (`-p brinnpay-loadtest -f docker/compose.yml`) and applies migrations with
  `docker compose exec api pnpm prisma:migrate:deploy`.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | **No production build exists.** Every roadmap checkbox is open; nothing in the repository produces a runnable production image, and no tagging/registry/CI build convention exists (F12). | §6 M1/M2, D1/D6. |
| F2 | **The web app has no production build strategy.** `next.config.ts` has no `output: 'standalone'`; `apps/web`'s `start` is `next start`, i.e. a full runtime with the whole dependency tree. "Build strategy" in the roadmap wording is a real fork. | D2, §6 M2, Q5. |
| F3 | **Part of the web configuration is build-time, not runtime.** `NEXT_PUBLIC_API_BASE_URL` is inlined into the client bundle (`apps/web/lib/brinnpay/client.ts`) and read by `next.config.ts` for the CSP `connect-src` origin — changing the API origin for a deployed web image requires a **rebuild**, not just new env. | §6 M2, §6 M3, AC2. |
| F4 | **Both images depend on `docs/openapi.yaml`.** The API resolves it at boot and **throws if missing** (`openapi/swagger.ts`); the web API reference reads it at build/render time (ADR-0030). A production image built without the checkout's `docs/` fails at boot. | §6 M1/M2, §11. |
| F5 | **Migrations have no owner at deploy time.** The Prisma client is generated to `apps/api/generated/prisma` (gitignored, imported by relative path) and `prisma migrate deploy` is currently invoked by hand (loadtest does `docker compose exec …`). Nothing runs migrations when an image starts, and `/health/ready` checks *reachability only* (Phase 2 D9) — an API booted against an unmigrated database reports ready and then fails requests. | D3, Q1, §6 M5. |
| F6 | **Boot-time secret validation already exists and is production-critical.** `JWT_SECRET` (≥ 32 chars), `WEBHOOK_ENCRYPTION_KEY` (exactly 32-byte base64; no inference fallback once `DATABASE_URL` is set), optional `METRICS_SCRAPE_TOKEN` (≥ 32 chars), non-empty `CORS_ORIGINS`. Production images must keep every refusal and *prove* it (docs/security-review.md §5–§6). | §6 M4, §8 rule 4, AC4. |
| F7 | **Production defaults change observable behavior and must be honored, not re-invented.** `COOKIE_SECURE` defaults true under `NODE_ENV=production`; `WEB_SECURE` gates HSTS; `METRICS_ENABLED` defaults **false** in production; `TRUST_PROXY_HOPS=0`/empty CIDRs (never correct behind a proxy — Phase 18 §5 handover); rate-limit and webhook-destination defaults stay as configured. | §6 M3, §8 rule 6. |
| F8 | **The worker is a second process, not a second image.** ADR-0018: `node dist/worker.js` from the same codebase; it must receive the same `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and — the one *silent* failure — the **same `WEBHOOK_ENCRYPTION_KEY`** as the API, or every delivery signature is unverifiable. | §6 M1, §6 M5, §8 rule 7. |
| F9 | **Phase 20 handed facts forward that this phase must consume and record.** Probe semantics (`/health/live`, `/health/ready`, 3 s dependency timeout, minimal payloads; worker `/health/live` on 9464), metrics path `/metrics`, `METRICS_ENABLED=false` in production by default, and the ADR-0040/D4 obligation: **production exposure of the metrics surface is an explicit Phase 21/24 firewall act**, never a default. | §6 M3, §8 rule 8, §17. |
| F10 | **The dev stack and the load harness must keep working untouched.** `docker/compose.yml` is consumed verbatim by `pnpm loadtest`; dev Dockerfiles and bind mounts are the Phase 2 development contract. | §4 rule 7, AC6. |
| F11 | **`.dockerignore` is dev-shaped.** It already excludes `.env*`, `.git`, `.ai`, and build output (good), but nothing proves today that a production build context or image layer is secret-free; images must be *verified*, not assumed (§8 rule 3). | §6 M4, AC7. |
| F12 | **Distribution is undefined.** No registry, no tag scheme, no image provenance, no CI Docker job; Phase 22 (staging), Phase 23 (pipeline), and Phase 24 (AWS) all plausibly claim parts of it. The boundary is ambiguous → escalated, not guessed. | D6, Q3. |
| F13 | **Native/toolchain constraints shape the base image.** `argon2` (native binding) and pnpm 12's build-script allowlist (`allowBuilds` in `pnpm-workspace.yaml`) mean the build stage must permit approved builds, and the runtime libc must match what the binaries were built against; dev/CI use Node 22 on Debian slim (glibc). | §6 M1, §16. |
| F14 | **Swagger UI is mounted unconditionally at `/docs`** from the canonical contract in every environment (`setupSwagger` runs in `main.ts`). The contract is public by design (Phase 15), but "public docs" vs "no debug surfaces in production" is a posture decision, not an implementation detail. | D7, Q4. |
| F15 | **Authenticated flows cannot be validated over plain HTTP in production mode.** With `COOKIE_SECURE=true` (production default) browsers drop the refresh cookie on `http://`, so a naive "run the production images locally and log in" check fails for the wrong reason — either TLS is terminated in the validation stack or documented validation-only overrides are used. | D8, Q2, §6 M5. |
| F16 | **Readiness ≠ schema.** Phase 2 D9 readiness checks Postgres/Redis reachability only, so it can never detect a missing migration; the validation procedure must assert *domain* behavior after migrating, not just green probes. | §6 M5, AC5. |

## 4. Domain rules (normative)

1. **No product behavior changes.** This phase changes how the existing system is built and
   started, never what it does. `docs/openapi.yaml` stays byte-identical, endpoint behavior,
   statuses, and error envelopes are unchanged, and no new configuration *semantic* is
   invented — only existing, documented keys are supplied differently.
2. **Images are configuration-free; the platform supplies configuration at runtime.**
   Environment-specific values arrive as environment at start (or, for the documented
   build-time inputs in §6 M2, as non-secret build arguments). Nothing environment-specific
   is baked into a layer, and no image reads a committed `.env` file.
3. **No secret ever enters an image or a build input.** Not in layers, not in build args
   (they are recoverable from image history), not in labels, not in committed files, not in
   logs (AGENTS.md "never expose secrets"). Non-secret build inputs are listed explicitly
   in §6 M2/M3.
4. **Fail-fast validation is preserved and proven, never bypassed.** Boot must continue to
   refuse missing/weak secrets outside tests; production validation must *demonstrate* the
   refusal (a production image that silently boots without `JWT_SECRET` is a regression, not
   a convenience).
5. **Same code, same processes, different launch mechanism.** The API image must be able to
   serve the API (`node dist/main.js`) *and* run the worker (`node dist/worker.js`); no
   `NODE_ENV` conditional feature, route, or control toggle may be introduced by this phase.
   Production differences come from existing configuration defaults (F7), not new switches.
6. **Smallest correct solution.** Multi-stage Docker builds and runtime env are sufficient.
   No orchestration framework, service mesh, image registry, image signing, SBOM pipeline, or
   base-image auto-update tooling is introduced here (§12) — those belong to Phases 23/24 or
   a future decision.
7. **Existing development contracts survive.** Dev Dockerfiles, `docker/compose.yml`
   behavior, the `worker`/`monitoring` profiles, and `pnpm loadtest` keep working unchanged
   (F10); production artifacts are additive (D1(a) recommendation).
8. **Images are hardened by default:** pinned base image (no `:latest`), same Node major as
   dev/CI (22), non-root user, production dependencies only, no test suites, no dev
   toolchain (`tsc`, `nest`, `jest`, `eslint`, `playwright`) in the runtime layer.
9. **Escalation over invention (Phase 18 rule 2, Phase 20 rule 2).** Migration ownership,
   validation vehicle and its TLS posture, registry/tagging, Swagger-in-production, and
   documentation placement are decided in §13/§14 — never chosen by convenience while
   implementing.
10. **Handovers are discharged or re-owned, never dropped** (Phase 19 rule 7): Phase 18 §5's
    "secrets injected via Phase 21", Phase 20 D4's "Phase 21/24 firewall obligation", and
    Phase 2's "no production Docker images (Phases 21–24)" all get a recorded disposition
    (§17).
11. **The phase's own work obeys the checks it reports on.** `pnpm lint`,
    `pnpm lint:openapi`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`,
    `pnpm audit:deps` (AGENTS.md); security-sensitive changes (secrets handling, image
    hardening, production posture) carry an explicit security review in their PR.

## 5. API behavior

**Default expectation: no changes to the versioned contract.** Everything in
`docs/openapi.yaml` — routes, statuses, error codes, auth modes, pagination, headers — is
untouched. `/health/live` and `/health/ready` keep their Phase 2 semantics, payloads, and
placement outside `/api/v1`. The metrics exposition keeps its Phase 20 classification
(outside the prefix, not rate-limited, not request-logged, not in OpenAPI).

What this phase defines, narrowly:

- **Boot behavior under production configuration** is documented, not changed: with
  `NODE_ENV=production` and no secrets supplied, the API and the worker refuse to start
  (F6); with a complete environment they start and pass their probes. Documentation must
  state exactly which keys are required per process (§6 M3) so a deployment failure is
  diagnosable from the refusal message, which never echoes a value.
- **Worker process:** no HTTP API of its own beyond the Phase 20 metrics/liveness listener
  (`WORKER_METRICS_PORT`, not published); started from the same image with a different
  command; never shares the API's port or readiness contract.
- **Swagger `/docs`** keeps its current behavior — D7/Q4 confirmed: served in production as
  today. Any future change is an explicitly recorded behavior change with its rationale, not
  a silent production tweak.
- **No new endpoints, no new versioned surface, no OpenAPI edits** — a new production-facing
  endpoint (health, metrics, admin) would be a contract change following ADR-0012 and is out
  of scope (§12).

## 6. Production build and runtime catalog (normative)

Each area (M1–M5) maps to one roadmap checkbox. M1/M2 build images; M3/M4 define what those
images are told; M5 proves the whole thing.

### M1 — Production Dockerfile for API (D1)

- A **multi-stage** build: a builder stage installs dependencies from the lockfile
  (`pnpm install --frozen-lockfile`), runs `prisma generate`, and compiles
  (`nest build`); a runtime stage carries only what the process needs at run time.
- The runtime image contains at minimum: compiled `dist/` (`main.js`, `worker.js` and their
  module graph), the generated Prisma client at its imported relative location
  (`apps/api/generated/prisma` — F5), production-only `node_modules`, and
  `docs/openapi.yaml` (F4) resolvable from the configured `OPENAPI_PATH`/default lookup.
- The runtime image contains **no**: TypeScript sources or compiler, Nest CLI, test suites,
  ESLint, coverage output, `.env*` files, dev/optional dependencies, loadtest or monitoring
  credentials.
- One image, two entrypoints: API (default `node dist/main.js`) and worker
  (`node dist/worker.js`); `PORT` honored (default 3000); `NODE_ENV=production` is the
  documented production setting.
- Hardening per §4 rule 8: pinned Node 22 Debian-slim-family base (F13), non-root user,
  no `:latest`, readable image metadata (what it is, which app/version it carries).
- Healthcheck: the image may declare one, but probe ownership stays with the
  deployment/validation definition (Phase 20 §17 facts: `/health/ready` for the API,
  `/health/live` on 9464 for the worker) — whichever mechanism is chosen must use those
  exact semantics (Phase 2 D9: no schema check — see F16).

### M2 — Production Dockerfile/build strategy for web (D2)

- A production `next build` executed inside the image; the runtime serves the built output
  with production behavior (no dev server, no source tree, no build toolchain).
- D2(a) recommended: Next.js **standalone output** (requires `output: 'standalone'` in
  `apps/web/next.config.ts` — an application-config change this phase must declare, run
  through the required checks, and keep behavior-identical for development).
- **Build-time inputs are documented as build arguments** (non-secret): notably
  `NEXT_PUBLIC_API_BASE_URL`, which is inlined into the client bundle and read by the CSP
  `connect-src` construction (F3) — the documentation must state that changing the API
  origin requires rebuilding the web image, and that the value must match the deployed API.
- `docs/openapi.yaml` is present at build (API reference is generated from it, ADR-0030)
  and remains resolvable at runtime if any route renders it dynamically (F4).
- Hardening per §4 rule 8 (pinned base, non-root, production deps only) and a documented
  port contract (`PORT`, default **3001** to match the dev/docs contract) plus a probe
  usable by a container healthcheck (HTTP 200 on `/` — the web app
  has no health endpoint, and creating one is out of scope, §12).

### M3 — Configuration management

- **One production configuration contract**, documented in one place, covering every
  environment key the three processes consume, classified as *required / optional* and
  *secret / non-secret*, with the production default and the reason for each (this is the
  F7/F9 inventory: `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `PORT`, `LOG_LEVEL`,
  `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS`, `COOKIE_SECURE`/`COOKIE_SAME_SITE`/`WEB_SECURE`,
  `JWT_SECRET`, `WEBHOOK_ENCRYPTION_KEY`, webhook destination lists, rate-limit knobs,
  `METRICS_ENABLED`/`METRICS_PATH`/`METRICS_SCRAPE_TOKEN`/`WORKER_METRICS_PORT`, timing
  knobs — sourced from `apps/api/.env.example` and the Phase 18 §5 / Phase 20 handover
  tables, not re-invented).
- **A committed non-secret production template** (e.g. `docker/production.env.example`)
  listing every key with an empty or placeholder value for secrets and no real value for
  anything — the local `.env.example` pattern, at production scope.
- **No configuration inside images**: the runtime reads the environment only; no image
  layer, entrypoint script, or committed compose file carries a production secret
  (F11/§4 rule 2).
- **Posture documentation, not value invention:** for each Phase 18 §5 fact the document
  states what must be set *in an environment that exists later* (real proxy hops/CIDRs,
  `COOKIE_SECURE=true`, `WEB_SECURE=true`, dashboard CORS origin, deliberate webhook
  destination lists) while Phase 21's own validation environment sets the values it can
  honestly know (Q2/D8).

### M4 — Secrets injection

- **Model:** secrets are injected into the process environment at start time by whatever
  runs the container (developer shell / uncommitted `.env` for the local validation run;
  CI secrets and AWS Secrets Manager for later phases — D4(a); the mapping to Phase 24 is
  recorded as a handover, §17).
- **Never:** image layers, build args, container labels, committed files, command-line
  arguments in logs, or application log output. Generation commands are documented
  (`openssl rand -base64 48` for `JWT_SECRET`, `openssl rand -base64 32` for
  `WEBHOOK_ENCRYPTION_KEY`, ≥ 32 chars for `METRICS_SCRAPE_TOKEN`).
- **Enforcement is the existing boot validation** (F6): the validation procedure includes a
  *negative* run proving the production image refuses to boot without/with weak secrets and
  that the refusal message contains no secret material (docs/security-review.md §6 posture).
- **Cross-process key equality (F8):** the procedure documents and checks that the API and
  the worker receive identical `JWT_SECRET` and `WEBHOOK_ENCRYPTION_KEY` values — a mismatch
  is silent at boot and only visible as failed webhook signatures.

### M5 — Production runtime validation

- **A reproducible procedure from a clean checkout** that: builds both production images,
  provisions throwaway PostgreSQL/Redis, supplies a complete production environment with
  generated secrets, applies migrations **before** the API serves traffic (D3(a)/Q1:
  confirmed pre-start step), starts API + worker + web from the production images, and
  asserts, at minimum:
  1. API `/health/live` and `/health/ready` return 200 with the documented Phase 2 payloads;
  2. API refuses to boot when `JWT_SECRET`/`WEBHOOK_ENCRYPTION_KEY` are missing or weak
     (negative run, §6 M4);
  3. a domain smoke call succeeds **after** migration (F16 — proves schema, not just
     reachability), e.g. an authenticated read through the documented flow;
  4. the worker is running and liveness answers on `WORKER_METRICS_PORT`;
  5. the web app serves the public home page (200) and the API reference page renders from
     the canonical contract;
  6. the metrics exposition is **off** under production defaults, and if enabled for the run
     it answers only with the documented posture (token and/or unpublished port — F9);
  7. neither image contains a secret: verified against image layers/history with a
     documented check (F11);
  8. web/API behavior under the D8 TLS decision (plain-HTTP validation overrides, or a
     terminated-TLS stack — F15).
- **Vehicle per D5(a) recommendation:** a committed production-mode compose file (or
  equivalent committed definition) plus a committed, idempotent script/checklist that cleans
  up after itself; CI wiring is explicitly Phase 23's (§12).
- **Exit evidence:** the procedure's output (what was run, what passed) is recorded in the
  phase record so Phase 22/26 do not re-derive it (§17, AC5/AC10).

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **No schema change.** Migration *execution* exists (`prisma migrate deploy`) and now has a deploy-time owner — D3(a)/Q1: a documented pre-start step run before the API/worker start; the phase does not alter migration content or Prisma schema (ADR-0011). |
| Persistent data | No new persistent product data. Validation uses throwaway databases/volumes that are removed with the run; no production dataset is created or seeded by this phase. |
| Configuration artifacts | One committed non-secret production env template (§6 M3); secrets exist only in the runtime environment of a run and in uncommitted local `.env` files (gitignored — `.gitignore` `.env` rule already covers `docker/.env`). |
| Build artifacts | Images are built from the repository checkout inside the build stage; no host-built `dist/` or `.next/` is copied in (`.dockerignore` already excludes them), so images are reproducible from a clean checkout. |
| Committed files | Dockerfiles, the validation definition/script, the env template, and documentation — all reviewable, all free of secrets, hostnames beyond localhost, PII, or credentials (Phase 17/19/20 artifact rules). |

## 8. Security requirements (for this phase's own work)

1. **Secrets never touch the image** (§4 rule 3). Build args are non-secret by rule; the
   validation run includes a layer/history scan proving no secret-shaped string is present
   (AC7). `.dockerignore` keeps `.env*` out of the context (already true — preserved).
2. **Fail-fast stays on.** Production boot refusals (JWT, webhook encryption key, CORS,
   metrics token strength) are unchanged and demonstrated (§6 M4); weakening a check to make
   an image "just start" is a defect.
3. **Hardened runtime:** non-root user, pinned base, production dependencies only, no dev
   toolchain or test code in the runtime layer; `pnpm audit:deps` (ADR-0036) remains the
   dependency gate for what ships.
4. **Port exposure is minimal and documented:** publish only what the deployment needs (API,
   web); the worker's metrics/liveness port stays unpublished on the network (Phase 20
   posture); the **metrics surface firewall obligation** (ADR-0040/D4: internal-network-only,
   scrape token when enabled) is recorded here as a Phase 21/24 duty and demonstrated by the
   production default `METRICS_ENABLED=false` (F9).
5. **Production posture facts honored:** `COOKIE_SECURE=true` and `WEB_SECURE=true` are the
   production expectations (Phase 18 §5); any relaxation used by the local validation run is
   explicit, documented, and scoped to that run only (D8) — never written back as a default.
6. **Proxy trust:** production configuration documentation restates ADR-0025/Phase 18 §5 —
   `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS` must be set to the real proxy values in any
   environment behind a proxy, and never guessed (values themselves belong to Phases 22/24).
7. **Key equality across processes** (F8): documented and checked — API and worker must share
   `WEBHOOK_ENCRYPTION_KEY`/`JWT_SECRET`; a mismatch is a silent signing failure.
8. **No control bypass:** production images run the same guards, rate limits, request
   logging, redaction, and tenancy as development (§4 rule 5); no `NODE_ENV` shortcut may be
   added to skip a control, and the ADR-0037 register is read, not modified.
9. **Artifact hygiene and security review:** Dockerfiles, the validation definition, the env
   template, and docs are reviewed for leakage before commit; this phase's secrets/deployment
   changes carry the explicit security review AGENTS.md requires for security-sensitive
   changes.

## 9. CI and tooling requirements

- Root scripts and pipeline order stay unchanged: `pnpm lint`, `pnpm lint:openapi`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` (+ `pnpm audit:deps`).
- **No new CI job is required by this phase** — Docker build/verification in the pipeline is
  Phase 23's scope (§12). The validation procedure (§6 M5) must be runnable locally and
  must not depend on CI-only services.
- If a cheap static check exists for the committed artifacts (e.g. compose-file config
  validation, env-template completeness/no-secret test), it belongs to the existing
  test/lint layers rather than a new gate (Phase 20 §9 pattern); heavier Docker-based checks
  are the §6 M5 script's job.
- Production builds must work with pnpm's build-script allowlist (`pnpm-workspace.yaml`
  `allowBuilds`) — approved native builds (argon2, Prisma) succeed in the builder stage,
  blocked ones fail loudly rather than producing a broken runtime (F13).

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — API production image exists and behaves.** The M1 image builds from a clean
   checkout via the documented command, contains the runtime-only payload it specifies (no
   secrets, no dev toolchain, non-root, pinned base, production deps), runs the API by
   default and the worker by command, and passes its probes when given a complete
   environment (§6 M1).
2. **AC2 — Web production strategy delivered.** The M2 build produces a production web
   runtime per D2, with `NEXT_PUBLIC_API_BASE_URL` documented as a build-time input, the
   canonical contract available to the API reference, a documented port/probe contract, and
   a behavior-identical development experience (`pnpm dev` / dev compose unaffected).
3. **AC3 — Configuration management complete.** The documented production configuration
   contract covers every key the processes consume with required/optional and
   secret/non-secret classification, exists as a committed non-secret template, and contains
   no real secret value anywhere (§6 M3).
4. **AC4 — Secrets injection proven.** Secrets reach processes only at runtime; the
   validation run demonstrates boot refusal for missing/weak `JWT_SECRET` and
   `WEBHOOK_ENCRYPTION_KEY` with no secret echoed; cross-process key equality is documented
   and checked (§6 M4).
5. **AC5 — Production runtime validation executed.** The M5 procedure runs end-to-end from
   a clean checkout and all eight assertions hold (probes, refusal, post-migration domain
   smoke, worker liveness, web pages, metrics default-off posture, no secrets in layers,
   D8 TLS posture); its evidence is recorded for Phases 22/26 (§6 M5).
6. **AC6 — Existing contracts intact.** `docs/openapi.yaml` unchanged; health semantics
   unchanged; the full Phase 17 suite and coverage ratchet stay green; `docker compose up`
   (dev), its profiles, and `pnpm loadtest` still work as documented (F10, §4 rule 7).
7. **AC7 — Security posture verified.** Non-root/pinned/production-deps posture as
   specified; layer/history secret scan passes; production defaults honored
   (`METRICS_ENABLED=false`, `COOKIE_SECURE`/`WEB_SECURE` documented); firewall/proxy
   obligations recorded (F7/F9); ADR-0037 register unchanged; no control weakened; the
   phase's security review is attached to its PR (§8).
8. **AC8 — Required checks pass.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:e2e`, `pnpm build`, `pnpm audit:deps` pass from the repository
   root; CI stays green; the coverage ratchet (ADR-0034) holds for touched packages.
9. **AC9 — Traceability.** All five roadmap checkboxes are traced to §1/§6 and satisfied;
   D1–D8 are confirmed and Q1–Q5 answered, recorded in the Status row and §13/§14.
10. **AC10 — Handovers recorded.** §17's inbound discharges (Phase 2 "no production images",
    Phase 18 "secrets injection via Phase 21", Phase 20 D4 firewall obligation) and outbound
    facts (images, config contract, secrets model, migration step, validation procedure) are
    written down so Phases 22/23/24/26 never re-derive them.

## 11. Testing requirements

- **The Phase 17 suite is the regression net** and stays green throughout — unit, e2e,
  browser, contract conformance, coverage thresholds (AC6, AC8).
- **Unit/config tests:** the committed production env template is complete (every
  boot-required key present) and contains no secret values; any parsing/classification logic
  added for the config contract behaves as documented; existing `configuration.spec.ts`
  refusals remain the enforcement evidence for §6 M4.
- **Build tests:** both production images build from a clean checkout with the documented
  command (AC1/AC2); the API runtime image contains the compiled entrypoints, the generated
  Prisma client, and a resolvable `docs/openapi.yaml` (F4/F5 — a missing artifact fails at
  *build or boot*, never silently later).
- **Runtime validation (the M5 script):** the eight assertions of §6 M5 are executable
  checks, not prose — each with a pass/fail result (AC5); negative cases (missing/weak
  secrets, API before migration) are asserted as failures.
- **Non-regression of development:** `docker compose config`/`up` on the existing dev file,
  and the documented `pnpm loadtest` preflight, still succeed after this phase's additions
  (AC6) — cheapest way to prove F10.
- **No new Phase 17 layer:** this phase's checks live in the existing test layers where they
  are code (template/config tests) and in the committed validation script where they need
  Docker; a functional gap discovered there is closed in the normal layers (Phase 20 §11
  pattern).

## 12. Out of scope

- **Registry, image distribution, tagging in CI, image provenance/signing, SBOM/vulnerability
  scanning pipelines** (D6 boundary; Phase 23/24 and ADR-0036's existing audit step).
- **CI/CD pipeline work** — building, caching, and validating images in CI, staging
  auto-deploy, release automation (Phase 23).
- **Staging/production deployment**, database/Redis provisioning, load balancers, reverse
  proxies, TLS certificate acquisition and termination outside the validation stack
  (Phases 22/24; the D8 decision only covers what validation itself needs).
- **Cloud infrastructure and secrets stores** — AWS compute, RDS, ElastiCache, Secrets
  Manager, IAM, CloudWatch (Phase 24); this phase defines the *model* those consume.
- **Kubernetes, multi-region, autoscaling, blue/green or canary mechanics** (master
  specification: out of MVP scope).
- **Application/product behavior changes** — no new endpoints, no readiness/health semantic
  changes (Phase 2 D9, Phase 20 D7), no rate-limit, webhook, payment, or auth changes, no
  `NODE_ENV`-conditional features, no web health endpoint invention.
- **Schema or migration-content changes** (ADR-0011); only execution ownership is decided —
  confirmed as D3(a)/Q1 (pre-start step, not an entrypoint).
- **Monitoring stack deployment for production** — running Prometheus/Grafana against the
  production images is Phase 22/24's decision; this phase only records the exposure
  obligation (F9).
- **Disabling or relocating Swagger/`/docs`** — D7/Q4 confirmed: `/docs` stays as-is, so
  changing it would be a behavior change outside this phase.
- **ROADMAP.md bookkeeping for other phases** (report-only; this phase's checkboxes update
  at merge as a separate `chore/*` change — Phase 16 Q2 / Phase 18 F14 precedent).

## 13. Decisions (D1–D8 — confirmed)

Recommended by the architect on 2026-10-16 and **confirmed by the product authority on
2026-10-16**, together with the answers to Q1–Q5 (§14). Any change to a confirmed row is a
new decision record (Phase 19/20 precedent).

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Dockerfile organization (F1, F10) | **(a) Separate production Dockerfiles (e.g. `docker/api/Dockerfile.prod`, `docker/web/Dockerfile.prod`), leaving the dev Dockerfiles and `docker/compose.yml` untouched.** (b) One multi-stage Dockerfile per app with `dev`/`prod` targets — cleaner long-term but rewrites the Phase 2 dev contract that `pnpm loadtest` and every developer's `docker compose up` depend on; revisit later if duplication hurts. Recommendation: (a) — additive, zero dev risk. | **Confirmed (2026-10-16)** |
| D2 | Web production build strategy (F2, Q5) | **(a) Next.js `output: 'standalone'` + minimal runtime image** — the de-facto standard, smallest correct runtime, no dev toolchain; requires a declared, behavior-checked change to `apps/web/next.config.ts`. (b) Full `next start` runtime with the whole dependency tree — simpler config, ships far more than needed. Recommendation: (a). | **Confirmed (2026-10-16)** — (a), Q5 answered yes |
| D3 | Migration execution ownership (F5, F16, Q1) | **(a) Explicit pre-start migration step:** `prisma migrate deploy` runs as a documented, separate action *before* the API/worker start (validation procedure runs it first; Phases 22/23/24 adopt the same step in their own vehicle). (b) API image entrypoint runs migrations on start — rejected: replica races, the image silently owns schema, boot conflates "schema ready" with "reachable" (readiness cannot tell them apart, F16). Recommendation: (a). | **Confirmed (2026-10-16)** — (a), Q1 answered |
| D4 | Secrets injection mechanism at Phase 21 scope (F6, Phase 18 §5) | **(a) Runtime environment injection by whatever runs the container:** committed non-secret template + documented generation commands; local uncommitted `.env`/shell now, CI secrets in Phase 23, AWS Secrets Manager in Phase 24 (recorded mapping). (b) Docker secrets files in compose — a second mechanism to keep in sync with (a)'s successor. (c) Build-time `ARG` — rejected outright (recoverable from image history, violates §4 rule 3). Recommendation: (a). | **Confirmed (2026-10-16)** |
| D5 | Production runtime validation vehicle (F15, Q2) | **(a) A committed production-mode compose definition + a committed idempotent script/checklist** that builds and runs the images locally against throwaway Postgres/Redis, with recorded output (AC5); CI wiring deferred to Phase 23. (b) Documentation-only ad-hoc `docker run` steps — cheaper, but unverifiable and drifts. (c) Full automated test in the Phase 17 suite — rejected for now: Docker-in-suite cost/ownership belongs to Phase 23's pipeline decision. Recommendation: (a). | **Confirmed (2026-10-16)** — (a), Q2 answered |
| D6 | Image naming, tagging, registry (F12, Q3) | **(a) Local tags only** (`brinnpay/api:<version>` / `:<git-sha>` style, documented), **no registry and no push in this phase** — distribution belongs to Phase 23 (pipeline) and Phase 24 (registry/infra). (b) Push to a registry now — requires choosing a registry, credentials, and retention, i.e. inventing infrastructure no specification assigns to Phase 21. Recommendation: (a). | **Confirmed (2026-10-16)** — (a), Q3 answered |
| D7 | Swagger `/docs` in production (F14, Q4) | **(a) Keep serving it** — the canonical contract is public by design (Phase 15 "public API and integration documentation"), so `/docs` exposes nothing the reference does not; no code change. (b) Disable Swagger outside development — a behavior change that needs the authority's explicit call and, if chosen, a recorded rationale (the public API reference in `apps/web` remains regardless). Recommendation: (a), recorded as an accepted posture. | **Confirmed (2026-10-16)** — (a), Q4 answered |
| D8 | TLS posture of the validation run (F15, Q2) | **(a) Plain-HTTP validation with documented, run-scoped overrides** (`COOKIE_SECURE=false`, `WEB_SECURE=false` for the validation environment only) — keeps certificate/proxy provisioning out of this phase while letting authenticated flows be exercised. (b) Terminate TLS inside the validation stack (self-signed/local proxy) — more faithful to production, more moving parts and artifacts. (c) Skip authenticated flows in validation — rejected: leaves the dashboard unproven in production mode. Recommendation: (a), with the override explicitly scoped and reverted. | **Confirmed (2026-10-16)** — (a), Q2 answered |

## 14. Questions — answered (2026-10-16)

All five questions were answered by the product authority on 2026-10-16; each answer is
recorded here (AC9). The phase may not proceed on any other reading of these rows.

| # | Question | Answer |
| --- | --- | --- |
| Q1 | **Who runs database migrations in a production deployment, and when?** (D3) | **Pre-start one-shot step** — D3(a): `prisma migrate deploy` runs as a documented, separate action before the API/worker start; the validation procedure runs it first. Later phases adopt the same step in their own vehicle. |
| Q2 | **What must "production runtime validation" prove?** (D5, D8) | **Local plain-HTTP proof with run-scoped overrides** — D5(a) + D8(a): the committed production-mode compose definition plus idempotent script proves all eight §6 M5 assertions locally against throwaway dependencies, using `COOKIE_SECURE=false`/`WEB_SECURE=false` scoped to the validation run only. Authenticated dashboard flows are in the validation set. TLS-terminated or staging-level proof is out of scope (Phases 22/24). |
| Q3 | **Is image distribution (registry, tagging scheme, push) part of Phase 21?** (D6) | **No — local tags only** — D6(a): tag locally (`brinnpay/api:<version>-<sha>` style), no registry, no push. Distribution belongs to Phases 23/24. |
| Q4 | **Does Swagger UI (`/docs`) ship in production?** (D7) | **Yes, keep serving it** — D7(a): the canonical contract is public by design; recorded as an accepted posture, no code change. |
| Q5 | **May this phase change `apps/web/next.config.ts` to enable the standalone build?** (D2) | **Yes** — D2(a) confirmed: adding `output: 'standalone'` to `apps/web/next.config.ts` is in scope, subject to the required checks and behavior-identical development experience (AC2). |

## 15. Architectural decisions to record

To be written during implementation as needed (next ADR numbers, `.ai/decisions/`):

- **Production image build strategy** (D1/D2/F13): file organization, multi-stage layout,
  runtime payload, base-image pinning policy, non-root rule, and the web standalone decision
  (including its `next.config.ts` change) — one ADR so Phases 22/23/24 build the same
  images.
- **Runtime configuration and secrets model** (D4, §6 M3/M4): where configuration comes
  from, what may be a build arg, the required-key inventory per process, and the forward
  mapping to Phase 24's secrets store (Phase 18 §5 handover).
- **Migration execution ownership** (D3/Q1): the chosen pre-start step, who runs it in each
  later phase, and why readiness is deliberately not schema-aware (Phase 2 D9 preserved).
- **Production validation procedure** (D5/D8): what the procedure asserts, its TLS posture
  and run-scoped overrides, and where its evidence lives (Phase 22/26 consume it).
- **Swagger/production documentation posture** (D7/Q4): recorded either way so a later phase
  does not re-litigate it.
- Wiring that changes no semantics and no configuration surface needs no ADR (Phase 18
  guard-consolidation precedent).

## 16. Implementation considerations (not requirements)

- **Layer order for cache-friendliness:** copy workspace manifests + lockfile first, install,
  then copy sources — source edits must not reinstall dependencies; keep the builder stage's
  pnpm store inside the stage (no host mounts).
- **Prune deliberately:** `pnpm deploy`-style per-package pruning (or an equivalent
  prod-only install) gives the runtime `node_modules`; remember the generated Prisma client
  lives **outside** `node_modules` (`apps/api/generated/prisma`, F5) and must be copied
  explicitly, along with `docs/openapi.yaml` (F4).
- **Stay on Debian slim** unless there is a reason not to: `argon2`'s native binding and
  glibc-vs-musl surprises (F13) are not worth an alpine switch in the same phase as the
  first production image.
- **Worker = same image, different command:** keep the entrypoint surface to exactly two
  documented commands; do not add an entrypoint shell that runs migrations or supervises
  processes (D3(a) keeps migrations outside).
- **Web standalone specifics:** confirm the standalone output still resolves
  `docs/openapi.yaml` from the working directory the runtime uses (F4), and that
  `NEXT_PUBLIC_API_BASE_URL` is genuinely passed as a build argument (F3 — a runtime-only
  value silently falls back to the localhost default *inside the bundle*).
- **Healthchecks:** copy the Phase 20 probe definitions verbatim (they were recorded for
  exactly this use); do not invent new probe paths or "healthier" semantics (F16).
- **Validation script hygiene:** idempotent, self-cleaning (`down -v`), project-isolated
  (never the dev project name — `pnpm loadtest` uses `-p brinnpay-loadtest`), no secrets
  printed, non-zero exit on any failed assertion, and runnable with only Docker + the repo.
- **Document while the wiring is fresh:** the config contract and validation evidence (§17)
  are deliverables of the phase, not follow-ups.
- **Keep dev untouched as a discipline:** if a change seems to require editing
  `docker/compose.yml` or a dev Dockerfile, stop and re-read D1(a)/§4 rule 7 — that is the
  signal the design has drifted.

## 17. Dependencies and handovers

**Inputs (what this phase consumes):**

- Phase 2 (dev images and compose, health contract, config/env patterns; "no production
  Docker in Phases ≤20" boundary), Phase 3 (`JWT_SECRET` fail-fast), Phase 10/ADR-0018
  (worker process and its required env), Phase 15/ADR-0012/ADR-0030 (canonical contract as
  a runtime/build input), Phase 17 (checks and harness), Phase 18 (§5 deployment-fact
  handover table, ADR-0037 register, ADR-0036 audit), Phase 19 (load harness compatibility;
  no invented absolutes), Phase 20 (probe semantics, metrics port/path/env keys, D4
  firewall obligation, ADR-0040), ADR-0011 (generated Prisma client location), ADR-0025
  (proxy trust), ADR-0028 (HSTS/`WEB_SECURE`), ADR-0034/0035 (coverage/contract gates).

**Discharged by this phase (on implementation):**

- Phase 2 §"No production Docker images or deployment config (Phases 21–24)" — this phase
  ships the images; deployment config for real environments remains Phases 22/24.
- `docker/README.md` "production-specific Docker configuration will be introduced during the
  production and deployment phases" — introduced here, documented in place.
- Phase 18 §5 / docs/security-review.md: "`JWT_SECRET` … injected via secrets management
  (Phase 21)" and "secrets injected via Phase 21" — the **model and local mechanism** ship
  here (D4(a)); the AWS Secrets Manager **implementation** stays Phase 24's (recorded, not
  dropped).
- Phase 20 D4/ADR-0040: "production exposure is an explicit Phase 21/24 firewall
  obligation" — recorded in §8 rule 4 and demonstrated by the production default
  `METRICS_ENABLED=false`; enforcement in deployed networks is Phase 22/24's.
- ROADMAP Phase 21 checkboxes — §1 traceability.

**Blocks / hands forward:**

- Phase 22: the exact images, the config contract (required keys and postures), the
  migration step, and the validation procedure as the staging template; the firewall/proxy
  obligations to apply for real (AC10).
- Phase 23: building these images in CI, tag scheme (if D6 is revised), caching, image
  validation as a pipeline step, CI secrets injection.
- Phase 24: registry/distribution, AWS Secrets Manager mapping of the D4 model, network
  exposure rules (metrics firewall, published ports), read-only root filesystem / task-role
  posture, log/metric ingestion into the same containers.
- Phase 25/26: local-development and architecture documentation may reference the production
  procedure; release QA consumes the AC5 validation evidence and the security review (AC7).

## 18. Definition of done

The phase is complete only when:

1. D1–D8 are confirmed and Q1–Q5 answered — recorded in the Status row and §13/§14 (AC9).
2. All five roadmap checkboxes are satisfied and traced to §10 (API image = AC1; web
   strategy = AC2; configuration management = AC3; secrets injection = AC4; runtime
   validation = AC5), with AC6–AC10 as cross-cutting gates.
3. Every §3 finding (F1–F16) and every inbound handover has a recorded disposition —
   resolved in a decision, shipped in §6, or explicitly re-owned downstream — never dropped
   (§4 rule 10).
4. The images meet §8: non-root, pinned, production-deps-only, secret-free (layer scan
   evidence), fail-fast preserved and demonstrated, security review attached (AC4, AC7).
5. The versioned contract, health semantics, dev compose, and the load harness are untouched
   and green (AC6).
6. Required checks pass from the repository root and CI stays green; the Phase 17 suite
   stays green throughout (AC8).
7. The validation procedure runs from a clean checkout with recorded evidence, and the
   configuration contract, secrets model, and downstream facts are documented where §17 says
   (AC5, AC10).
8. Any ADRs required by §15 are written alongside the implementation.
9. This phase's ROADMAP.md checkboxes are updated at merge time as a separate `chore/*`
   change (Phase 16 Q2 / Phase 18 F14 precedent).
