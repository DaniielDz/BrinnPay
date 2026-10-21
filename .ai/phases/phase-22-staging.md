# Phase 22 — Staging

| | |
| --- | --- |
| Phase | 22 — Staging |
| Status | **DRAFT (2026-10-21) — decisions D1–D10 pending product-authority confirmation, questions Q1–Q6 unanswered (§13/§14). This specification is NOT ready for implementation: staging may not be built, hosted, exposed, or automated on any other reading of those rows.** |
| Depends on | Phase 1 §5.1 (deployment environments: local / staging / production — staging = "pre-production, mirrors production"), Phase 17 (test harness, required checks), Phase 18 (§5 deployment-fact handover table in `docs/security-review.md`, ADR-0037 accepted-risk register + AR-2 exit criteria, ADR-0025 proxy trust, ADR-0028 HSTS/`WEB_SECURE`), Phase 19 (rule 6 local-only load targeting; ADR-0038 §5 re-baseline obligation; ADR-0039 exit triggers), Phase 20 (probe semantics, metrics port/path/env keys, committed dashboards + alert rules, ADR-0040 exposure firewall obligation, ADR-0041 deferral table naming Phase 22), **Phase 21 (production images, configuration contract, secrets model, migration execution step, validation procedure — ADR-0043, ADR-0044, ADR-0045, ADR-0046, ADR-0047)**, Phase 2 (dev compose/loadtest contracts that must stay untouched) |
| Blocks | Phase 23 (its "Staging auto-deploy" checkbox wires the trigger this phase's D2 defines; CI secrets injection), Phase 24 (production mirrors the staging definition and config posture; substrate/AWS mapping, Secrets Manager, human alert routing, re-baseline if D9(a)), Phase 26 (`Verify staging/production deployment` consumes this phase's evidence) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 22 |
| Branch | `feature/phase-22-staging` (branched from `feature/phase-21-production-docker`) |

## 1. Objective

**Stand up a staging environment that mirrors production and give it an automated,
reproducible deployment path — by reusing Phase 21's images, configuration contract,
secrets model, migration step, and validation procedure, and by deploying them to a real,
persistent, network-reachable environment for the first time.**

Like Phases 17–21 this is an *enabling* phase: it produces deployment artifacts for
infrastructure, not product features. It introduces no new business behavior, no contract
change, and no schema change. Unlike Phase 21 — which proved the images locally against
throwaway dependencies over plain HTTP — this phase creates the first environment that
persists, that is reachable from a network, and that must therefore carry *real* security
posture (TLS, proxy trust, CORS, secrets, access control) instead of run-scoped overrides.

Its ambiguities — which provider hosts staging, what "automated deployment pipeline" means
while Phase 23 owns CI/CD, how images reach the host with no registry, where staging
secrets live, whether staging seeds data, what "mirroring production" actually covers
before production exists (Phase 24), and how staging is exposed — are escalated in §13/§14
rather than assumed. **The phase is DRAFT until those are answered.**

### Roadmap traceability

| Roadmap Phase 22 checkbox | Where |
| --- | --- |
| Staging environment setup | §6 M1, D1/D5/D6/D10, Q1/Q2, AC1 |
| API deployment | §6 M2, D3, AC2 |
| Web application deployment | §6 M3, D3/D6, AC3 |
| Database and Redis configuration | §6 M4, D8, Q6, AC4 |
| Automated deployment pipeline | §6 M5, D2/D3, Q3, AC5 |

The roadmap goal sentence — "Automated staging environment mirroring production" — is
interpreted through §4 rule 3 (parity dimensions) because **production infrastructure does
not exist yet**: Phase 24 (AWS) builds it *after* this phase. Parity in Phase 22 is
therefore parity of *artifacts, configuration contract, process topology, and posture*,
not of hardware or cloud provider; the infra-parity scope questions are escalated (D1,
D5, D6, D7), never silently assumed.

## 2. Scope

In scope:

- **Staging environment setup** (M1): the substrate it runs on (D1), a committed staging
  deployment definition derived from Phase 21's production definition (D10), network
  exposure and transport (D5), origin topology (D6), and a committed runbook.
- **API deployment** (M2): the Phase 21 API image serving the API and the worker process
  from the same image, migrations executed as the confirmed pre-start step (ADR-0045),
  Phase 20 probe semantics in use as the deployment's health gate.
- **Web application deployment** (M3): the Phase 21 web image built with the staging
  build-time inputs (`NEXT_PUBLIC_API_BASE_URL`, `WEB_SECURE`), served behind the same
  transport as the API.
- **Database and Redis configuration** (M4): persistent PostgreSQL and Redis for staging,
  dedicated credentials, deploy-time migration execution, seed posture (D8) and data
  lifetime (Q6); no production data, ever.
- **Automated deployment pipeline** (M5): a committed, idempotent, re-runnable deployment
  artifact that performs the whole sequence (acquire → migrate → start → verify) with one
  documented command and a non-zero exit on failure; the git-triggered wiring itself is
  Phase 23's (D2).
- **Post-deploy verification**: a staging-adapted reuse of Phase 21's validation
  assertions (ADR-0046) so "deployed" means "proven", not "containers started".
- **Documentation and handover**: staging runbook + recorded facts for Phases 23/24/26
  (§17).

Explicitly **not** in scope (§12): cloud/managed infrastructure (AWS compute, RDS,
ElastiCache, Secrets Manager — Phase 24), CI/CD pipeline work and git-triggered auto-deploy
(Phase 23), production deployment (Phase 24), Kubernetes/orchestration/autoscaling,
application or contract changes of any kind, human alert routing (Phase 24), and ROADMAP.md
bookkeeping beyond this phase's own checkboxes (report-only; `chore/*` at merge — Phase 16
Q2 / Phase 18 F14 precedent).

## 3. Context and current-state findings

**What exists today** (Phases 0–21; branch `feature/phase-22-staging` contains Phase 21's
output, commit `21d8833`):

- **Phase 21 shipped the production build and proved it locally:** `docker/api/Dockerfile.prod`,
  `docker/web/Dockerfile.prod`, `docker/compose.production.yml` (project `brinnpay-production`),
  `docker/production.env.example` (configuration contract), `docker/production/validate.mjs`
  (10/10 assertions recorded, ADR-0046), documented in `docker/README.md`.
- **Nothing deploys anywhere.** Phase 21 §12 explicitly deferred staging/production
  deployment, registry/distribution (D6(a): local tags, no push), and CI wiring (Phase 23).
  There is no deploy script, no staging compose file, no remote host reference, no DNS/TLS
  artifact, no secret store, and `.github/workflows/ci.yml` still has no Docker job.
