# BrinnPay Docker

Docker configuration for local development and production deployment.

## Local development (Phase 2)

The Phase 2 local stack is defined in [`compose.yml`](compose.yml):

```text
docker/
├── compose.yml
├── api/
│   └── Dockerfile
└── web/
    └── Dockerfile
```

Services:

| Service    | Purpose                                     | Port (default)   |
| ---------- | ------------------------------------------- | ---------------- |
| PostgreSQL | Primary database (name/user/port, see below) | 5432             |
| Redis      | Cache/queue infrastructure (BullMQ later)   | 6379             |
| API        | `apps/api` NestJS dev server (`--watch`)    | 3000             |
| Web        | `apps/web` Next.js dev server               | 3001             |

Ports are overridable via `API_PORT`, `WEB_PORT`, `POSTGRES_PORT`, and
`REDIS_PORT`.

## Local-service defaults (D7)

| Setting              | Default                                |
| -------------------- | -------------------------------------- |
| API port             | `3000`                                 |
| Web port             | `3001`                                 |
| PostgreSQL database  | `brinnpay`                             |
| PostgreSQL user      | `brinnpay`                             |
| PostgreSQL password  | `brinnpay` (development only)          |

The API connects to PostgreSQL/Redis through the compose network hostnames
(`postgres`, `redis`); see the `DATABASE_URL` and `REDIS_URL` values in
`compose.yml`.

## Usage

```sh
cp .env.example .env   # optional: adjust ports/credentials from defaults
docker compose up --build
```

- The API container healthcheck uses `GET /health/ready`; container state is
  visible via `docker compose ps`.
- Data persists in the named volumes `postgres-data` and `redis-data`.
- Source directories are mounted into the API and web containers for hot
  reload in development.
- Hot reload covers source only: `node_modules` lives in the image layer.
  After adding or upgrading a dependency, rebuild the affected services or
  the container keeps the old packages:

  ```sh
  docker compose build api worker
  ```

### Webhook worker (opt-in profile)

The phase-10 webhook worker (delivery attempts, retries, reconciliation,
payment-advancement sweeps) runs **only when its compose profile is
enabled**:

```sh
docker compose --profile worker up -d        # start (with the rest) or
docker compose --profile worker up -d worker # start just the worker
```

It is profile-gated because the e2e suite manages its own workers in-process
and asserts untouched queue state; a long-running worker on the shared
Redis would steal queued deliveries and fail those tests. The phase-19
load-test runner uses a separate compose project and always enables the
profile (its scenarios measure sweep- and worker-driven behavior).

### Metrics (Phase 20)

Both application services receive the observability environment (defaults
apply when unset, so plain `docker compose up` is unchanged):

| Variable              | Default    | Purpose                                                  |
| --------------------- | ---------- | -------------------------------------------------------- |
| `METRICS_ENABLED`     | `true`     | Serves the exposition endpoint on the API and the worker |
| `METRICS_PATH`        | `/metrics` | Exposition path (must stay outside `/api/v1`)            |
| `METRICS_SCRAPE_TOKEN`| *(unset)*  | Optional bearer token required on each scrape            |
| `WORKER_METRICS_PORT` | `9464`     | Worker's own metrics/liveness listener port              |

The worker's metrics port is intentionally **not published** to the host:
Prometheus scrapes it over the compose network, and the worker healthcheck
probes `/health/live` on the same port — which keeps working even with
`METRICS_ENABLED=false` (D7(a)).

### Monitoring stack (opt-in profile)

Prometheus, Alertmanager, Grafana, the exporters, and a local alert sink run
only under the `monitoring` profile:

```sh
docker compose --profile monitoring --profile worker up -d
```

| Service          | Purpose                                        | Port (default)  |
| ---------------- | ---------------------------------------------- | --------------- |
| Prometheus       | Scrapes API, worker, postgres/redis exporters  | 9090            |
| Alertmanager     | Routes the four phase-20 alert rules           | 9093            |
| Grafana          | Provisioned dashboards (admin/admin locally)   | 3002            |
| alert-receiver   | Local sink logging alerts as NDJSON (internal) | 8080 (internal) |
| redis-exporter   | Redis metrics for Prometheus (internal)        | 9121 (internal) |
| postgres-exporter | Postgres metrics for Prometheus (internal)     | 9187 (internal) |

Host-published ports are bound to `127.0.0.1`. Prometheus reads
[`monitoring/prometheus/prometheus.yml`](../monitoring/prometheus/prometheus.yml)
and [`monitoring/prometheus/alerts.yml`](../monitoring/prometheus/alerts.yml)
from the repository (reloads follow a container restart). Prometheus itself
does **not** expand environment variables in its config, so the optional
`METRICS_SCRAPE_TOKEN` reaches it through a container-local credentials file
that the compose entrypoint writes at container start — setting the token in
the environment therefore secures the scrape path end to end with nothing
committed to the repository.
See [`monitoring/README.md`](../monitoring/README.md) for the runbook, alert
descriptions, and troubleshooting.

## Production images and validation (Phase 21)

Phase 21 adds the first production build, **additively** — the development
stack above (`compose.yml`, `api/Dockerfile`, `web/Dockerfile`) is unchanged:

```text
docker/
├── compose.yml                  # development (Phase 2, untouched)
├── compose.production.yml       # production-mode validation stack
├── api/Dockerfile               # development
├── api/Dockerfile.prod          # production (multi-stage)
├── web/Dockerfile               # development
├── web/Dockerfile.prod          # production (multi-stage, standalone)
├── production.env.example       # production configuration contract (no secrets)
└── production/validate.mjs      # committed, idempotent validation script
```

