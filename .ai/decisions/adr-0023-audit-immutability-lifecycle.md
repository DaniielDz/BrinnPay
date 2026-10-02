# ADR-0023: Audit Immutability and Lifecycle — Append-Only With Tenant Cascade

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** 12
- **Scope:** How `audit_log_entries` is kept immutable, how it interacts with tenant deletion,
  and why it deliberately diverges from `request_logs` on retention and write guarantees (phase
  12 D8, D9).

## Context

Phase 1 §8 makes the rule absolute: *audit entries are append-only; entries are never updated or
deleted*. Yet three forces pull against it:

- Phase 4 D9 and Phase 5 recorded obligations that **organization deletion must interact with
  audit rows** — a tenant's trail may not outlive its tenant.
- The Prisma schema convention of nullable `ON DELETE SET NULL` foreign keys would let the
  database *rewrite* a row when an actor or resource is deleted — silently altering history.
- The sibling Phase 11 `request_logs` store keeps rows for a bounded window and is written
  best-effort; the audit trail shares its module neighbourhood but not its guarantees.

## Decision

**Plain-id reference columns behind a single cascade foreign key, a database trigger that
rejects `UPDATE`, and no retention — entries live exactly as long as their organization.**

- **Exactly one foreign key (D9).** `organization_id` → `organizations.id` `ON DELETE CASCADE`
  (ADR-0011: the owning phase adds its schema). Deleting an organization removes its entries;
  no row may outlive its tenant. This discharges the Phase 4 D9 and Phase 5 obligations.
- **Plain UUID values, no FK, no `SET NULL` (D8).** `actor_id`, `resource_id` and `project_id`
  are stored as plain UUID values with no foreign key. Historical attribution therefore survives
  the deletion of the actor, the resource or the project — and because no `ON DELETE SET NULL`
  action exists anywhere, the database can never rewrite a row. Immutability (phase 1 §8) and the
  referential lifecycle are compatible *by construction* (F9).
- **Three enforcement layers, cheapest first (D8).** (1) No update or delete code path exists —
  the capability exposes capture and list only. (2) No FK action can rewrite a row (above). (3)
  The migration installs a `BEFORE UPDATE` trigger that raises on every `UPDATE`. The trigger
  deliberately does not touch `DELETE`, so the organization cascade remains the only deletion
  path.
- **No retention (D9).** Entries live until their organization is deleted. There is no cleanup
  job, no retention configuration section and no retention index: phase 1 §8 says entries are
  never deleted, audit volume is orders of magnitude below the per-request store, and a trail
  that silently expires contradicts the phase's purpose.
- **Allowlist columns (§6.1).** The table has no column capable of holding a body, header,
  secret, email or free text; `data` is a `jsonb` written only through the per-action builders.
  Absence is the control, consistent with Phase 11 D6's framing.

## Consequences

- Audit and request logs **deliberately diverge**: request logs are best-effort with a default
  30-day retention (ADR-0020), audit entries are fail-closed for mutations with no expiry. The
  two differences are the definition of the channels — accountability versus observability.
- Deleting a project, API key, user or membership leaves entries intact with stable ids; the
  trail is historical evidence, not a live reference.
- Growth is accepted for the MVP sandbox; a future long-horizon retention (e.g. yearly) is a
  specification amendment, not an implementation detail.
- Phase 15 documentation must publish the append-only lifecycle and the org-cascade behavior;
  Phase 18 must re-review immutability and tenant isolation before sign-off.

## Alternatives rejected

- **Application-level-only enforcement (Phase 11 rule 6 level):** rejected — weaker for a
  surface whose core promise is immutability.
- **FKs with `SET NULL` on actor deletion:** rejected — silently rewrites history, contradicting
  "never updated".
- **Blocking `DELETE` outright:** rejected — breaks the confirmed Phase 4 D9 organization
  deletion flow.
- **`RESTRICT` on organization deletion:** rejected — would leave tenants undeletable behind
  their own trail.
- **Configurable retention with periodic cleanup (e.g. 365 days):** viable later amendment, but
  silently expiring a security trail contradicts the phase's stated purpose; recorded as the
  rejected alternative (D9).
