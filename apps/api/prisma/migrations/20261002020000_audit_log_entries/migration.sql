-- Phase 12 — Audit logs.
--
-- Adds the `audit_log_entries` table (phase 12 §6.1): the immutable,
-- organization-scoped security/business trail, written only by the
-- `audit-logging` capability. Same conventions as every earlier phase
-- (UUIDv7 `uuid` PK supplied by the application, `snake_case`, UTC
-- `created_at`, app-validated `varchar` action/actor/environment).
--
-- The table is an **allowlist projection** (§4.2 rule 7, D13): every column is
-- one of the contract's `AuditLogEntry` fields plus the D6 `project_id` and
-- `environment` attribution columns, so there is no column capable of holding a
-- body, a header, an email, free text or a secret — absence is the control.
--
-- References: exactly one foreign key exists — `organization_id` ON DELETE
-- CASCADE (D9), which discharges the Phase 4 D9 and Phase 5 obligations. The
-- audit entry's `actor_id`, `resource_id` and `project_id` are plain UUID
-- **values with no foreign key** (D8): historical attribution survives the
-- deletion of the actor, the resource or the project, and because no
-- `ON DELETE SET NULL` action exists anywhere, the database can never rewrite
-- an entry — the append-only rule (phase 1 §8) and the referential lifecycle
-- are compatible by construction.
--
-- Immutability (D8): `audit_log_entries_reject_update` rejects every `UPDATE`
-- at the database level (defense in depth behind "no update code path"). The
-- trigger is a `BEFORE UPDATE` trigger, so the organization cascade `DELETE`
-- — the only legitimate deletion path — is untouched.
--
-- Index: `(organization_id, id)` serves the contract's ascending UUIDv7
-- cursor scan. No retention-cutoff index exists because there is no cleanup
-- (D9).

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_type" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "resource_type" VARCHAR(50) NOT NULL,
    "resource_id" UUID,
    "project_id" UUID,
    "environment" VARCHAR(20),
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_entries_organization_id_id_idx" ON "audit_log_entries"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutability (D8): entries are never updated after creation. Raw SQL
-- (Phase 4/10 pattern): Prisma cannot express a rejecting trigger.
CREATE OR REPLACE FUNCTION "audit_log_entries_reject_update"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log_entries is append-only: UPDATE is not allowed'
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_entries_no_update"
BEFORE UPDATE ON "audit_log_entries"
FOR EACH ROW EXECUTE FUNCTION "audit_log_entries_reject_update"();
