-- Phase 4 — Organizations & RBAC.
--
-- Extends the Phase 3 tenant tables (ADR-0011, ADR-0010):
--   1. `organization_members` becomes mutable (role changes) → `updated_at`
--      column, backfilled from `created_at` for pre-existing rows (no
--      DB-side default per the project conventions).
--   2. New `invitations` table: email-bound, `pending | accepted | canceled`,
--      with the partial unique index enforcing one pending invitation per
--      (organization_id, email) — historical rows do not block re-inviting.

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN "updated_at" TIMESTAMPTZ(3);

-- Backfill pre-existing rows; the column is NOT NULL with no default.
UPDATE "organization_members" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;

ALTER TABLE "organization_members" ALTER COLUMN "updated_at" SET NOT NULL;

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invitations_organization_id_idx" ON "invitations"("organization_id");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
-- Partial unique index: the DB-level guard behind the "one pending invitation
-- per (organization, email)" rule (Phase 4 §6.3, D5).
CREATE UNIQUE INDEX "invitations_organization_id_email_pending_key" ON "invitations"("organization_id", "email") WHERE status = 'pending';

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;