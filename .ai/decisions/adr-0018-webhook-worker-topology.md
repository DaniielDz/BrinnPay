# ADR-0018: Webhook Worker Process Topology and BullMQ Registration

- **Status:** Accepted
- **Date:** 2026-09-28
- **Phase:** 10
- **Scope:** Which process consumes the webhook queue and how the queue is wired (phase 10 D14,
  F7; ADR-0013).

## Context

BullMQ enters the project in this phase (ADR-0013), and the topology is a real decision rather than
a default:

- **In-process consumption** would put destination latency and destination failure modes on the
  request-serving path. A destination that hangs or an outbound DNS problem would then consume API
  capacity, and API and delivery would fail together.
- **A separate process** needs its own entrypoint, its own module graph, and its own configuration,
  and it must not accidentally boot the HTTP surface or the authentication stack it does not need.
- The API still needs Redis for the queue producer, so "separate process" cannot mean "separate
  infrastructure": both processes share PostgreSQL and Redis and nothing else.
- `@nestjs/bullmq` builds the `Worker` for a `@Processor` class from the module's **root**
  configuration, and installs the registrar that performs that build through `registerQueue`. A
  process that configures only `forRoot` compiles and boots successfully while consuming nothing —
  a silent failure that no unit test can catch, because the decorated class is instantiated either
  way.

## Decision

**The API produces; a dedicated worker process consumes. The worker's composition root is
`WebhooksWorkerModule`, and it is the only module that imports `@nestjs/bullmq`.**

- **API process** (`AppModule`): keeps the queue **producer** and never imports `BullModule`. It
  cannot consume by construction, and starting a second API replica does not duplicate consumers.
- **Worker process** (`src/worker.ts` → `WebhooksWorkerModule`): a Nest **application context**, not
  an application. No HTTP listener, no readiness contract, no session/API-key authentication
  (Phase 2 D9 — readiness is about serving requests; Phase 20 owns worker observability).
- The worker imports `WebhooksCoreModule` — the persistence boundary, the producer, and the
  delivery executor — and **not** `WebhooksModule`, so no HTTP route and no dual-mode guard is
  registered by the webhooks side. It performs no authentication of any kind, and an application
  context binds no listener, so nothing it loads can serve traffic. (It does still import `AuthModule`
  for its boot-time `JWT_SECRET` validation — see Consequences.) The dependency is one-directional:
  payments and refunds know the event port, never the worker.
- BullMQ registration is explicit and complete: `BullModule.forRootAsync` supplies the connection
  (from `REDIS_URL` through the same parser the producer uses, so host, credentials, TLS, and
  database index always agree) and `BullModule.registerQueue({ name })` installs the registrar that
  creates the `Worker`. The `@Processor` decorator carries no connection of its own, because
  decorator metadata is evaluated at import time, before the injector exists.
- The worker registers the three repeatable maintenance passes (reconciliation, payment
  advancement, retention cleanup) at bootstrap through `upsertJobScheduler`, so the schedule
  survives a restart and is not duplicated by a second replica.
- Destination policy (allow/deny lists), the delivery policy, and the encryption key are resolved
  from the same configuration loader in both processes. `WEBHOOK_ENCRYPTION_KEY` **must match** the
  API's value, or every delivery signs with a key the destination cannot verify.
- Because `JWT_SECRET` is validated at boot, the worker must receive it too even though it never
  authenticates a request (see Consequences). `REDIS_URL` must be the same value, and the queue
  name is a single shared constant — the worker and the API are two consumers of one queue, not two
  private queues.

## Consequences

- A slow, hanging, or hostile destination can only affect the worker: API request latency and
  availability are independent of outbound delivery.
- Scaling delivery means scaling workers; scaling the API does not multiply consumers.
- There is one more process to deploy, and the local stack gained a second Compose service. It needs
  `REDIS_URL`, `WEBHOOK_ENCRYPTION_KEY`, and — because boot validation is not conditional —
  `JWT_SECRET`, even though it never serves a request. `WEBHOOK_ENCRYPTION_KEY` is the one value
  where a mismatch is silent: the worker would sign every delivery with a key no destination can
  verify, and every attempt would fail.
- The worker depends on `PaymentsModule` for the advancement sweep, which drags that module's
  route-guard graph (and therefore `AuthModule` and `RedisModule`) into the context. The import is
  documented rather than worked around, because splitting a Phase 7 module is out of this phase's
  scope.
- A misconfigured worker fails **loudly** in the two ways that matter: a missing queue registration
  is impossible to reach at runtime without the registrar, and a missing or malformed `REDIS_URL`
  fails fast. The failure mode that cannot be caught by configuration alone — a worker that never
  consumes — is covered by the delivery e2e test, which boots a real worker application context and
  asserts that a job actually leaves the queue.
