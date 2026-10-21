-- Phase 11 — Request logging.
--
-- Adds the API-wide `request_logs` table (phase 11 §5.1): one durable row per
-- request made under the `/api/v1` prefix, whatever its outcome. Same
-- conventions as every earlier phase (UUIDv7 `uuid` PK supplied by the
-- application, `snake_case`, UTC `created_at`, app-validated `varchar`
-- environment/method).
--
-- The table is deliberately an **allowlist projection**: every column is one of
-- the contract's `RequestLog` fields (plus the D1 `environment`), so there is
-- no column capable of holding a request body, a header, a query string, or a
-- secret — absence is the control (§4.2 rule 4, D6).
--
-- Tenant lifecycle: `project_id` and `organization_id` cascade, so deleting a
-- tenant removes its log rows and leaves nothing orphaned (AC11). `user_id`
-- and `api_key_id` are ON DELETE SET NULL: removing a user (or revoking and
-- eventually removing a key) must not delete the surrounding log history — a
-- key is only hard-removed together with its project, so no orphaning occurs.
--
-- Indexes serve the project-scoped ascending cursor scan `(project_id, id)`,
-- the D1 environment equality filter `(project_id, environment, id)`, the D8
-- exact `request_id` lookup, and the retention cutoff scan on `created_at`.

-- CreateTable
CREATE TABLE "request_logs" (
    "id" UUID NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "project_id" UUID,
    "organization_id" UUID,
    "user_id" UUID,
    "api_key_id" UUID,
    "environment" VARCHAR(20),
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(2048) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_logs_project_id_id_idx" ON "request_logs"("project_id", "id");

-- CreateIndex
CREATE INDEX "request_logs_project_id_environment_id_idx" ON "request_logs"("project_id", "environment", "id");

-- CreateIndex
CREATE INDEX "request_logs_request_id_idx" ON "request_logs"("request_id");

-- CreateIndex
CREATE INDEX "request_logs_created_at_idx" ON "request_logs"("created_at");

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
--
-- Not part of the request-log schema: it corrects a pre-existing name drift on
-- the Phase 8 idempotency unique index. The committed Phase 8 migration created
-- `..._idempotency_key_key`, which PostgreSQL truncated to 63 characters
-- (`..._idempotency_key_`), while the current Prisma generator expects
-- `..._idempotency__key`. The index itself is unchanged (same columns, still
-- unique); only its name is reconciled so `prisma migrate dev` stops reporting
-- schema drift on every run.
ALTER INDEX "idempotency_records_project_id_operation_scope_idempotency_key_" RENAME TO "idempotency_records_project_id_operation_scope_idempotency__key";
