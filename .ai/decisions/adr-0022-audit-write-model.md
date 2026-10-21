# ADR-0022: Audit Write Model — Transactional Capture, Best-Effort Auth Outcomes

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** 12
- **Scope:** How a committed action becomes a durable `audit_log_entries` row — write
  semantics, organization scoping, actor attribution and exactly-once emission (phase 12 D4,
  D5, D7).

## Context

The audit trail answers *who did what, to which resource, when* (§1), so a committed change
without its entry is a correctness hole, not a lost debug row. The write path has to reconcile
three unlike situations:

- **Mutations** (payments, refunds, members, invitations, API keys, customers) run inside a
  database transaction that already exists — and Phase 11's post-response best-effort model
  (ADR-0020) explicitly tolerates a missing row, which an audit trail may not.
- **Authentication outcomes** (login, failed login, logout) have *no* transaction to join, and
  a login must not fail because an audit insert failed — availability of the sign-in flow beats
  durability of one entry (§6.2).
- **Authentication has no tenant yet.** `organization_id` is NOT NULL in the contract, a user
  may belong to several organizations, and an unknown-email login has no user and no
  organization at all (F6/F7).
- **Terminal payment edges** (`payment.succeeded`/`payment.failed`) are applied by the worker
  sweep or by read-time catch-up, with no live actor in either case (F8).

## Decision

**Capture through an injectable port: mutations record inside the caller's transaction
(fail-closed), authentication outcomes record best-effort on the capability's own connection,
auth events fan out over the acting user's memberships, and background transitions inherit the
payment's original creator.**

- **Transactional capture (D7).** `AuditLogPort.record(tx, capture)` writes inside the
  transaction the domain module already owns — the payments CAS transaction, the refund balance
  transaction, the Phase 4/5/6 mutation transactions. A failure propagates and rolls the change
  back: there is no committed change without its audit entry (AC4), and an idempotent replay
  (which never re-executes the change) writes no second entry (§4.2 rule 6).
- **Best-effort authentication outcomes (D7).** `user.logged_in` / `user.login_failed` /
  `user.logged_out` are written on the capability's own connection after the outcome is decided;
  a failure is logged with the action, the organization id and the error *class* — never the
  payload — and dropped. The status, body and headers of the auth operation never change, and
  readiness is never coupled to the audit store. `user.registered` is the exception: registration
  is transactional, so its entry joins the registration transaction.
- **Membership fan-out (D4).** §5.2 actions resolve organization scope by querying the acting
  user's memberships at event time: one entry per organization, typically one (ADR-0010), possibly
  several, possibly **zero** — zero memberships yields zero entries rather than an invalid row.
  Failed login for an unknown email records **nothing**: there is no user to attribute and the
  presented email is third-party PII (D13). Failed logins stay bounded by the Phase 3 auth rate
  limits.
- **Background actor attribution (D5).** `payment.succeeded`/`payment.failed` are attributed to
  the payment's original creator, resolved from the `payment.created` entry written with the
  payment — deterministic whether the edge fires in the sweep or in a read catch-up, and never
  the actor of whatever request happened to trigger it. A background edge carries no
  `request_id`. Adding a `system` member to the contract's `actor_type` enum is rejected.
- **Exactly-once emission (§4.2 rule 2).** The entry id is emitter-owned (UUIDv7, ADR-0001) and
  the insert uses `skipDuplicates`, so a retried write inside the same transaction converges on
  one row instead of failing — the Phase 10 §4.3.5 idempotence pattern.
- **Scope from verified context only (§5.6).** Organization and actor come from the guard-resolved
  scope (`authUser`, `apiKey`, membership, project → organization); nothing is re-derived from
  headers or bodies, so an outsider can never steer an entry into a foreign organization.
- **Not events (§4.2 rule 10).** Entries are local inserts: no queue, no signing, no delivery, no
  replay, and the Phase 10 webhook event catalog stays closed.

## Consequences

- Mutation availability stays coupled to the same PostgreSQL that already must be available for
  the change itself — no new infrastructure dependency, no new failure mode class.
- The API surface of the capability is exactly two operations: capture and list. Domain modules
  trigger capture; they never build rows and never decide catalog membership.
- `request_id` on an entry correlates it to the Phase 11 request-log row and the response's
  `X-Request-Id`; background actions deliberately have none (AC6).
- A payment created before this phase exists has no `payment.created` entry to attribute a
  terminal edge to; the edge is logged and skipped rather than recorded under a wrong actor.

## Alternatives rejected

- **Uniform best-effort (Phase 11 style):** rejected — allows committed changes with missing
  entries, unacceptable for an audit trail (D7).
- **Uniform fail-closed:** rejected — a login would fail when the audit insert fails, and auth
  outcomes have no transaction to join.
- **Queue-based writes (BullMQ):** rejected — delivery machinery and new failure modes for
  local inserts that belong in the owning transaction.
- **Platform-global rows for auth events:** impossible — `organization_id` is required and no
  platform surface exists (ADR-0009); recording unknown emails anywhere is rejected as PII
  exposure (D13).
- **`actor_type: system` / null actor for background transitions:** rejected — a contract enum
  change for a cosmetic gain, and misleading next to a stable, known creator (D5).