- **Deployment environments were named in Phase 1 §5.1 but only `Local` exists** (Phase 2,
  compose `brinnpay`); `Staging` was assigned to this phase, `Production` to Phase 24.
- **The monitoring stack exists only as a local opt-in profile** (`monitoring/`:
  Prometheus, Alertmanager, Grafana with committed dashboards `api`/`infrastructure`/`worker`,
  four ADR-0039 alert rules, local NDJSON alert sink, Grafana `admin/admin` locally).
- **No seed infrastructure exists**: `apps/api/prisma/` has `schema.prisma` + `migrations`
  only; no seed script, no fixture-data artifact outside the test harness.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | **No non-local environment has ever been provisioned or deployed.** Every roadmap checkbox is open, and "staging" exists only as a row in Phase 1's environment table. | §6 M1, D1, Q1. |
| F2 | **Phase 21's artifacts are the staging substrate and its procedure is the declared template** (ADR-0046: "Phase 22 reuses the procedure as its staging template"). Images, config contract, secrets model, migration step, and assertion set are settled; re-deriving any of them is a defect, not a choice. | §4 rule 2, §6, §17. |
| F3 | **The Phase 21 production definition is validation-shaped, not staging-shaped**: throwaway data (`down -v`, no named volumes), run-scoped `COOKIE_SECURE=false`/`WEB_SECURE=false` defaults, `TRUST_PROXY_HOPS=0`/empty CIDRs (no proxy exists), plain HTTP, local `:local`/`:0.1.0-local` image defaults, isolated project name. Staging needs persistence, production posture, TLS, and a proxy — so it cannot simply *be* `compose.production.yml`. | D10, §6 M1. |
| F4 | **"Mirrors production" collides with roadmap ordering.** Production infrastructure is Phase 24 (AWS). Parity must be defined against what production *is defined to be* today — Phase 21's artifacts, config contract, and posture — or it is undefined. | §4 rule 3, D1/D5/D6/D7. |
| F5 | **The roadmap splits automation across two phases:** Phase 22 owns "Automated deployment pipeline", Phase 23 owns "Staging auto-deploy" (plus full CI/CD). What must be true at the end of Phase 22, and what trigger belongs where, is not stated anywhere. | D2, Q3. |
| F6 | **There is no image distribution path** (F12 of Phase 21, D6(a) confirmed: local tags only, no registry, no push). A remote staging host still has to obtain runnable images. | D3. |
| F7 | **Migrations have a confirmed owner but staging needs its own vehicle.** ADR-0045 fixes the *step* (`prisma migrate deploy` before API/worker start, run from the builder stage) and says "Phases 22/23/24 adopt the same step in their own vehicle". Readiness remains reachability-only (Phase 2 D9), so a deploy that forgets the step gets a green probe and failing traffic. | §6 M2/M4/M5, AC5. |
| F8 | **Every deployment posture fact is specified but set nowhere real.** `docs/security-review.md` §5 requires, at staging/production: real `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS`, `COOKIE_SECURE=true`, `WEB_SECURE=true`, deliberate webhook destination lists, dashboard-origin-only `CORS_ORIGINS`. Phase 21 only *documented* them (M3) and used run-scoped overrides (D8(a)). Staging is the first environment that must set them for real. | §6 M1, §8 rules 4–6. |
| F9 | **The secrets model's staging slot is unassigned.** ADR-0044/D4(a) maps: local uncommitted `.env` (now), CI secrets (Phase 23), AWS Secrets Manager (Phase 24) — a persistent, network-reachable staging environment between "now" and Phase 23/24 has no named home for its secrets. | D4. |
| F10 | **Seeding is undecided and unimplemented.** There is no seed artifact; "database and Redis configuration" does not say whether staging starts empty, gets demo data, or inherits anything. Production data is excluded outright (§8 rule 1). | D8, Q6. |
| F11 | **Observability handovers point at this phase.** Phase 20 §17 hands Phase 22 "probe semantics, dashboard provisioning, alert evaluation on staging"; ADR-0041's deferral table gives Phase 22 "alert evaluation against real staging traffic" and "dashboard-driven alert tuning". The roadmap's five checkboxes contain no monitoring item, so scope vs. obligation is ambiguous. | D7, §17. |
| F12 | **Two recorded performance obligations point here and conflict.** Phase 19 rule 6: "Load tests run against the local stack only. Never against a shared, staging, or production deployment." ADR-0038 §5: "Phases 22/24 re-baseline on deployment-class hardware and become the capacity numbers." Phase 22 cannot satisfy both without an explicit call. | D9. |
| F13 | **AR-2's exit criteria may gate staging.** ADR-0037 AR-2 (SSRF sandbox posture): "IP pinning + resolved-address revalidation **before any non-sandbox deployment** (Phases 22/24 obligation)". Whether a staging deployment of a sandbox product counts as "non-sandbox deployment" is not defined. | Q5, §8 rule 7. |
| F14 | **Monitoring carries credentials and exposure of its own.** Grafana runs `admin/admin` locally, host ports are bound to `127.0.0.1` in dev, and ADR-0040's D4 obligation ("production exposure is an explicit Phase 21/24 firewall act", extended to staging networks) is unenforced anywhere. Local defaults must not travel to staging. | D7, §8 rules 5/9. |
| F15 | **Existing contracts must survive untouched:** the dev compose project (`brinnpay`), `pnpm loadtest` (`brinnpay-loadtest`), and the Phase 21 validation project (`brinnpay-production`) all keep working; staging is strictly additive with its own project name. | §4 rule 7, AC8. |
| F16 | **A web origin is baked at build time.** `NEXT_PUBLIC_API_BASE_URL` and `WEB_SECURE` are build arguments (ADR-0043): the staging web image must be built with the staging API origin and secure posture, and changing either later means rebuilding — not restarting. | §6 M3, §16. |

## 4. Infrastructure rules (normative)

Domain rules do not apply — this phase changes no product behavior. The following
infrastructure rules govern it.

1. **No product behavior changes.** `docs/openapi.yaml` stays byte-identical; routes,
   statuses, error envelopes, auth modes, health semantics (Phase 2 D9), and metrics
   exposition (Phase 20) are untouched. Staging runs *the same application* with different
   environment values — never a staging-only feature flag, route, bypass, or `NODE_ENV`
   conditional.
2. **Phase 21 artifacts are the contract; staging adds wiring, never re-derivation.** Same
   images (ADR-0043), same configuration contract and secrets model (ADR-0044), same
   migration step (ADR-0045), same assertion vocabulary (ADR-0046), same Swagger posture
   (ADR-0047). If staging seems to need a different image, key, or boot behavior, that is a
   defect in the plan — re-read Phase 21, do not fork it.
