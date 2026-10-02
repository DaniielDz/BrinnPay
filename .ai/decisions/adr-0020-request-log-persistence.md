# ADR-0020: Request-Log Persistence Model — Post-Response Best-Effort Write

- **Status:** Accepted
- **Date:** 2026-10-01
- **Phase:** 11
- **Scope:** How an API request becomes a durable `request_logs` row (phase 11 D3, D5, D6, D7).

## Context

Every request under `/api/v1` must be traceable end to end, but the record is observability data:
losing one is acceptable, while delaying or failing the request that produced it is not (F4).

- A **pre-response synchronous insert** couples the latency and availability of *every* request to
  the log store. A database blip would turn a working API into a failing one for the sake of a
  debugging row.
- An **interceptor** is the natural Nest seam for a response, but guards run *before*
  interceptors: a 401/403/404 raised by an authorization guard never reaches one, yet those are
  exactly the requests §4.2 rule 1 requires a record for.
- Storing **bodies, headers or query strings** is where secret material lives (passwords on login,
  API keys at creation, `Idempotency-Key`, webhook signing secrets). Redaction of a larger payload
  is a control that can be defeated by a field nobody remembered to add.
- One row per request, forever, makes `request_logs` an unbounded operational liability (F8).

## Decision

**Capture with Nest middleware, assemble an explicit field allowlist, write after the response
completes, and expire rows on a schedule.**

- **Middleware, not interceptor** (`RequestLoggingMiddleware`, registered with
  `consumer.apply(...).forRoutes('*')`): middleware wraps every request under the API prefix
  *including* the ones rejected before a handler exists. The record is assembled and written on
  the response's `finish` event — the same lifecycle seam the structured logger uses — so the
  write is outside the request/response path.
- **Prefix-scoped capture (D7).** The `/api/v1` constant (`API_GLOBAL_PREFIX`) is shared by
  `setGlobalPrefix` and the recorder, so routing and recording cannot disagree. Health probes,
  Swagger asset traffic and CORS preflights produce no record; stdout logging stays process-wide
  and the two channels share the request id.
- **Metadata allowlist (D6).** The record is an object literal of the contract's fields —
  `method`, `path` (query string stripped, bounded), `status_code`, `duration_ms`, `created_at`,
  `request_id` and the optional scope ids plus the D1 `environment`. Nothing capable of holding a
  body, header or secret exists as a column: **absence is the control**, not redaction. The same
  allowlist is restated at the Prisma mapping and at the list projection, so a field added to the
  record type does not reach storage or a response until it is named in both.
- **Best-effort write (D3).** `RequestLogStoreService.write` never throws: a failure is logged
  with the request id and the error *class* only (never the message, which can echo a value, never
  the payload) and the record is dropped. Readiness is never coupled to the log store.
- **Retention (D5).** A periodic pass deletes rows older than a configurable window (default 30
  days) in bounded id pages on the `created_at` index. It runs as one more scheduled job on the
  existing webhook queue (ADR-0013's single timer), in the worker process — never on the request
  path, and never as a second job runner.

## Consequences

- Request cost is unchanged by the log store, and a store outage cannot change a response status,
  body or header (AC5).
- Authorization-rejected requests are recorded, because capture does not depend on guards
  succeeding; their scope is whatever the guards had resolved when the response was produced.
- Records are immutable: they are removed only by tenant cascade (`project_id`/`organization_id`
  are `ON DELETE CASCADE`) or by retention expiry. A row can never reference a deleted tenant —
  the foreign key enforces it, and a write that races a deletion fails and is dropped.
- Writing *after* the response means a record can become visible to the list endpoint slightly
  after the caller received its response. That visibility lag is accepted by specification, not a
  defect.
- A request whose tenant was deleted in the same call (project/org `DELETE`) cannot persist its
  own row: the foreign key rejects it and the write is logged and dropped. This is the intended
  consequence of the cascade rule.

## Alternatives rejected

- **BullMQ queue for log rows:** adds Redis coupling and delivery machinery for data whose loss is
  explicitly acceptable (contrast ADR-0015, where events drive delivery).
- **Redacted bodies/headers:** rejected outright by §8; the redaction set can never be proven
  complete against a payload it has not seen.
- **Configurable path denylist instead of a prefix rule:** premature configurability for a fixed
  topology (D7).
