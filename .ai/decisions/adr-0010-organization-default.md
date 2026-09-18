# ADR-0010: Automatic Personal Organization on Registration

- **Status:** Accepted (direction) — detailed mechanics deferred to Phase 3/4 specifications
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** Registration flow (Phase 3) and Organizations & RBAC (Phase 4).

## Context

The master specification defines Organization as the tenant boundary (owns projects, members, audit entries) and RBAC roles in Phase 4. It does not state how a newly registered user obtains an organization. Without a default, a user registering and arriving at the dashboard would face an empty tenant-less state, complicating onboarding and every subsequent feature (projects, API keys, payments all belong to an organization).

This decision affects the design of Phase 3 (registration/onboarding flow) and Phase 4 (organizations, tenant isolation) directly, so the direction is recorded now.

## Decision

- A registered user **automatically obtains a personal/default organization** during the onboarding flow.
- The organization is owned by the user (owner role) and serves as the initial tenant.
- Detailed mechanics are deferred to the Phase 3/4 specifications: when the organization is created relative to registration (same transaction vs. separate step), its naming/defaults, and any subsequent organization-creation flows.

## Consequences

- Every user always has at least one tenant; dashboard features have a well-defined starting scope.
- Phase 3/4 must specify the mechanics (transactionality, defaults, naming) and test them.
- Multi-organization membership (invitations, multiple orgs) remains supported by the model (OrganizationMember), so the default does not constrain future organization management.