3. **Parity is defined in dimensions, and unlisted dimensions are escalated.** "Mirrors
   production" means, at minimum: identical images and entrypoints; identical process
   topology (api + worker + web); identical migration step order; identical probe
   semantics; identical configuration contract with the documented production postures
   applied; identical secrets model; identical Swagger/metrics posture; same code ref
   promoted through the same steps. Dimensions that depend on infrastructure that does not
   exist yet — transport/TLS (D5), origin topology (D6), monitoring scope (D7), cloud
   substrate (D1) — are decided in §13, not guessed (Phase 18 rule 2 / Phase 20 rule 2 /
   Phase 21 rule 9 precedent).
4. **Escalation over invention.** Provider, trigger, image transport, secrets storage,
   seeding, exposure, and audience are §13/§14 rows. Implementing around an unanswered row
   is the failure mode this phase exists to avoid.
5. **Smallest correct solution.** A single Docker host running Compose with the Phase 21
   images is sufficient. No Kubernetes, service mesh, orchestration framework, autoscaling,
   blue/green, canary, or load balancer fleet is introduced (master specification and §12).
6. **Staging is disposable by default.** Nothing in staging is a durability guarantee
   unless Q6 says otherwise: data may be wiped by a deploy or on request, and no backup,
   replication, or retention commitment is created implicitly.
7. **Isolation.** Staging runs in its own compose project (name decided at implementation,
   never `brinnpay`, `brinnpay-loadtest`, or `brinnpay-production`), its own PostgreSQL and
   Redis instances, its own credentials, and — per D1 — its own host. No sharing of dev
   volumes, test databases, or local secrets with staging, and no staging data leaving the
   host unredacted.
8. **No production data, ever.** Production datasets are never copied into staging in any
   direction (§8 rule 1); staging data is synthetic or self-generated.
9. **Fail-fast and controls run unchanged.** `NODE_ENV=production`, full boot validation
   (JWT ≥ 32 chars, 32-byte `WEBHOOK_ENCRYPTION_KEY`, non-empty CORS allowlist), guards,
   rate limits, request logging, redaction, and tenancy all active — no test fallback
   (`NODE_ENV=test`, `WEBHOOK_ALLOW_INSECURE_TEST_KEY`) may be reachable in staging
   (`docs/security-review.md` §6: staging demands a real secret).
10. **Handovers are discharged or re-owned, never dropped** (Phase 19 rule 7 / Phase 21
    rule 10): every §17 inbound obligation ends this phase with an explicit disposition.
11. **The phase's own work obeys the checks it reports on:** `pnpm lint`, `pnpm lint:openapi`,
    `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`, `pnpm audit:deps`
    (AGENTS.md); security-sensitive changes (exposure, TLS, secrets, access control) carry
    an explicit security review in their PR.

## 5. Runtime behavior

**No changes to the versioned contract.** Everything in `docs/openapi.yaml` — routes,
statuses, error codes, auth modes, pagination, headers — is untouched in staging and in
every other environment. `/health/live` and `/health/ready` keep Phase 2 semantics and
placement (outside `/api/v1`); metrics keep the Phase 20 classification; Swagger UI keeps
serving at `/docs` exactly as ADR-0047 records (if an operator ever wants it off on
staging, that is an explicit reverse-proxy rule plus a recorded reversal of ADR-0047 —
never a silent behavior change).

What this phase defines, narrowly:

- **Boot behavior under staging configuration** is Phase 21's documented behavior with
  real values: with `NODE_ENV=production` and missing/weak secrets the API and worker
  refuse to start (their refusal messages are the deploy's first diagnostic and never echo
  a value); with a complete environment they start and pass the documented probes.
- **Post-deploy verification semantics:** after every deploy, the environment must answer
  the same *kind* of proof Phase 21's procedure does — probes, a post-migration domain
  smoke call (because readiness cannot detect a missing schema, F7), worker liveness on
  `WORKER_METRICS_PORT`, web home page + API reference from the canonical contract, metrics
  posture, and cross-process key equality — asserted against the staging URL (§6 M5).
- **Observable differences are configuration, not behavior:** which origin the browser
  calls (D6), TLS and proxy headers (D5), and which values are in the environment. No
  endpoint, status, or payload differs between staging and local/production.

## 6. Staging catalog (normative)

Each area (M1–M5) maps to one roadmap checkbox.

### M1 — Staging environment setup (D1, D5, D6, D10; Q1, Q2)

- **Substrate per D1:** a dedicated host reachable over the network, running Docker with
  Compose v2, provisioned per Q1 (facts: what exists, what may be procured, who operates
  it). The host carries a non-root deploy user, key-based access, and a host firewall that
  publishes only what the deployment needs.
- **A committed staging deployment definition (D10)** derived from Phase 21's production
  definition: same services and images, plus the three things validation deliberately
  lacks — **persistent volumes** for PostgreSQL/Redis, **production posture**
  (`COOKIE_SECURE=true`, `WEB_SECURE=true`, real `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS`),
  and the **transport front** (D5). It must fail loudly on an unset required secret using
  the `${VAR:?}` pattern Phase 21 established, and it must never default a secret.
