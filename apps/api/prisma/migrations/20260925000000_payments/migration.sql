-- Phase 7 — Payments.
--
-- Adds the `payments` table (project → payment) with the fixed conventions
-- (UUIDv7 `uuid` IDs, `snake_case`, UTC timestamps, app-supplied
-- id/timestamp values, app-validated `varchar` enums — phase 4 D10 pattern):
--   1. `payments`: scoped to exactly one project + one environment
--      (`test`/`live`) and one customer of the same (project, environment);
--      `amount_minor` bigint holds integer minor units (ADR-0002, USD scale 2)
--      so amounts cannot overflow; `currency` is `usd` only (ADR-0003);
--      `status` is pending/processing/succeeded/failed; `failure_code` is set
--      only for `failed` (catalog is Phase 16); `description` is trimmed
--      (D9), ≤ 500.
--   2. FKs: `project_id` → `projects` ON DELETE CASCADE (project deletion
--      removes its payments) and `customer_id` → `customers` ON DELETE
--      RESTRICT (D4 — the backstop for the delete-with-payments 422).
--   3. Indexes: `(project_id, environment)` for environment-scoped list scans
--      (id-ordered cursor pagination stays efficient at MVP scale) and
--      `(customer_id)` for the delete-with-payments check and future
--      per-customer lookups.
-- No delete surface (the contract has none), no transition-time columns (the
-- simulation schedule derives from `created_at` and the delay constants —
-- phase 7 §4.6), no seed data.

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "failure_code" VARCHAR(50),
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_project_id_environment_idx" ON "payments"("project_id", "environment");

-- CreateIndex
CREATE INDEX "payments_customer_id_idx" ON "payments"("customer_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;