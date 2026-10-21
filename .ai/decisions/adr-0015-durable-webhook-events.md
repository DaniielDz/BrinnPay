# ADR-0015: Durable Webhook Events with Best-Effort Enqueue and Reconciliation

- **Status:** Accepted
- **Date:** 2026-09-28
- **Phase:** 10
- **Scope:** How a domain mutation becomes a durable, deliverable webhook event (phase 10 D2, D3).

## Context

Phase 1 assumed an event is emitted as a side effect of the business operation. That is not
sufficient once a real destination is involved:

- A **post-commit** emit can be lost: the process can die between the commit and the enqueue, and
  a Redis outage would then fail nothing while delivering nothing.
- A **pre-commit** emit can lie: an event could be delivered for a mutation that later rolls back.
- Terminal payment events have **no driver**. Without a read of the payment, nothing ever advances
  it, so `payment.succeeded` would never be emitted or delivered (F2).
- An endpoint registered *after* an event was emitted has missed it; a disabled endpoint that is
  re-enabled has missed everything while it was off.

Emitters are the payments and refunds modules, and neither may take a dependency on the endpoint
registry that the API owns; they may only depend on a persistence boundary.

## Decision

**The emitter writes the event and its fan-out inside the business transaction; the queue is
best-effort; a periodic reconciliation pass repairs whatever the queue missed.**

- `WEBHOOK_EVENT_PORT` is a narrow inbound port (`persist(tx, event)`) implemented by the webhook
  core. An emitting module passes its **own** transaction client, so the event row, the
  non-replay delivery rows, and the business rows commit or roll back **together**. A rolled-back
  mutation can never produce an event.
- The port is the only thing payments/refunds import (`WebhooksCoreModule`), never the HTTP
  surface. The closed catalog is owned by the emitting modules and the validation catalog is
  derived from it, so there is no second list to keep in sync.
- "At most one delivery per `(event, endpoint)`" is a **partial unique index** in the migration
  (`WHERE is_replay = false`), not application logic: concurrent fan-out from two paths cannot
  duplicate a delivery, and replays are deliberately exempt so a replay can repeat.
- Enqueueing happens **after commit** and is **best-effort**. A queue or Redis failure is logged
  structurally and swallowed — a committed mutation never becomes a failed response, because the
  event is already durable.
- A **reconciliation pass** (repeatable BullMQ job) recomputes the fan-out of retained events,
  creates the deliveries that are missing, and re-queues pending deliveries whose job was lost.
  It also covers "the endpoint was created or enabled after the event".
- Delivery is **at-least-once**: consumers deduplicate by the envelope `id`
  (`BrinnPay-Event-Id`). Ordering is not guaranteed and is not attempted.
- `payment.succeeded`/`payment.failed` are driven by a **scheduled advancement sweep** that asks the
  payments module to apply due terminal edges. The sweep is a *driver*, not a lifecycle rule: the
  payments compare-and-set still guards every edge, so a sweep racing a read produces exactly one
  terminal event. Read-time catch-up remains as a backstop.

## Consequences

- An event can never be lost or fabricated, and the expensive part (persistence) is transactional
  while the fragile part (Redis) is not on the request path.
- The event store is the single source of truth for "what was emitted", which is also what makes
  replay, listings, and retention possible.
- Fan-out is written even when Redis is down; the reconciliation pass converts stored events into
  deliveries later, so a Redis outage costs **latency**, not events.
- Events carry no request id: the contracted envelope has none and the `webhook_events` row has no
  such column, so a delivery *repaired* by reconciliation stores `request_id = NULL` rather than
  inventing one. The originating request id is recorded on the deliveries created in the original
  transaction, and a replay records the replay request's id.
- Delivery requires a running worker: without one, rows accumulate as `pending` and the readiness
  contract is deliberately unaffected (Phase 2 D9 — readiness is about serving requests, not queue
  health; Phase 20 owns worker observability).