- **Transport per D5:** TLS terminated in front of staging, so the Phase 18 §5 facts are
  set for real for the first time (D8's run-scoped overrides are *not* used here); proxy
  hops/CIDRs are the real values of this deployment (never `0` behind a proxy, never
  `0.0.0.0/0`), per ADR-0025.
- **Origins per D6:** the deployed dashboard origin is the only entry in `CORS_ORIGINS`,
  and the web image is built with that origin as `NEXT_PUBLIC_API_BASE_URL` (F16 — a
  runtime-only value silently falls back to localhost *inside the bundle*).
- **Monitoring per D7:** if (a), the committed `monitoring/` stack (dashboards, alert
  rules, Prometheus) runs against staging with real credentials and internal-only exposure
  (F14); if (b), its disposition is recorded in §17 instead.
- **A committed runbook:** how to bring staging up, how to deploy to it, how to verify it,
  how to rotate its secrets, how to wipe it (Q6), and what to do when a deploy fails.
  Documentation is a deliverable of the phase, not a follow-up.

### M2 — API deployment (D3)

- The **Phase 21 API image** runs the API (`node dist/src/main.js`, port 3000, published
  only as D5/D6 require) and the **worker** from the same image and the same environment
  (ADR-0018), including **identical `JWT_SECRET` and `WEBHOOK_ENCRYPTION_KEY`** (F8-class
  silent failure) — sourced from one variable set so they cannot diverge inside a deploy.
- **Migrations run as the confirmed pre-start step** (ADR-0045): `prisma migrate deploy`
  from the builder stage completes successfully *before* API/worker start, every deploy,
  idempotently; the runtime image never migrates and never contains the Prisma CLI.
- **Probes are the health gate:** API `/health/ready` (dependency reachability only —
  Phase 2 D9 preserved) and worker `/health/live` on `WORKER_METRICS_PORT` (9464,
  **unpublished**, compose-network only) with the Phase 20 semantics, exactly as the
  validation stack uses them.
- **Metrics posture:** `METRICS_ENABLED=false` by default (production default, ADR-0040);
  if enabled for staging, the scrape token is set and the exposition stays off the public
  path (D5's firewall scope).

### M3 — Web application deployment (D3, D6)

- The **Phase 21 web image** (standalone output) built for staging with its non-secret
  build arguments — `NEXT_PUBLIC_API_BASE_URL` = the deployed staging API origin, and
  `WEB_SECURE` unset/true so HSTS and the secure header posture are **on** (the D8(a)
  `false` value belongs to the validation run only, F16).
- Served behind the same transport as the API (D5), port 3001, healthcheck HTTP 200 on
  `/` (the app has no health endpoint; creating one is out of scope).
- The API reference page must render from the canonical `docs/openapi.yaml` on staging —
  the same assertion Phase 21 records as M5-5.

### M4 — Database and Redis configuration (D8; Q6)

- **Persistent PostgreSQL and Redis dedicated to staging**, with data on host volumes that
  survive restarts and deploys; managed services (RDS/ElastiCache) are Phase 24 (§12).
  Neither is published beyond what the application processes need (no public database
  port, no default `brinnpay`/`brinnpay` credentials — staging credentials are secrets,
  §8 rule 2).
- **Migrations execute before traffic on every deploy** (F7, ADR-0045); the deploy artifact
  must fail the deploy — not continue — if the step fails.
- **Seed posture per D8:** empty-and-migrated (recommended) or a committed deterministic
  seed; production data is excluded by rule (§8 rule 1), and no ad-hoc manual data
  restoration from another environment is permitted.
- **Data lifetime per Q6:** stated in the runbook (wipe-on-deploy / periodic / persistent),
  with §4 rule 6 as the default (disposable, no backups) unless decided otherwise.

### M5 — Automated deployment pipeline (D2; Q3)

- **A committed, idempotent deployment artifact** that performs the whole sequence from a
  pinned ref: preflight (host prerequisites) → obtain/build images (D3) → start
  dependencies → **migrate** → start api + worker + web → **post-deploy verification** →
  report. One documented command; re-runnable; non-zero exit on the first failed step;
  never prints a secret; never touches the dev, loadtest, or validation compose projects.
- **Verification is part of "deployed"** (§5): the deploy does not report success until
  the staging-adapted assertion set passes — probes, post-migration domain smoke, worker
  liveness, web home + API reference, metrics posture, key equality.
- **Failure and recovery:** a failed deploy leaves a recorded reason and a re-run against
  the same ref must converge; rolling back means deploying a previous ref (no zero-downtime
  machinery, §4 rule 5).
- **Trigger and ref policy per Q3:** what starts a deploy and which ref reaches staging in
  Phase 22 is explicitly decided; git-triggered wiring, CI secrets, and the full
  "Staging auto-deploy" checkbox are Phase 23's (D2) — this phase ships the *pipeline
  artifact*, Phase 23 wires the *trigger*.

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Schema/migrations | **No schema change.** Migration *execution* is ADR-0045's confirmed pre-start step adopted in this phase's vehicle (deploy-time, builder stage, before start); no migration content or Prisma schema changes (ADR-0011). |
| Persistent data | Staging PostgreSQL/Redis persist on host volumes (§6 M4) — the first environment whose data survives a run. Lifetime and reset policy are Q6 (default: disposable, §4 rule 6). |
| Data provenance | **No production data and no data from any other environment, in any direction** (§8 rule 1). Seed data only if D8(b); otherwise empty-and-migrated. |
| Configuration artifacts | One **committed, non-secret** staging posture record/runbook derived from `docker/production.env.example` (the Phase 21 contract stays the single inventory); secrets live only in the staging host's uncommitted, mode-`0600` environment file outside the repository (D4), plus whatever §13 selects. |
| Build artifacts | Staging images are produced from a pinned repository ref per D3; no host-built `dist/`/`.next/` is copied into an image layer; images remain secret-free (Phase 21 M5-7 posture, §8 rule 3). |
| Committed files | Staging definition, deploy/verify artifacts, runbook, and templates — all reviewable, all free of secrets, real hostnames/credentials until Q1/Q2 answer them, PII, or production data (Phase 17/19/20 artifact rules). |
| Logs and telemetry | Structured JSON stdout (Phase 11/20 channel) is preserved verbatim for Phase 24 ingestion; staging log/metric retention is whatever the host provides — no new logging pipeline is introduced (§12). |

## 8. Security requirements (for this phase's own work)

1. **No production data, ever — in either direction.** Staging is seeded only with
   synthetic/self-generated data (D8); no production dataset is copied in, and no staging
   dataset is promoted out as if it were production. Any data-handling step in the deploy
   artifact is reviewed for leakage (PII, credentials) before commit.
2. **Staging secrets are real, strong, distinct, and stored outside the repository.**
   Generated with Phase 21's documented commands (`openssl rand -base64 48` /
   `-base64 32`), unique to staging (no reuse of local, CI, or production values for
   `JWT_SECRET`/`WEBHOOK_ENCRYPTION_KEY`), delivered only as runtime environment per D4,
   held in a mode-`0600` file outside git (never committed, never in an image, build arg,
   label, or log), and rotated by a documented runbook procedure. Monitoring-stack
   credentials (Grafana `admin/admin` locally) must be replaced with real secrets or kept
   unreachable (F14).
3. **Fail-fast and control parity.** Boot refusals unchanged and exercised in staging
   (§4 rule 9); no test fallback reachable; no guard, rate limit, redaction, tenancy, or
   logging control relaxed for staging; ADR-0037's accepted-risk register is read, not
   modified.
4. **Production posture applied for real (F8):** `COOKIE_SECURE=true`, `WEB_SECURE=true`,
   `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS` = this deployment's real proxy values
   (ADR-0025), `CORS_ORIGINS` = the deployed dashboard origin only, and webhook
   destination allow/deny lists set deliberately rather than left at the permissive
   sandbox default (SSRF interplay: Q5).
5. **Minimal, deliberate exposure.** Publish only what D5/D6 require; the worker's
   metrics/liveness port stays unpublished; metrics exposition stays default-off and, when
   enabled, internal-network-only with the scrape token (ADR-0040/D4 firewall obligation
   enforced here for the first time); database and Redis are never publicly reachable;
   monitoring UIs are internal or authenticated, never open with local defaults.
6. **Access control and audience (Q4).** Whoever may reach staging is decided, not
   inherited: either network-level restriction (allowlist/proxy rule) or the same
   open-registration behavior as production — and if open, staging carries identical
   registration/auth controls with no staging-only bypass. Administrative access to the
   host is key-based, least-privilege, and never shared through the repository.
7. **SSRF/AR-2 disposition before exposure (Q5).** ADR-0037 AR-2's exit criteria ("IP
   pinning + resolved-address revalidation before any non-sandbox deployment") are either
   satisfied for staging or explicitly accepted for staging with a recorded rationale and
   an owner — resolved *before* staging is reachable, never after.
8. **Transport integrity (D5).** Staging is served over TLS with a certificate from the
   decided source (Q2); plain HTTP (Phase 21's D8(a) run-scoped posture) is never the
   staging posture; HSTS ships with the web image built for staging (M3).
9. **Isolation and hygiene (§4 rule 7):** separate compose project/host/credentials; no
   secrets in committed artifacts (layer/history scan posture from Phase 21 still applies
   to the images staging runs); staging container logs and runbook examples contain no
   secret material; secure logging/redaction verified in the deployed environment, not
   assumed.
10. **Security review.** This phase changes exposure, transport, secrets handling, and
    access control — the definition of a security-sensitive change under AGENTS.md; its PR
    carries an explicit security review, and §17's handover dispositions are part of it.

## 9. CI and tooling requirements

- Root scripts and pipeline order stay unchanged: `pnpm lint`, `pnpm lint:openapi`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` (+ `pnpm audit:deps`).
- **No new CI job is required by Phase 22.** `.github/workflows/ci.yml` gains nothing
  from this phase; the deploy artifact must be runnable with the host's Docker + the
  repository (no CI-only services). Git-triggered staging auto-deploy, CI secrets, and
  image builds in CI are Phase 23's (D2, §12).
- Deploy/verify artifacts are code and are treated like Phase 19's harness: linted,
  typechecked, unit-tested where logic exists, code-reviewed, idempotent, non-zero on
  failure, and free of hard-coded secrets or non-local targets (Phase 19 §"scripts are
  maintained like product code").
- **Static checks for committed staging artifacts** (definition validates, no secret in
  the staging template/runbook, required keys present) belong in the existing test/lint
  layers following Phase 21's `production-docker-artifacts.spec.ts` pattern — not in a new
  gate.
- **No load tests against staging** while Phase 19 rule 6 stands (D9).

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch, after
§13/§14 are answered.

1. **AC1 — Staging environment exists and mirrors production per §4 rule 3.** The
   substrate (D1) runs the committed staging definition (D10) with persistent PostgreSQL
   and Redis, TLS-terminated transport (D5) with the production posture facts set for real
   (`COOKIE_SECURE=true`, `WEB_SECURE=true`, real proxy hops/CIDRs, dashboard-origin CORS),
   its own isolated compose project and credentials, and a committed runbook (§6 M1).
2. **AC2 — API deployment proven.** The API and the worker run from the Phase 21 image
   with identical secrets; migrations executed as the pre-start step before traffic on
   every deploy; `/health/live` and `/health/ready` answer with Phase 2 payloads; worker
   liveness answers on `WORKER_METRICS_PORT` with the port unpublished (§6 M2).
3. **AC3 — Web application deployed correctly.** The web image is built with the staging
   build arguments (staging API origin, `WEB_SECURE` on), serves behind the same transport,
   answers HTTP 200 on `/`, and renders the API reference from the canonical contract
   (§6 M3).
4. **AC4 — Database and Redis configured per decision.** Persistent, staging-dedicated
   instances with secret credentials; migrations run pre-deploy and a failed migration
   fails the deploy; seed posture matches D8 and data lifetime matches Q6; **zero
   production data present** (verified by the deploy/verify artifact) (§6 M4).
5. **AC5 — Automated deployment pipeline delivered.** One documented command performs the
   complete sequence (acquire → migrate → start → verify) idempotently from a pinned ref,
   exits non-zero on any failed step, prints no secret, and its post-deploy verification
   passes against staging (§6 M5); the trigger/ref policy matches Q3 and the Phase 22/23
   boundary (D2).
6. **AC6 — Post-deploy verification is executable, not prose.** The staging-adapted
   assertions (probes, post-migration domain smoke, worker liveness, web pages, metrics
   posture, cross-process key equality, no secret in artifacts) run with pass/fail results
   after each deploy (§5, §6 M5).
7. **AC7 — Security posture verified in the deployed environment.** Staging secrets real/
   strong/distinct/outside git; fail-fast refusals still active (negative deploy run
   demonstrated once); posture facts (rule 4) present in the resolved environment; minimal
   port exposure; metrics off or internal+token; access audience per Q4; AR-2 disposition
   per Q5; security review attached to the PR (§8).
8. **AC8 — Existing contracts intact.** `docs/openapi.yaml` unchanged; health and metrics
   semantics unchanged; dev compose, `pnpm loadtest`, and `node docker/production/validate.mjs`
   still work as documented; the full Phase 17 suite and coverage ratchet stay green
   (§4 rule 7, F15).
9. **AC9 — Required checks pass.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:e2e`, `pnpm build`, `pnpm audit:deps` pass from the repository
   root; CI stays green; the coverage ratchet (ADR-0034) holds for touched packages.
10. **AC10 — Traceability and handovers recorded.** All five roadmap checkboxes are traced
    to §1/§6 and satisfied; D1–D10 are confirmed and Q1–Q6 answered and recorded in the
    Status row and §13/§14; every §17 inbound obligation has a disposition and every
    outbound fact is written down for Phases 23/24/26.

## 11. Testing requirements

- **The Phase 17 suite is the regression net** and stays green throughout — unit, e2e,
  browser, contract conformance, coverage thresholds (AC8, AC9).
- **Post-deploy verification (the deploy artifact's verify step)** is the phase's primary
  test: executable assertions with pass/fail results against the running staging
  environment (AC6), reusing Phase 21's assertion vocabulary (ADR-0046) adapted to a
  persistent, TLS-terminated, non-local target.
- **Negative paths are asserted, not assumed:** a deploy with a missing/weak secret is
  refused by boot (Phase 21 M5-2 behavior reproduced once in staging); a deploy with a
  failing migration step exits non-zero and does not start traffic (F7); a re-run after a
  failed deploy converges.
- **Unit/static tests in the existing layers:** staging definition/template completeness
  and no-secret checks (Phase 21 `production-docker-artifacts.spec.ts` pattern); any
  parsing/verification logic in the deploy artifact tested like Phase 19's harness code.
- **Non-regression of existing vehicles:** dev `docker compose up` (+ profiles),
  `pnpm loadtest` preflight, and the Phase 21 validation procedure still succeed after
  this phase's additions (AC8) — the cheapest proof of F15.
- **No new Phase 17 layer.** Checks needing a real host run in the deploy/verify artifact;
  a functional gap discovered there is closed in the normal layers (Phase 20 §11 pattern).
- **No load tests against staging** unless D9(b) is chosen, in which case the run is a
  controlled, documented one-off under §9's rules and Phase 19's harness constraints.

## 12. Out of scope

- **Cloud and managed infrastructure** — AWS compute, RDS, ElastiCache, Secrets Manager,
  IAM, CloudWatch (Phase 24); this phase defines what those must replace (§6, D4).
- **CI/CD pipeline work** — Docker builds in CI, image caching/validation as a pipeline
  step, **git-triggered staging auto-deploy**, CI secrets injection, release automation
  (Phase 23's roadmap checkboxes; D2/Q3 boundary).
- **Registry and image distribution** — push, tag retention, provenance/signing, SBOM
  pipelines (Phase 21 D6(a) boundary; revised only by an explicit new decision — D3).
- **Production deployment** (Phase 24) and any production-grade capacity planning;
  **Kubernetes, orchestration frameworks, autoscaling, blue/green/canary, multi-region**
  (master specification: out of MVP scope).
- **Application/product behavior changes** — no new endpoints, no readiness/health
  semantic changes, no staging feature flags or environment-conditional code, no web
  health endpoint, no rate-limit/webhook/auth changes, no contract or schema changes.
- **Human alert routing** (email/paging/chat, recipients, escalation — ADR-0041 deferral
  table: Phase 24); only evaluation/tuning may occur here if D7(a).
- **Monitoring-stack *product* work** — new dashboards, new rules, log-shipping pipelines
  (Phase 24 for ingestion; existing committed artifacts only, per D7).
- **Performance re-baselining** unless D9(b) is chosen (default disposition: recorded for
  Phase 24 — §17).
- **Backups, replication, and durability guarantees for staging** (§4 rule 6; Q6 may
  change this for staging only).
- **Disabling/relocating Swagger `/docs`** — ADR-0047 stands; reversing it is a recorded
  decision, not a Phase 22 default.
- **ROADMAP.md bookkeeping for other phases** (report-only; this phase's checkboxes update
  at merge as a separate `chore/*` change — Phase 16 Q2 / Phase 18 F14 precedent).

## 13. Decisions required (D1–D10 — pending confirmation)

> **Pending product-authority confirmation (2026-10-21).** The recommendations below
> ([rec]) are the smallest solutions consistent with the roadmap, the master specification,
> and ADR-0043…0047. **Phase 22 is not ready for implementation until D1–D10 are
> confirmed and Q1–Q6 answered.** Confirming a row makes it normative for §6 and AC1–AC10;
> architecture-level outcomes become ADRs (§15).

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | **Staging substrate** — where staging runs, given production (AWS) is Phase 24 (F1, F4, Q1) | **(a) A single dedicated host running Docker Compose with the Phase 21 images — provider-agnostic (any VM/container host the project can obtain), with the AWS mapping recorded as a Phase 24 handover.** (b) Wait for Phase 24 and build staging on AWS — contradicts roadmap ordering (staging precedes production infra) and removes the pre-production rehearsal value. (c) Provision a different cloud now — invents infrastructure no specification assigns and creates a second provider to migrate away from. Recommendation: (a). | **Pending (2026-10-21)** |
| D2 | **Meaning of "Automated deployment pipeline" at Phase 22** — the roadmap splits automation across Phase 22 and Phase 23's "Staging auto-deploy" (F5, Q3) | **(a) Phase 22 ships the committed, idempotent deploy artifact + one documented command (the pipeline); Phase 23 wires the git/CI trigger and secrets — each roadmap checkbox is discharged by its own phase.** (b) Full git-triggered auto-deploy in Phase 22 — duplicates Phase 23's checkbox and requires CI work this phase explicitly excludes. (c) Manual click-ops only — contradicts the roadmap's "Automated" wording. Recommendation: (a). | **Pending (2026-10-21)** |
| D3 | **How images reach the staging host** — no registry or push exists (Phase 21 D6(a), F6) | **(a) Build on the staging host from a pinned git ref** (host needs Docker + the checkout; the multi-stage build needs nothing else) — no transport, no registry, one source of truth = the ref; maps 1:1 onto Phase 23 replacing "checkout" with a CI-built image. (b) Build locally and ship images via `docker save`/`docker load` — no registry, but adds an artifact upload channel and a second place where image provenance can drift. (c) Push to a registry now — revises the confirmed Phase 21 D6 boundary and invents registry choice/credentials/retention. Recommendation: (a), with (b) acceptable if the host cannot hold a checkout. | **Pending (2026-10-21)** |
| D4 | **Staging secrets storage** — ADR-0044's model has no staging slot (F9) | **(a) Host-local, mode-`0600`, uncommitted environment file outside the repository** — exactly Phase 21 D4(a) ("secrets injected at runtime by whatever runs the container"); smallest, no new mechanism, and each later phase replaces it (CI secrets → Phase 23, Secrets Manager → Phase 24). (b) CI secret store now — Phase 23's mechanism, premature while the trigger is manual. (c) A cloud secrets store now — Phase 24's scope with a chosen provider. Recommendation: (a). | **Pending (2026-10-21)** |
| D5 | **Transport and proxy posture of staging** — Phase 21 deferred "TLS-terminated proof" to Phases 22/24 and Phase 18 §5 facts are unset anywhere real (F8) | **(a) TLS terminated in front of staging by a reverse proxy on the host, with `COOKIE_SECURE=true`, `WEB_SECURE=true`, and real `TRUST_PROXY_HOPS`/`TRUST_PROXY_CIDRS`** — discharges the Phase 21 handover, first production-faithful transport, lets HSTS ship as designed. (b) Plain HTTP staging — leaves the handover undischarged and never proves the posture the goal sentence requires. Recommendation: (a). | **Pending (2026-10-21)** |
| D6 | **Origin topology** — one hostname or two, given CORS and a build-time API origin (F16, Q2) | **(a) Two origins: dashboard on one hostname, API on another** (e.g. `app.` + `api.`), matching the dev contract (`:3001`/`:3000`), the `CORS_ORIGINS` model, and `NEXT_PUBLIC_API_BASE_URL` as an absolute origin; both behind the same proxy/TLS. (b) Single origin with path-based routing to `/api/v1` — one certificate, but introduces proxy path routing the config contract does not model and makes CORS semantics ambiguous. Recommendation: (a). | **Pending (2026-10-21)** |
| D7 | **Monitoring scope in staging** — Phase 20/ADR-0041 hand Phase 22 "dashboard provisioning, alert evaluation on staging", but the roadmap has no monitoring checkbox (F11, F14) | **(a) Deploy the committed `monitoring/` stack to staging and evaluate the four alert rules against real staging traffic**, recording threshold tuning as evidence (discharges ADR-0041's deferral with artifacts that already exist — no new monitoring code). (b) Defer all monitoring to Phase 24 with a recorded re-own disposition (leaves the Phase 20 handover open). Recommendation: (a) — it reuses committed artifacts and closes an existing obligation, but it *is* scope beyond the five checkboxes, so the authority must call it. | **Pending (2026-10-21)** |
| D8 | **Staging data/seed posture** — no seed infrastructure exists (F10) | **(a) Empty database + migrations only**: testers register and create their own data — nothing to maintain, no invented product copy, and the post-deploy domain smoke already proves the schema. (b) A committed deterministic seed script (demo orgs/projects/payments) — better first-run experience but a new maintained artifact with product-copy decisions it does not have. Production data is excluded under all options (§8 rule 1). Recommendation: (a). | **Pending (2026-10-21)** |
| D9 | **Performance re-baseline disposition** — Phase 19 rule 6 forbids load tests against staging while ADR-0038 §5 assigns re-baselining to "Phases 22/24" (F12) | **(a) Re-own the Phase 22 half to Phase 24** (production hardware) with the disposition recorded in §17 — preserves Phase 19 rule 6 unchanged and keeps one honest capacity environment. (b) Re-baseline on staging now — amends Phase 19 rule 6 for a controlled, documented run and makes staging the capacity reference until Phase 24 supersedes it. Recommendation: (a), because staging's substrate (D1/Q1) is not yet known to be deployment-class. | **Pending (2026-10-21)** |
| D10 | **Staging deployment definition** — the Phase 21 file is validation-shaped (F3) | **(a) A separate committed staging definition derived from `docker/compose.production.yml`**, adding persistence, production posture, and the transport front — additive, keeps the confirmed Phase 21 validation procedure byte-stable (D8(a) plain HTTP), and becomes the template Phase 24 adapts. (b) Parameterize `compose.production.yml` to serve both validation and staging — fewer files, but forces throwaway and persistent postures, and plain-HTTP and TLS postures, through one shape the confirmed procedure did not ask for. (c) Hand-maintained staging config with no committed definition — unverifiable and drifts (Phase 21 D5(b) rejection). Recommendation: (a). | **Pending (2026-10-21)** |

## 14. Open questions (Q1–Q6 — unanswered)

> **Pending product-authority answers (2026-10-21).** These are facts and calls the
> architect cannot frame without the authority; §6 and AC1–AC5 cannot be finalized until
> they are answered. Answers are recorded here (AC10).

| # | Question | Why it blocks | Status |
| --- | --- | --- | --- |
| Q1 | **What staging infrastructure exists or may be procured?** Is there a host/VM or cloud account available, is there a budget and an operator for it, and what are its constraints (region, firewall control, Docker availability)? | D1 cannot be confirmed and §6 M1 cannot be written without knowing what "a dedicated host" means in practice. | **Open (2026-10-21)** |
| Q2 | **Which hostname(s) will staging use, does the project control a domain, and where do certificates come from?** (public DNS name(s) vs IP-only; CA/Let's Encrypt vs self-managed) | D5/D6 transport and origin topology, CORS values, `NEXT_PUBLIC_API_BASE_URL`, and certificate automation all depend on this. | **Open (2026-10-21)** |
| Q3 | **What triggers a staging deploy, and which ref reaches staging?** e.g. a manual command against an explicit ref (Phase 22) vs automatic deploy of `develop` on merge (Phase 23), and how often. | D2's Phase 22/23 boundary and AC5's verification of "the trigger/ref policy" cannot be stated without it. | **Open (2026-10-21)** |
| Q4 | **Who may reach staging?** Open registration exactly as production (anyone with the URL can sign up) or network-restricted access (team allowlist / proxy rule)? | §8 rule 6 and AC7; also determines whether staging is a public surface at all. | **Open (2026-10-21)** |
| Q5 | **Does staging count as a "non-sandbox deployment" for ADR-0037 AR-2?** I.e. must IP pinning + resolved-address revalidation ship *before* staging is exposed, or is staging explicitly accepted with a recorded rationale and Phase 24 as the exit-criteria owner? | §8 rule 7; a publicly reachable staging environment may inherit the permissive SSRF posture (AR-2) — this must be called before exposure, not after. | **Open (2026-10-21)** |
| Q6 | **What is staging's data lifetime?** Wiped on every deploy, wiped periodically, or persistent indefinitely — and are any retention/backup expectations attached to it? | §6 M4/AC4 and §4 rule 6 (disposable default); the runbook must state it. | **Open (2026-10-21)** |

## 15. Architectural decisions to record

To be written during implementation as needed (next ADR numbers, `.ai/decisions/`):

- **Staging environment and deployment model** (D1/D10, §6 M1): substrate, the staging
  definition and how it derives from the Phase 21 production definition, parity dimensions
  (§4 rule 3), and the isolated project/network conventions — so Phase 24 builds production
  from the same shape.
- **Deployment automation and trigger boundary** (D2/D3/Q3, §6 M5): what the Phase 22
  pipeline artifact does, what Phase 23 wires, how images are obtained without a registry,
  and the failure/rollback semantics.
- **Staging transport, origins, and posture** (D5/D6/Q2): TLS/proxy topology, hostname and
  CORS model, and the real values of the Phase 18 §5 posture facts as first applied.
- **Staging secrets and data posture** (D4/D8/Q6): where secrets live and their rotation,
  seed/lifetime rules, and the no-production-data guarantee as an executed check.
- Observability-in-staging (D7) and the re-baseline disposition (D9) are recorded wherever
  §17 places them (ADR note or handover table) so neither obligation is dropped.
- Wiring that changes no semantics and no configuration surface needs no ADR (Phase 18
  guard-consolidation precedent).

## 16. Implementation considerations (not requirements)

- **Derive, don't rewrite:** start from `docker/compose.production.yml` +
  `production.env.example` + the Phase 21 assertion set; every divergence must be one of
  the three §6 M1 additions (persistence, posture, transport) or it is drift (F3, D10).
- **Reuse the verification vocabulary:** adapting `docker/production/validate.mjs`
  assertions to a remote, TLS, persistent target is cheaper and less drift-prone than a
  new checker; keep pass/fail granularity and the "no secret ever printed" hygiene
  (ADR-0046).
- **Migration step ordering is the classic failure:** readiness cannot detect a missing
  schema (F7), so the deploy must sequence migrate → start → smoke and fail loudly if any
  step fails; make the ordering visible in the runbook, not only in the script.
- **Web build arguments are a rebuild, not a restart** (F16): the deploy must rebuild the
  web image when the staging API origin or HSTS posture changes, and the runbook should say
  so explicitly.
- **Posture values are environment facts, not defaults:** proxy hops/CIDRs and CORS origins
  come from Q1/Q2/D6; never commit real hostnames before those answers exist, and never
  leave a secure-posture key at a permissive value "for now" (§8 rule 4).
- **Compose project naming discipline:** staging must never collide with `brinnpay`,
  `brinnpay-loadtest`, or `brinnpay-production` (F15) — one `docker compose ps` on the
  host should show exactly one environment.
- **Keep secrets out of the command line:** pass them through the env file, not `docker
  run -e` on a shared shell history; the deploy artifact should refuse to run if a secret
  would be echoed.
- **Documentation while the wiring is fresh:** the runbook and §17 dispositions are
  deliverables of the phase (AC1, AC10), not follow-ups.
- **If a change seems to require editing an application source file, stop** — re-read
  §4 rule 1/2: this phase deploys what exists; a needed application change is a finding to
  escalate, not to patch here.

## 17. Dependencies and handovers

**Inputs (what this phase consumes):**

- **Phase 1** §5.1 (deployment environment definitions — staging = pre-production that
  mirrors production), **Phase 2** (compose/health/config patterns; dev and loadtest
  contracts preserved), **Phase 17** (checks and harness), **Phase 18** (§5 deployment-fact
  table in `docs/security-review.md`, ADR-0025 proxy trust, ADR-0028 HSTS/`WEB_SECURE`,
  ADR-0036 dependency audit, ADR-0037 register incl. AR-2), **Phase 19** (rule 6
  local-only load targeting, ADR-0038 §5 re-baseline obligation, ADR-0039 exit triggers),
  **Phase 20** (probe semantics, metrics port/path/env keys, committed dashboards and alert
  rules, ADR-0040 firewall obligation, ADR-0041 deferral table naming Phase 22),
  **Phase 21 + ADR-0043/0044/0045/0046/0047** (images, config contract, secrets model,
  migration step, validation procedure, Swagger posture).

**Discharged by this phase (on implementation) — or explicitly re-owned:**

| Inbound obligation | Disposition in this phase |
| --- | --- |
| Phase 1 §5.1 "Staging — pre-production, mirrors production" | §4 rule 3 parity dimensions; AC1. |
| Phase 18 §5 / `docs/security-review.md` §5 ("required at staging/production") | Set for real for the first time — §6 M1, §8 rule 4; values sourced from Q1/Q2/D6. |
| ADR-0037 AR-2 exit criteria ("before any non-sandbox deployment") | **Q5** — resolved before exposure; §8 rule 7. |
| Phase 19 §12 / ADR-0038 §5 re-baseline obligation | **D9** — recommended re-own to Phase 24; recorded here either way. |
| Phase 20 §17 "probe semantics, dashboard provisioning, alert evaluation on staging" | **D7** (recommended: monitoring ships to staging); otherwise re-owned to Phase 24. |
| Phase 20 D4 / ADR-0040 metrics firewall obligation ("Phase 21/24", staging networks included) | Enforced in the staging network — §8 rule 5. |
| ADR-0041 deferral table (alert evaluation + dashboard tuning on staging) | **D7** disposition; human routing stays Phase 24. |
| Phase 21 §17 "TLS-terminated proof belongs to Phases 22/24" | **D5** — staging is that proof; §6 M1, AC7. |
| ADR-0045 "Phases 22/23/24 adopt the same step in their own vehicle" | Adopted as the deploy-time pre-start step — §6 M2/M5, AC5. |
| Phase 21 D6(a)/ADR-0044 staging slots (registry; secrets storage) | **D3** (image acquisition) and **D4** (secrets storage). |
| ROADMAP Phase 22 checkboxes | §1 traceability. |

**Blocks / hands forward:**

- **Phase 23:** the D2 trigger/ref boundary, the deploy artifact to wire into CI, staging
  secrets to move into CI secrets, and (if D3 is revised) any registry decision.
- **Phase 24:** the substrate→AWS mapping (compute, RDS, ElastiCache, Secrets Manager
  replacing D4, IAM, CloudWatch consuming the unchanged stdout JSON channel), the staging
  definition as the template for production, human alert routing (ADR-0041), and the
  re-baseline run if D9(a).
- **Phase 26:** `Verify staging/production deployment` consumes this phase's runbook,
  verification evidence, and security review (AC5/AC7/AC10).

## 18. Definition of done

The phase is complete only when:

1. D1–D10 are confirmed and Q1–Q6 answered — recorded in the Status row and §13/§14; the
   Status is then updated from DRAFT to confirmed (AC10).
2. All five roadmap checkboxes are satisfied and traced to §10 (environment setup = AC1;
   API deployment = AC2; web deployment = AC3; database/Redis = AC4; automated pipeline =
   AC5), with AC6–AC10 as cross-cutting gates.
3. Every §3 finding (F1–F16) and every §17 inbound obligation has a recorded disposition —
   resolved in a decision, shipped in §6, or explicitly re-owned downstream — never dropped
   (§4 rule 10).
4. Staging runs the Phase 21 images with the production posture applied for real: TLS,
   proxy trust, cookie/HSTS posture, dashboard-only CORS, distinct strong secrets outside
   git, minimal exposure, fail-fast intact — with the security review attached (AC7).
5. The deploy is automated, idempotent, verified, and reproducible: one command, pinned
   ref, migrate-before-start, non-zero on failure, post-deploy assertions passing (AC5,
   AC6).
6. The versioned contract, health/metrics semantics, dev compose, load harness, and Phase
   21 validation procedure are untouched and green (AC8).
7. Required checks pass from the repository root and CI stays green; the Phase 17 suite
   stays green throughout (AC9).
8. The runbook, staging posture record, and §17 dispositions are documented where §6/§17
   say (AC1, AC10); any ADRs required by §15 are written alongside the implementation.
9. This phase's ROADMAP.md checkboxes are updated at merge time as a separate `chore/*`
   change (Phase 16 Q2 / Phase 18 F14 precedent).
