# ADR-0041: Alerting Posture — Rules Only, Local Notification, Human Routing Deferred

- **Status:** Accepted
- **Date:** 2026-10-15
- **Phase:** 20
- **Scope:** What alerting exists after Phase 20 (D6/Q3): four committed rules
  over the Phase 20 metrics, who evaluates them, where notifications land, what
  is deliberately deferred and to whom — recorded in the ADR-0037 accepted-risk
  register style so the Phase 18 A09 limitation can be narrowed with a named
  owner rather than silently closed.

## Context

§3 F7/F10 and the Phase 18 A09 handover put "alerting" on the Phase 20 scope
line without defining it. Three readings were possible (§13 D6):

1. **Full alerting with delivery channels** — impossible without inventing
   business requirements: no channel, recipient, escalation policy, or paging
   tool exists anywhere in the repository, and §4 rule 3 forbids inventing
   product behavior.
2. **Rules-only alerting** — committed, reviewable alert expressions evaluated
   by the same stack that serves the metrics, notifying a local/log target that
   a developer can actually observe. Thresholds must be labeled as what they
   are: baseline-derived operational guardrails (Q6, §4 rule 8), never SLOs —
   no specification supplies a hard product target.
3. **Defer all alerting** — rejected by the authority because the goal sentence
   is binding, but only defensibly if the deferral carried a named owner
   (Phase 19 rule 7: handovers are re-owned, never dropped).

The threshold inputs are fixed by prior artifacts: the Phase 19 baseline
(`docs/performance-baseline.md`, ADR-0038) recorded a 0% contract-level error
rate in every scenario, ≈ 179 req/s sustained scan load producing ≈ 24 k
request-log rows/min (ADR-0039 PR-3), self-clearing pending-delivery pileups
within the 5-attempt ladder (PR-2), and delivery/log lag observable under burst
(P-11/PR-5). ADR-0039 names "Phase 20 metrics" as the reopen trigger six times.

## Decision

**D6(a): rules-only alerting ships now; human routing stays deferred with a
named owner.** The rule set is closed — exactly the four rules below, each
justified by a trigger, finding, or baseline number, never by taste.

### What exists

| # | Rule | Signal | Threshold | Justification |
| - | ---- | ------ | --------- | ------------- |
| 1 | `BrinnPayApiErrorRateHigh` | 5xx rate over the API request series (`plane="api"`) | `> 2%` for 5m | Baseline is 0% contract-level errors in every scenario; 2% is the first band where a regression is operationally meaningful, not a single fluke response. |
| 2 | `BrinnPayRateLimitDegraded` | `brinnpay_rate_limit_degraded > 0` | for 2m | ADR-0024 degraded posture: Redis unreachable, bounded in-process fallback active. Visible exactly as Phase 13 §16 handed over. |
| 3 | `BrinnPayDeliveryQueueLag` | `brinnpay_delivery_oldest_pending_age_seconds` | `> 1800` for 10m | ADR-0039 PR-2/PR-5 reopen signal: pending deliveries aging past the attempt-ladder horizon at steady state. |
| 4 | `BrinnPayRequestLogWriteAnomaly` | `sum(rate(brinnpay_request_log_writes_total[10m]))` | `> 100/s` for 10m | ADR-0039 PR-3 trigger: sustained scanning amplifies ≈ 24 k rows/min at ≈ 171–179 req/s; normal operation stays far below. |

- **Evaluation:** Prometheus evaluates `monitoring/prometheus/alerts.yml` on
  the opt-in `monitoring` compose profile (D2(a) stack). Rules ship in the
  repository, so evaluation is reproducible from a clean checkout.
- **Notification target:** Alertmanager routes every alert to the local
  `alert-receiver` sink, which logs NDJSON to stdout — a developer can read
  fired alerts from `docker compose logs` with no external service. This is
  the "local/log/webhook-of-record" target D6(a) names.
- **Interpretation contract:** every rule's annotation cites its baseline or
  ADR source and states explicitly that it is an operational guardrail, not an
  SLO — an alert must not be misread as a product commitment (Q6).
- **Alerts sit on panels first:** each rule references a signal that the
  committed dashboards panel (§16 "dashboards first, alerts second").

### What is deliberately deferred (with owners)

| Deferred item | Owner | Reopen trigger |
| ------------- | ----- | -------------- |
| Human routing (email/paging/chat), recipient lists, escalation policy | Phase 24 (log channel consumption) | Any deployment needing on-call notification, or Phase 22 staging evaluation proving the local target insufficient |
| Alert evaluation against real staging traffic (first live tuning of the guardrail thresholds) | Phase 22 (probe semantics, alert evaluation on staging) | Phase 22 entry |
| Dashboard-driven alert tuning (thresholds re-derived from observed steady-state rates) | Phase 22, with Phase 20 baseline as the starting point | First staging baseline run |

### Effect on the Phase 18 A09 limitation

Phase 18 A09 recorded "alerting/metrics deferred to Phase 20 by roadmap scope".
After this phase the limitation is **narrowed, not closed**: metrics and
rules-only alerting ship here (AC4/§6 M4); the remaining gap — human alert
routing — stays open under the Phase 24 owner named above. Phase 26 release QA
may close A09 only once that routing decision is taken (§17).

## Consequences

- **Positive:** the four ADR-0039 triggers that named "Phase 20 metrics" are now
  executable rules rather than prose; a sandbox operator gets actionable signal
  with zero external dependencies; the deferral table means nothing in §17 is
  dropped without an owner.
- **Negative:** thresholds are guesses bounded by a sandbox baseline — they
  will need tuning against real traffic (Phase 22, table above), and a local
  NDJSON sink means nobody is paged; an unattended deployment would learn of a
  firing alert only by reading logs until Phase 24.
- **Neutral:** no new business behavior: no recipients, schedules, or
  escalation semantics are invented; the rule file and receiver are test-validated
  artifacts (closed rule count, closed annotation vocabulary, no external hosts
  or secrets in the rules).
