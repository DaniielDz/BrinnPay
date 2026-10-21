# ADR-0043: Production Image Build Strategy (API and Web)

- **Status:** Accepted
- **Date:** 2026-10-16
- **Phase:** 21
- **Scope:** How Phases 21–24 build the production images: file organization
  (D1), the web standalone decision including its `next.config.ts` change
  (D2/Q5), multi-stage layout, runtime payload, base-image pinning policy,
  non-root rule, and the real compiled entrypoint paths — so Phases 22/23/24
  build the same images instead of re-deriving them.

## Context

Phase 21 opened with no production build at all (F1): every Dockerfile ran a
dev server with bind-mounted sources, and nothing in the repository produced a
runnable production image. Three constraints collided:

1. **The Phase 2 dev contract must survive** (F10, §4 rule 7): `docker
   compose up`, the `worker`/`monitoring` profiles, and `pnpm loadtest` all
   consume `docker/compose.yml` and the dev Dockerfiles verbatim.
2. **The web app had no production build strategy** (F2): no `output:
   'standalone'`, `next start` with the whole dependency tree, and part of its
   configuration (`NEXT_PUBLIC_API_BASE_URL`, the CSP origin) is build-time,
   not runtime (F3).
3. **Both apps depend on `docs/openapi.yaml` at boot/build** (F4): the API
   throws without it; the web API reference is generated from it (ADR-0030).

## Decision

- **D1(a): separate production Dockerfiles** — `docker/api/Dockerfile.prod`
  and `docker/web/Dockerfile.prod`, additive; the dev Dockerfiles and
  `docker/compose.yml` are untouched. A shared multi-stage `dev`/`prod` target
  was rejected for this phase because it rewrites the Phase 2 contract the
  load harness and every developer depend on.
- **D2(a): Next.js `output: 'standalone'`** in `apps/web/next.config.ts`
  (Q5 confirmed in scope), with a production `next build` inside the image and
  a minimal runtime serving only the traced server + static assets. The full
  `next start` runtime was rejected as shipping far more than needed.
- **Multi-stage layout (both images):** a builder stage installs from the
  lockfile (`pnpm install --frozen-lockfile`, manifests first for
  cache-friendliness), runs `prisma generate` (API), and compiles; a separate
  production-dependencies stage runs `pnpm install --frozen-lockfile --prod`
  (API) so the runtime layer never contains tsc/nest/jest/eslint/playwright
  (§8 rule 3). pnpm's `allowBuilds` allowlist approves argon2/Prisma in the
  builder and prod-deps stages; blocked builds fail loudly (F13).
- **Runtime payload (API):** `dist/` (entrypoints + module graph + the Prisma
  client *compiled into* `dist/generated/prisma`), production `node_modules`,
  `apps/api/package.json` (Node module-boundary), and
  `docs/openapi.yaml` at `/app/docs/openapi.yaml` (matching the `OPENAPI_PATH`
  default from `WORKDIR /app/apps/api`). No TypeScript sources, no test
  suites, no dev toolchain, no `.env*` files.
- **Real entrypoint paths:** `nest build` compiles from `apps/api/` because
  the generated Prisma client (`apps/api/generated/prisma`, ADR-0011) is
  imported by relative path, so the compiled entrypoints are
  `dist/src/main.js` and `dist/src/worker.js` (not `dist/main.js`). The image
  `CMD` and the `apps/api` `start`/`start:prod`/`worker` scripts use the real
  paths (the previous `dist/main.js` scripts were broken against the actual
  build output). One image, two entrypoints (ADR-0018): API by default,
  worker by command; no entrypoint script supervises processes or runs
  migrations (D3 — ADR-0045).
- **Runtime payload (web):** the `.next/standalone` tree (monorepo layout:
  `apps/web/server.js`), `.next/static` at `apps/web/.next/static`, and
  `docs/openapi.yaml` at `/app/docs/openapi.yaml` so the contract stays
  resolvable if a route ever renders dynamically (F4).
- **Base-image pinning:** `node:22-bookworm-slim` — same Node major and
  Debian-slim (glibc) family as dev/CI, never `:latest`; argon2's native
  binding builds against the libc it runs on (F13). An alpine switch was
  rejected in the same phase as the first production image (glibc-vs-musl
  risk). Digest-level pinning belongs with the registry work of Phases 23/24
  (D6 boundary).
- **Non-root:** both runtime stages run as the base image's `node` user
  (uid 1000). OCI labels (`title`, `description`, `version`, `source`,
  `license`) carry readable image metadata; `VERSION` is the only build ARG
  besides the documented web inputs, and no ARG is secret-shaped (§4 rule 3).
- **Build-time web inputs (F3):** `NEXT_PUBLIC_API_BASE_URL` is a documented
  non-secret build argument (inlined into the client bundle *and* the CSP
  `connect-src`). Implementation revealed that the standalone server evaluates
  `next.config` headers during `next build`, so **`WEB_SECURE` (HSTS gate,
  ADR-0028) is also a build argument**: unset keeps the secure production
  default (HSTS on under `NODE_ENV=production`); `false` is the D8(a)
  validation-run posture only (ADR-0046). Changing either value for a
  deployed image requires a rebuild; development (`next dev`) is unaffected.
- **Healthchecks:** both images declare one with the deployment-owned
  semantics (API: `/health/ready`; web: HTTP 200 on `/` — inventing a web
  health endpoint is out of scope). The worker's probe is defined by the
  deployment definition on `WORKER_METRICS_PORT` (Phase 20 facts), never by
  the image.

## Consequences

- **Positive:** Phases 22/23/24 build these exact images; the dev contract is
  byte-identical to Phase 20 (F10/AC6); the runtime layers are hardened by
  construction (non-root, pinned, prod-deps-only, secret-free — proven by the
  M5-7 layer scan, ADR-0046).
- **Negative:** two Dockerfiles per app (dev + prod) duplicate the manifest
  copy/install lines; revisit only if duplication hurts (D1 recorded).
  The web's HSTS/API-origin posture silently requiring a rebuild is a
  footgun documented in the config contract (F3 class).
- **Neutral:** no registry, no push, no signing, no SBOM (D6, §12); local
  tags `brinnpay/{api,web}:<version>-<git-sha>` only. Image size has no
  invented budget (Phase 19 "no absolutes" posture) — "optimized" means
  content and behavior per §1.
