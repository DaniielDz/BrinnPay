# ADR-0040: Metrics Architecture — Exposition, Worker Export, Exposure, and Label Policy

- **Status:** Accepted
- **Date:** 2026-10-15
- **Phase:** 20
- **Scope:** The scrape contract Phases 21/22/24 inherit: exposition format and
  endpoint placement (D1), the worker's metrics/health export mechanism including
  the ADR-0018 posture amendment (D3), exposure/authentication posture (D4), and
  the label/tenant-data policy (D5). One ADR so no later phase re-derives any of
  it (§15).

## Context

Phase 20 §3 findings F2/F6/F9 and the §17 handovers (Phase 13 §16 throttling
metrics, Phase 11 log-write visibility, ADR-0039 PR-1…PR-5 triggers, Phase 10
worker observability) all converge on one surface that did not exist: a metrics
exposition. Four things were undecided and each had a collision:

1. **Format** (F2): the roadmap says "Prometheus", the spec allows alternatives,
   and a custom JSON endpoint would force every consumer (dashboards, Phase 22
   evaluation, Phase 24 ingestion) to be re-implemented against it.
2. **Worker export** (F6): ADR-0018 records the worker as an application context
   with *no HTTP listener* — while M5 gauges (queue depth, oldest-pending age,
   sweep timing) can only be produced where the worker runs. Scraping a second
   process is exactly the collision §13 D3 names.
3. **Exposure** (F9): the endpoint must exist for local scraping with zero setup
   yet must not become an unauthenticated production surface, and it must sit
   outside `/api/v1` or it would be rate-limited, request-logged, and specified —
   all three forbidden by §5.
4. **Labels** (F9, §4 rule 4): PR-1's fairness trigger cannot be observed
   without *some* per-tenant signal, while a free label set is a cardinality DoS
   and raw request paths would mint a series per scan URL (the exact F3/PR-3
   shape).

Constraints: D1–D5 were confirmed by the product authority on 2026-10-15
(§13/§14); the OpenAPI contract must not change (AC8); no PII or secrets may
appear anywhere in the observability surface (AC7); and the default stack must
stay lean — plain `docker compose up` and `pnpm loadtest` unchanged.

## Decision

### D1(a) — Prometheus text exposition, pulled

Each process owns one `@prometheus-io/client` registry (the maintained
`prom-client` successor; the original package is deprecated) and serves the
standard Prometheus text exposition at a single configured path. Collection runs
in-process always; there is no local metrics storage and no push pipeline.
Pull was chosen over a custom JSON endpoint and over OpenTelemetry per §13 D1.

### Endpoint placement and the exclusion set

The exposition lives **outside `/api/v1`** and joins the same boot-time
exclusion plumbing as the health endpoints: `GLOBAL_PREFIX_EXCLUSIONS` (global
prefix), the request-log prefix rule, the pino auto-logging ignore list, and
rate-limit stage 0. A scrape is therefore never throttled, never persisted to
the request log, and never logged (AC7/§5). `METRICS_PATH` is validated at
boot: an absolute plain path that is not `/`, not under `/api/v1`, and not
shadowing `/health/*` or the Swagger mount.

### D3(a) — worker's own listener (amends ADR-0018)

The worker serves exactly two routes on its **own port** (default `9464`,
`WORKER_METRICS_PORT`): `/health/live` and the exposition path. Nothing else:
no controllers, no Swagger, no readiness contract, no authentication surface —
the application-context posture of ADR-0018 is otherwise unchanged. The
liveness route answers even when exposition is disabled, so the compose
healthcheck never depends on the metrics flag (D7(a)/AC2). The port is not
published to the host; Prometheus and the healthcheck reach it over the compose
network. The ADR-0018 amendment note records this posture change explicitly
(§15). Alternatives (b) Redis-exported counters and (c) logs-only were rejected
per §13 D3: they couple scrape freshness to key design or cannot produce M5
gauges at all.

### D4(a) — enable flag plus optional scrape token

