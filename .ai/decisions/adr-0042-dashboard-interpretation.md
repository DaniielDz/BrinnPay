# ADR-0042: Dashboard Interpretation — Infrastructure Artifacts, No Product Metrics Surface

- **Status:** Accepted
- **Date:** 2026-10-15
- **Phase:** 20
- **Scope:** What "monitoring dashboards" means in this repository (D2(a)/Q2):
  committed, Grafana-compatible infrastructure dashboards on the opt-in compose
  profile — and the binding statement that MVP has **no product metrics
  surface**, so a later phase proposing one reopens this decision explicitly.

## Context

§3 F4 and the Phase 14/16 handovers left "observability UI" deferred twice
(dashboard metrics by decision; sandbox scenarios observable but not
throttled), while the Phase 20 roadmap checkbox literally says "monitoring
dashboards". Option (b) in §13 D2 — product observability UI in `apps/web`
with new `/api/v1` metrics endpoints — would trigger a full contract design
(route design, RBAC/tenancy, OpenAPI, rate-limit and request-log treatment)
in a phase whose contract must not change (AC8). The authority confirmed
D2(a) on 2026-10-15 (§14 Q2).

## Decision

**D2(a): dashboards are infrastructure artifacts, not product surface.**

- Three committed Grafana JSON dashboards (`monitoring/grafana/dashboards/`:
  API, worker, infrastructure) are loaded by Grafana through file provisioning
  on the **opt-in `monitoring` compose profile**, with a provisioned Prometheus
  data source (fixed `uid` so the JSON is portable across environments).
- Their panels read only the closed Phase 20 catalog (M1/M5) — operational
  signals for developers running the sandbox, interpreted per ADR-0041's
  guardrail-not-SLO rule.
- **Explicit non-goals (binding):** no metrics endpoints under `/api/v1`, no
  new OpenAPI surface, no dashboard/RBAC/tenancy work, no product-facing
  observability UI in `apps/web`. The Phase 14 and Phase 16 "observability UI"
  deferrals are **not cashed in** by this phase (§17 disposition).

**Reopen condition:** any phase proposing a product metrics surface must
reopen D2 explicitly with the product authority — it is a contract decision
(new routes, authorization, tenancy), never an in-passing implementation
choice (§4 rule 3).

## Consequences

- The roadmap checkbox is satisfied with reviewable, reproducible artifacts
  usable from a clean checkout (AC3), without touching the versioned contract
  (AC8).
- Phases 21/22 inherit the provisioning pattern (exposure and real-traffic
  evaluation) without inheriting an implied product commitment.
- Operators get the three dashboards plus the four rules of ADR-0041 as one
  coherent view; product consumers of metrics remain none until D2 is reopened.
