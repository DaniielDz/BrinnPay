# BrinnPay Docker

Docker configuration for local development and production deployment.

## Planned structure

Docker-related infrastructure will be introduced progressively.

### Phase 2 — Foundation

Expected local development configuration:

```text
docker/
├── compose.yml
├── api/
│   └── Dockerfile
└── web/
    └── Dockerfile
```

Expected local services:

- PostgreSQL
- Redis
- API
- Web

### Later phases

Production-specific Docker configuration will be introduced during the production and deployment phases.

The project should avoid maintaining Docker infrastructure that is not yet required by the current phase.