- `METRICS_ENABLED` governs only the **exposition endpoint**, never collection
  (values and counters are maintained regardless). It defaults to **on outside
  production** (a clean checkout is scrapeable with zero setup, AC1) and **off
  in production** so exposure is a deliberate act.
- `METRICS_SCRAPE_TOKEN`, when set, requires `Authorization: Bearer <token>` on
  every scrape. It must be ≥ 32 characters or boot fails; the error never
  echoes the value, and the token is never logged or reflected in any response.
  Unset means network-trust only — a legitimate local posture; the firewall
  obligation for real deployments is recorded for Phases 21/24 (AC11).
- The endpoint is documented internal-network-only in every mode.

### D5(a) — closed label sets; tenant labels confined to the fairness gauge

Every label key belongs to a closed set declared at metric construction:

| Dimension        | Allowed values                                              |
| ---------------- | ----------------------------------------------------------- |
| Route            | matched templates, or the single `unmatched` bucket         |
| Method           | `GET POST PUT PATCH DELETE HEAD OPTIONS other`              |
| Status class     | `2xx 3xx 4xx 5xx other`                                     |
| Queue state      | `wait delayed active failed`                                |
| Delivery outcome | phase-10 §5.4 outcome set                                   |
| Sweep pass       | `reconciliation requeue advancement retention`             |
| Rate-limit class/scope | phase-13 registered classes/scopes                    |

Rules the tests enforce:

- **Unmatched requests collapse to one series**: raw URLs never become labels;
  `routeTemplateOf` buckets 404s (and Express 5 framework-fallback patterns
  such as `/api/v1{/*splat}`, which *match* but are not contract routes) as
  `unmatched`, so scan traffic cannot mint series.
- **Tenant labels exist only on `brinnpay_delivery_oldest_pending_age_by_project_seconds`**,
  permitted solely because the surface is non-public per D4, and bounded to the
  oldest `MAX_PENDING_PROJECTS` (50) projects per scrape; beyond the ceiling the
  per-project view is withheld and only the aggregate survives. No PII: labels
  are opaque IDs, never names, emails, URLs, or tokens.
- **Scrapes never appear in the HTTP metrics**: that middleware measures only
  `/api/v1/...` requests (the same predicate the rate-limit guard and
  request-log middleware use), and the exposition lives outside the prefix —
  so a 15-second scrape observes itself as nothing (AC7/§5), and instrumentation
  work is limited to integer increments on the hot path (§16).

## Security review

D4/D5 are security-sensitive and were reviewed as such (§4 rule 6):

- Scrape authentication is optional *by decision*, with the weak posture
  limited to local/network-trust mode and a fail-fast strength floor when a
  token is mandated; production exposure is an explicit Phase 21/24 firewall
  obligation, not an oversight.
- The token is handled like `JWT_SECRET`: length-validated at boot, never
  logged, never echoed in errors or metrics.
- Label policy is a closed set with a unit-tested cardinality gate; adversarial
  path/method corpora (traversal, query strings, JWT-shaped segments, invented
  verbs) are asserted in e2e to stay out of the exposition.
- The exposition leaks no business data: counts, durations, and opaque IDs only.

## Consequences

- **Positive:** one scrape contract for Phases 21 (exposure/firewall), 22
  (staging evaluation of ADR-0039 triggers against real panels), and 24
  (ingestion continuity); ADR-0039 PR-1…PR-5 reopen triggers are now
  observable signals instead of log archaeology; the worker's failure modes
  (queue lag, sweep drift) become first-class.
- **Negative:** one more listener in the worker process (narrowly scoped, and
  the reason for the ADR-0018 amendment); `@prometheus-io/client` joins the
  dependency graph under ADR-0036 gating; deployments must remember the D4
  production-default-off and the firewall obligation when they want scraping
  in real environments.
- **Neutral:** the readiness contract, `/health/*` semantics, and OpenAPI are
  untouched (AC2/AC8); collections that query Redis/PostgreSQL do so only at
  scrape time and are explicitly capped (§16) so observability cannot recreate
  the write amplification it exists to detect (Phase 19 P-11).
