-- Phase 8 — Idempotency.
--
-- Adds the internal `idempotency_records` table (project → idempotency
-- record). It stores the API response projection of a committed mutation so a
-- retry of the same key replays that response instead of re-executing the side
-- effect (phase 8 §4/§5; ADR-0004):
--   1. `idempotency_records`: UUIDv7 `id`, the FK scope (`project_id`),
--      `operation_scope` (app-owned string catalog: `payments.create`,
--      `refunds.create` — Phase 9 adds its own value with no schema change),
--      the client `idempotency_key`, and the replayable `response_status` /
--      `response_body` (`jsonb` — the API projection, never a raw ORM dump).
--   2. `response_status`/`response_body` are NULLABLE by design: the claim row
--      is inserted *before* the mutation runs and completed by an UPDATE inside
--      the same transaction, so a rolled-back mutation leaves no committed
--      record (phase 8 §4.4, §6.8). `updated_at` carries that completion.
--   3. FK: `project_id` → `projects` ON DELETE CASCADE (idempotency is
--      project-scoped; project deletion removes its records).
--   4. Uniqueness + indexing: the compound UNIQUE
--      (project_id, operation_scope, idempotency_key) is the constraint that
--      makes the claim atomic under concurrency (phase 8 §4.4/§5.2) and defines
--      the key scope fixed by ADR-0004; `(project_id, operation_scope)` — its
--      index prefix — serves the expired-row cleanup, and `(expires_at)` serves
--      expiry-driven reuse and bounded storage.
-- No seed data, no secrets, no public API resource (phase 1 §13.2.2).

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "operation_scope" VARCHAR(100) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_project_id_operation_scope_idempotency_key_key" ON "idempotency_records"("project_id", "operation_scope", "idempotency_key");

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