### Image build strategy

- **API/worker — one image, two entrypoints** (`docker/api/Dockerfile.prod`,
  ADR-0043): builder stage installs from the lockfile, runs `prisma
  generate`, and compiles; the runtime stage carries `dist/` (entrypoints
  `dist/src/main.js` and `dist/src/worker.js`), production `node_modules`,
  and `docs/openapi.yaml` — no TypeScript sources, no dev toolchain
  (`tsc`/`nest`/`jest`/`eslint`), no secrets. Non-root (`node`, uid 1000),
  pinned `node:22-bookworm-slim`, `NODE_ENV=production`.

  ```sh
  docker build -f docker/api/Dockerfile.prod -t brinnpay/api:local .
  docker run --rm brinnpay/api:local                       # API (default)
  docker run --rm brinnpay/api:local node dist/src/worker.js  # worker
  ```

- **Web — standalone output** (`docker/web/Dockerfile.prod`, D2(a)/Q5):
  production `next build` inside the image; the runtime serves only the
  traced standalone server + static assets, non-root, pinned base, port
  **3001**. **Build-time (non-secret) arguments** — changing either requires
  a rebuild (the standalone server evaluates `next.config` headers at build):
  - `NEXT_PUBLIC_API_BASE_URL` — inlined into the client bundle and the CSP
    `connect-src` origin; must match the deployed API (F3);
  - `WEB_SECURE` — HSTS gate (ADR-0028): unset keeps the secure production
    default (HSTS on); `false` is the run-scoped plain-HTTP posture of the
    validation run only (D8(a)).

### Configuration and secrets

`production.env.example` is the committed, non-secret **configuration
contract**: every environment key the three processes consume, classified
required/optional and secret/non-secret, with production defaults and
rationale. **Secrets are injected at runtime** by whatever runs the
container (D4(a)) — never as build args, layers, labels, or committed
files. API and worker must receive **identical** `JWT_SECRET` and
`WEBHOOK_ENCRYPTION_KEY` (F8; validated by the script). Boot refuses to
start on missing/weak secrets — that refusal is preserved and proven by the
validation run (§6 M4). See `.ai/decisions/adr-0044-runtime-configuration-and-secrets-model.md`.

### Migrations

`prisma migrate deploy` is an explicit **pre-start step** (D3(a)/Q1,
ADR-0045): run it before the API/worker start. The production compose file
models it as a one-shot `migrate` service (builder stage — the runtime image
contains no Prisma CLI); `api`/`worker` depend on it completing
successfully. Never migrate from an entrypoint: readiness is
reachability-only (Phase 2 D9) and cannot tell a missing schema from a
healthy database.

### Running the validation (AC5)

Requires only Docker (with Compose v2) and this repository, from a clean
checkout:

```sh
node docker/production/validate.mjs
```

The script is idempotent and self-cleaning; it uses the isolated compose
project `brinnpay-production` (never the dev project), generates per-run
secrets into a `0600` temp env file it deletes on exit (**no secret is ever
printed**), and always tears down (`down -v`) — including on failure. It:

1. builds both images with local tags `brinnpay/{api,web}:<version>-<sha>`
   (no registry, no push — D6(a));
2. proves the API **refuses** to boot without/with weak secrets (M5-2);
3. proves the pre-migration gap (ready but failing domain — F16);
4. applies migrations (pre-start step), then starts API + worker + web;
5. asserts: documented probe payloads (M5-1), post-migration domain smoke
   with registration + authenticated read (M5-3), worker liveness on
   `WORKER_METRICS_PORT` 9464 (M5-4), web home page + API reference from the
   canonical contract (M5-5), metrics **off by default** and token posture
   when enabled (M5-6/6b), no secret/.env/toolchain in image layers or
   filesystem (M5-7), plain-HTTP D8 posture (M5-8), and cross-process key
   equality (M5-9);
6. exits non-zero on the first failure with teardown.

**TLS posture (D8(a)):** local plain HTTP with run-scoped
`COOKIE_SECURE=false` / `WEB_SECURE=false` — so authenticated flows can be
exercised for the right reason. The overrides live only in the generated
per-run env file; production expectations remain `true` (recorded in
`production.env.example`). TLS-terminated proof belongs to Phases 22/24.

**Recorded evidence (AC5, 2026-10-16):** full run from a clean checkout on
Docker 29.8.1/Compose v5.5.1, tags `brinnpay/api:0.1.0-548ba03` +
`brinnpay/web:0.1.0-548ba03` — **10/10 checks passed** (M5-1 … M5-9 incl.
the M5-6b/M5-7 extensions), stack torn down, no secrets printed. Details and
rationale: `.ai/decisions/adr-0046-production-validation-procedure.md`.

Swagger UI (`/docs`) ships in production unchanged (D7(a)/Q4, ADR-0047).

## Secrets

No secrets are committed in this directory. Credential defaults are
non-secret development values; the production secrets model (runtime
injection, generation commands, per-process required keys) is documented in
[`production.env.example`](production.env.example) and ADR-0044 — real
production credentials belong to the deployment phases (Phases 22–24).

## Later phases

Distribution (registry, push), CI wiring, and real-environment deployment
remain Phases 22–24's scope; this directory adds no Docker infrastructure
beyond what Phase 21 requires.