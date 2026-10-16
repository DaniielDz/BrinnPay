# BrinnPay Monitoring (Phase 20)

Local observability stack for BrinnPay: Prometheus scrapes the API and webhook
worker, Grafana renders committed dashboards, Alertmanager forwards alerts to
a local receiver that prints them to its container log. Everything is behind
the opt-in `monitoring` compose profile — the default `docker compose up`
stack and the phase-19 load harness are untouched.

Specification: `.ai/phases/phase-20-observability.md` (D1–D8). Decisions:
ADR-0040 (metrics architecture), ADR-0041 (alerting posture), ADR-0042
(dashboard interpretation).

## Start the stack

From the repository root, with the core services running (`docker compose up
-d` — the API and worker must be up for anything to be scraped):

```sh
docker compose --profile monitoring --profile worker up -d
```

That adds: Prometheus (`127.0.0.1:9090`), Alertmanager
(`127.0.0.1:9093`), Grafana (`127.0.0.1:3002`, user `admin` / password
`admin` locally — override with `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`),
the `alert-receiver` log sink, and the Postgres/Redis exporters. All UI ports
bind to loopback only.

| Surface | URL | Notes |
| --- | --- | --- |
| Grafana | <http://127.0.0.1:3002> | Dashboards auto-provisioned under the **BrinnPay** folder |
| Prometheus | <http://127.0.0.1:9090> | Targets page shows api/worker/exporters |
| Alertmanager | <http://127.0.0.1:9093> | Routes every alert to the local receiver |
| Alert log | `docker compose logs -f alert-receiver` | One NDJSON line per alert batch |
| API metrics | <http://127.0.0.1:3000/metrics> | Prometheus text exposition |
| Worker metrics | <http://127.0.0.1:9464/metrics> | Not published to the host by compose; reachable on the compose network / from the worker container |

Tear down with `docker compose --profile monitoring --profile worker down`
(add `-v` to drop the monitoring volumes too).

## Metric surface (what gets scraped)

- **API** (`apps/api`): Prometheus text exposition at `METRICS_PATH`
  (default `/metrics`), outside `/api/v1` and outside the OpenAPI contract.
  Excluded from rate limiting, request-log persistence, and pino
  auto-logging — same classification as `/health/live`.
- **Worker** (webhook worker process): its own `node:http` listener on
  `WORKER_METRICS_PORT` (default `9464`) serving `/health/live` (always) and
  the exposition path (only when metrics are enabled).

Catalog v1 (closed set — additions need a recorded reason, ADR-0040):
HTTP request count/duration/in-flight by route template + method + status
class; 5xx and unhandled-exception counts; rate-limit throttles, window
exhaustions, degraded state/episodes; request-log write/failure counts;
delivery attempt outcomes; queue job counts by state; oldest-pending
delivery age (aggregate + bounded top-50 per project); worker sweep pass
durations and last-run timestamps; plus default process metrics (memory, event
loop, uptime).

Labels are bounded by design: route **templates** never raw URLs, a closed
label-key set, no PII or secrets; the only tenant-identifying label is
`project_id` on the fairness gauge, capped at 50 projects with an aggregate
fallback.

## Configuration

Non-secret knobs (all have safe local defaults; set in `docker/.env` or the
shell):

| Variable | Default | Meaning |
| --- | --- | --- |
| `METRICS_ENABLED` | `true` locally, `false` in production | Master switch for the exposition on both planes |
| `METRICS_PATH` | `/metrics` | Exposition path (must not collide with `/api/v1`, `/health/*`, Swagger) |
| `METRICS_SCRAPE_TOKEN` | *(empty)* | Optional bearer token (min 32 chars) required on the exposition |
| `WORKER_METRICS_PORT` | `9464` | Worker listener port |
| `PROMETHEUS_PORT` / `ALERTMANAGER_PORT` / `GRAFANA_PORT` | `9090` / `9093` / `3002` | Loopback UI ports |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / `admin` | Local Grafana login |

