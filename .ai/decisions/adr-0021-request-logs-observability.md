# ADR-0021: Request Logs Are Observability, Not Domain Data

- **Status:** Accepted
- **Date:** 2026-10-01
- **Phase:** 11
- **Scope:** Where the `request_logs` entity sits in the architecture and who may read it
  (phase 11 F5, D1, D2, F6).

## Context

The table is **API-wide**: public, session and API-key requests all produce rows, including
`/auth/*` traffic that has no project at all. The contract, however, declares exactly one read
surface — `GET /projects/{project_id}/logs/requests` — and the capability registry has no logs
capability yet (F2).

Two questions follow, and they are architectural rather than cosmetic:

1. **Which module owns the entity?** Domain modules (`payments`, `webhooks`, …) are the wrong
   owner: capture is driven by the application request lifecycle, not by a domain operation, and
   `docs/domain-model.md` §3 classifies request logging as application-level.
2. **Who may read it?** The domain resources are dual-mode (session *or* `sk_…` API key) via the
   shared `ProjectAccessGuard`. Request logs are a debugging surface over metadata that includes
   which routes a team calls and when — authority for that must not ride along with a programmatic
   credential.

## Decision

**A cross-cutting `request-logging` capability module owns capture, persistence and the read
surface; the read surface is session-only and covered by a new `logs.read` capability granted to
every role.**

- **Module boundary (§4.1).** `request-logging` is imported once at the application root. Domain
  modules never write rows and never import it; the module reads only context the guards already
  attached (`authUser`, `project`, `organizationMembership`, `apiKey`) and never re-queries for
  scope. It emits **no events** — the webhook event catalog stays closed (phase 10 §4.2).
- **API-wide store, project-scoped surface (F5).** Non-project records are stored but deliberately
  unexposed in v1; adding an endpoint for them would be a contract change, not an implementation
  detail.
- **Session-only authority (F6).** The route uses the Phase 5 pattern — `SessionAuthGuard` +
  `ProjectRbacGuard` + `@RequireCapability` — and *not* the dual-mode `ProjectAccessGuard`. An
  `sk_…` bearer fails in `SessionAuthGuard` with the same generic `401` an anonymous request gets,
  before any capability is evaluated and before any record is read. API keys never carry
  management/observability authority (phase 1 §7.3).
- **`logs.read` for all four roles (D2).** Records contain metadata only, so they follow the
  read-for-every-role pattern of Phases 5–10; the owner/admin-only alternative (the
  `invitations.read` precedent) is rejected and recorded here. The capability lives in
  `organizations/roles.ts` — the single source of truth — and the controller derives nothing from
  a string literal.
- **Environment on the record (D1).** A nullable `environment` column: always the key's
  environment in API-key mode, and the *validated query parameter* in session mode. Request bodies
  are never read to build a record (§14), so a create whose environment travels in the body is
  recorded with `environment: null` and is returned when no environment filter is applied.

## Consequences

- Adding a reader to this surface is a one-line registry change with a test, not a new auth mode.
- Cross-project reads are unreachable: rows are selected by the project the guard resolved, and
  cursors are constrained to that project's rows, so cursor manipulation cannot cross a tenant
  boundary.
- The list has exactly two filters (`environment`, `request_id`). New filters (`method`,
  `status_code`, date ranges) are contract additions requiring their own decision.
- Retention, the `logs.read` matrix and the request-id scheme are the facts Phase 15 documentation
  has to publish; nothing else in this module leaks into the developer-facing surface.

## Alternatives rejected

- **Dual-mode access via `ProjectAccessGuard`:** rejected — an API key would gain an
  observability read it has no business having (F6).
- **Owner/admin-only matrix:** rejected — the content carries no secrets or bodies and is a
  routine debugging surface for every team role (D2).
- **Exposing non-project (auth, organization, public) records:** rejected — the contract does not
  declare such an endpoint in v1 (F5).
