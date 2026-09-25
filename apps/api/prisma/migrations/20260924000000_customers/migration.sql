-- Phase 6 — Customers.
--
-- Adds the environment-scoped `customers` table (project → customer):
--   1. `customers`: UUIDv7 IDs, app-validated `environment` (`test`/`live`,
--      D10 pattern), `email` (trimmed + lowercased, app-validated format —
--      NOT unique, D1), nullable `name` (trimmed, ≤ 200), nullable `metadata`
--      JSONB holding a flat string map (D6; `{}` when absent), and a FK to
--      `projects` with ON DELETE CASCADE (project deletion removes its
--      customers).
--   2. Indexes: `(project_id)` for project-scoped access and
--      `(project_id, environment)` for environment-scoped list scans
--      (id-ordered cursor pagination stays efficient at MVP scale).
-- The customer lifecycle/status fields arrive with payments (Phase 7); no
-- `deleted_at` (hard delete) and no status columns are introduced.

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_project_id_idx" ON "customers"("project_id");

-- CreateIndex
CREATE INDEX "customers_project_id_environment_idx" ON "customers"("project_id", "environment");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;