Scrape-token mode: set `METRICS_SCRAPE_TOKEN` in the environment (or
`docker/.env`) before `up`. Compose passes it to the API, the worker, and
Prometheus, whose entrypoint writes it to a container-local credentials file
at start (`credentials_file` in prometheus.yml — Prometheus does not expand
environment variables in its own config, it would send the literal text).
The endpoint compares hashes only — the token is never echoed or logged.
After changing the token, recreate the affected containers
(`docker compose --profile monitoring up -d --force-recreate prometheus api worker`),
because the file and the app env are both fixed at container start.

## Alerts

Exactly four committed rules (`monitoring/prometheus/alerts.yml`), all
`severity: warning`, thresholds documented as **baseline-derived operational
guardrails — not SLOs**:

| Alert | Expression (essence) | For | Trigger served |
| --- | --- | --- | --- |
| `BrinnPayApiErrorRateHigh` | 5xx share > 2% | 5m | Phase 18 A09 / M4 error monitoring |
| `BrinnPayRateLimitDegraded` | `brinnpay_rate_limit_degraded > 0` | 2m | Phase 13 §16 degraded-mode handover |
| `BrinnPayDeliveryQueueLag` | oldest pending delivery > 1800 s | 10m | ADR-0039 PR-2 / PR-5 |
| `BrinnPayRequestLogWriteAnomaly` | write rate > 100 / s | 10m | ADR-0039 PR-3 |

Notification is local-only: Alertmanager → `alert-receiver` → NDJSON on
stdout. Human routing (email/paging) is deliberately deferred to Phases
22/24 (ADR-0041).

### Correlation path (metrics → logs → records)

1. A dashboard panel or alert fires on an aggregated signal.
2. Use the window and route template to filter structured pino logs on stdout
   (`docker compose logs -f api`) — request IDs are in every log line.
3. Request logs and the audit log are the investigation surface for the
   specific requests (ADR-0021/ADR-0022); metrics never replace them.

## Dashboards

Provisioned automatically from `monitoring/grafana/dashboards/`:

- **BrinnPay — API**: request rate/latency, 5xx + unhandled exceptions,
  rate-limit throttles/degraded, request-log write rate, in-flight.
- **BrinnPay — Webhook Worker**: queue depth by state, delivery aging and
  attempt outcomes, per-project fairness ages, sweep durations/freshness.
- **BrinnPay — Infrastructure**: target liveness, Postgres/Redis exporter
  metrics, process memory/event-loop/uptime by plane.

## Security notes

- The exposition is operational surface: no domain data, minimal failure
  payloads, not in Swagger or the public API reference.
- Documented as internal-network-only; when the stack runs anywhere shared,
  set `METRICS_SCRAPE_TOKEN` and keep the port off public interfaces
  (firewall obligation recorded for Phases 21/24 in ADR-0040). The worker's
  own listener binds `0.0.0.0` (it must be reachable by the compose
  healthcheck and Prometheus) and is the only surface with bounded per-project
  series — same token rule applies to bare-metal worker runs.
- Committed artifacts (rules, dashboards, scrape configs, this runbook) carry
  no secrets, credentials, PII, or hostnames beyond localhost.

## Troubleshooting

- **Targets down**: confirm the core stack is up (`docker compose ps`) — the
  profile adds scrapers, not the API/worker themselves.
- **No worker metrics**: the worker is behind the `worker` profile too; start
  it with `--profile worker`. Liveness (`/health/live`) works even with
  metrics disabled.
- **401 on the exposition**: `METRICS_SCRAPE_TOKEN` is set for the app but the
  scrape carries a different (or empty) token — both sides are fixed at
  container start, so recreate them together (see Scrape-token mode above).
- **Grafana dashboards missing**: check the `brinnpay` provider logs; the
  provisioning directory is mounted read-only from
  `monitoring/grafana/provisioning`.
