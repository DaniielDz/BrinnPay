-- Phase 10 — Webhooks.
--
-- Makes the event system real (phase 10 §5.1): a durable project-scoped event
-- store, the developer-registered destination registry, and the per-(event,
-- endpoint) delivery aggregate. Same conventions as every earlier phase
-- (UUIDv7 `uuid` IDs, `snake_case`, UTC timestamps, app-supplied id/timestamp
-- values, app-validated `varchar` enums — phase 4 D10 pattern).
--
--   1. `webhook_events` — immutable, scoped to exactly one (project,
--      environment). `id` is supplied by the emitting module, so re-persisting
--      the same event is a no-op rather than a duplicate row (§4.3.5). The
--      `payload` jsonb is the canonical phase 1 §9.5 envelope: the exact bytes
--      that are delivered, so a replay is byte-identical to the original
--      (§4.3.2). FK to `projects` ON DELETE CASCADE (tenant isolation).
--   2. `webhook_endpoints` — the destination URL, its closed-catalog event
--      subscription, and the signing secret. The secret must be *recoverable*
--      to sign (hashing, as for API keys, is impossible — D8), so it is
--      encrypted at rest with AES-256-GCM and split into ciphertext, IV and
--      auth tag. Duplicate URLs are allowed (D16), so there is no unique
--      constraint on (project, environment, url).
--   3. `webhook_deliveries` — one row per (event, endpoint) with an `attempts`
--      counter and the last attempt's outcome (D4). `last_error` is a bounded,
--      sanitized summary — never a response body, never a secret (§5.4).
--      `request_id` records the API request that caused the event
--      (phase 1 §7.7, F4). Both FKs cascade: deleting an endpoint removes its
--      delivery records while the project-scoped events survive and stay
--      replayable to other endpoints (D11).

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "event_types" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "secret_ciphertext" VARCHAR(512) NOT NULL,
    "secret_iv" VARCHAR(64) NOT NULL,
    "secret_auth_tag" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_endpoints_event_types_not_empty_check" CHECK (array_length("event_types", 1) >= 1)
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "last_error" VARCHAR(500),
    "next_attempt_at" TIMESTAMPTZ(3),
    "request_id" VARCHAR(64),
    "is_replay" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed')),
    CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("attempts" >= 0)
);

-- CreateIndex — environment-scoped cursor scans (UUIDv7 ascending).
CREATE INDEX "webhook_endpoints_project_id_environment_id_idx" ON "webhook_endpoints"("project_id", "environment", "id");

-- CreateIndex — the subscription match for enqueueing an event's deliveries.
CREATE INDEX "webhook_endpoints_project_id_environment_enabled_idx" ON "webhook_endpoints"("project_id", "environment", "enabled");

-- CreateIndex — environment-scoped cursor scans and the `type` filter (D15).
CREATE INDEX "webhook_events_project_id_environment_id_idx" ON "webhook_events"("project_id", "environment", "id");

-- CreateIndex — the `type` filter (D15).
CREATE INDEX "webhook_events_project_id_environment_type_idx" ON "webhook_events"("project_id", "environment", "type");

-- CreateIndex — the retention cleanup scan (D9).
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events"("created_at");

-- CreateIndex — per-endpoint delivery cursor scan (D15 `status` filter).
CREATE INDEX "webhook_deliveries_endpoint_id_id_idx" ON "webhook_deliveries"("endpoint_id", "id");

-- CreateIndex — the reconciliation scan for deliveries waiting to be queued.
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
-- "An event produces at most one delivery per matching endpoint" (phase 10
-- §4.3.6) is enforced here rather than in application code, so a concurrent
-- enqueue can never fan a single event out twice. Manual replays
-- (D12) intentionally create additional deliveries, so the index is partial
-- on the non-replay rows — raw SQL, because Prisma cannot express a
-- `WHERE` clause on a unique index (the Phase 4 invitation pattern).
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_unique" ON "webhook_deliveries"("event_id", "endpoint_id") WHERE "is_replay" = false;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
