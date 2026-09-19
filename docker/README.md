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

## Secrets

No secrets are committed in this directory. Credential defaults are
non-secret development values; production credentials belong in the production
and deployment phases (Phases 20–24).

## Later phases

Production-specific Docker configuration will be introduced during the production and deployment phases.

The project should avoid maintaining Docker infrastructure that is not yet required by the current phase.