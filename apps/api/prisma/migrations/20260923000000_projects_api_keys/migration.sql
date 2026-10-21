-- Phase 5 — Projects & API Keys.
--
-- Adds the tenant-owned `projects` table (organization → project, D7) and the
-- `api_keys` table (project → api key, D4/D5):
--   1. `projects`: UUIDv7 IDs, `varchar(200)` names (not unique), FK to
--      `organizations` with ON DELETE CASCADE (D7) and an index on the FK.
--   2. `api_keys`: UUIDv7 IDs, app-validated `environment` (`test`/`live`),
--      the unique SHA-256 hash of the credential (D4/D5), nullable
--      `revoked_at`, and a FK to `projects` with ON DELETE CASCADE.
-- The `test`/`live` environments themselves are never stored (D6).

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Global uniqueness of the credential hash (D5): the entropy of the generated
-- keys makes collisions cryptographically negligible; multiple *active* keys
-- per (project, environment) are allowed (rotation, D1).
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;