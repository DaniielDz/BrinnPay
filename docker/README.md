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

## Secrets

No secrets are committed in this directory. Credential defaults are
non-secret development values; production credentials belong in the production
and deployment phases (Phases 20–24).

## Later phases

Production-specific Docker configuration will be introduced during the production and deployment phases.

The project should avoid maintaining Docker infrastructure that is not yet required by the current phase.