# ADR-0037: Security Review Outcome — Accepted-Risk Register and Phase 22/24 Handovers

- **Status:** Accepted
- **Date:** 2026-10-13
- **Phase:** 18
- **Scope:** The consolidated outcome of the Phase 18 security review: which residual
  risks are accepted for the MVP sandbox (with exit criteria), which obligations
  transfer to later phases as deployment facts, and which referrals were re-owned
  (Phase 18 D5/D6/D7, F2, F13, AC10).

## Context

Phase 18 is the first systematic, cross-module security review (Phases 0–17). Its
review catalog (R1–R7) found zero open critical/high findings, but three residual
risks were reaffirmed as accepted rather than fixed, several prior ADRs filed
explicit re-review obligations back to this phase (F2), and Phase 13 D11 left two
availability referrals without a named owner (F13). Without a single binding
record, the next phases would have to re-derive the posture from six ADRs
(ADR-0019, ADR-0023, ADR-0024/0025, ADR-0028, ADR-0032) plus phase handover
sentences.

Constraints:

1. **No control may be weakened to close a finding** (phase spec §4 rule 3) — an
   accepted risk must carry rationale, blast radius, and exit criteria.
2. **The record must be the inheritance point** for Phases 22/24 (deployment),
   Phase 19 (availability), Phase 25 (SECURITY policy), and Phase 26 (sign-off
   QA).
3. **It must not duplicate** `docs/security-review.md` — that document holds the
   full evidence; this ADR is the decision record those chapters bind to.

## Decision

**Adopt the Phase 18 accepted-risk register and handover table as the single
inheritance artifact for post-MVP security posture (D5(a)/D6(a)/D7(a), confirmed
2026-10-13).** The authoritative tables live in `docs/security-review.md` §4
(accepted risks) and §5 (deployment-fact handovers); this ADR records the binding
decisions:

### Accepted residual risks (with exit criteria)

| Id | Risk | Exit criteria |
| --- | --- | --- |
| AR-1 | CSP `script-src 'unsafe-inline'` on the web app (D5; ADR-0028 review item discharged) | Nonce or hash-based CSP in the Next.js rendering path; revisit post-MVP / before production-grade deployment |
| AR-2 | SSRF sandbox posture — permissive private/loopback destinations, host-based allow/deny lists, no DNS-rebinding/TOCTOU mitigation (D6; ADR-0019 reaffirmed) | IP pinning + resolved-address revalidation **before any non-sandbox deployment** (Phases 22/24 obligation) |
| AR-3 | Per-account login lockout DoS via the account-scope rate limit (D7; ADR-0024/0025 reaffirmed) | Revisit with any auth-UX work or before production-grade accounts; remedy needs product design (progressive delay/challenge/per-attacker dimension) |

Each entry was reaffirmed, not invented, in Phase 18: AR-1/AR-2 map to prior ADR
review mandates; AR-3 gives the previously ownerless lockout finding (F5) a home.

### Deployment-fact handovers (Phases 22/24)

ADR-0025's "confirm the values of **each** environment" mandate is discharged as:
confirm what exists (local Compose and CI: `TRUST_PROXY_HOPS=0`, empty
`TRUST_PROXY_CIDRS`; `COOKIE_SECURE`/`WEB_SECURE` production defaults) and specify
what must be set in environments that do not exist yet. The full handover table
(`docs/security-review.md` §5) specifies: real proxy hop count and proxy-only
CIDRs; `COOKIE_SECURE=true` and `WEB_SECURE=true`; secrets injected via Phase 21
(`JWT_SECRET`, `WEBHOOK_ENCRYPTION_KEY`); deliberate webhook destination
allow/deny lists; CORS origins of the deployed dashboard only.

### Re-owned referrals

- **F13 (Phase 13 D11):** the pending-delivery bound per webhook endpoint and
  per-project sweep fairness are availability defects, referred to **Phase 19**
  (performance/load) and the backlog if Phase 19 does not absorb them — named
  owner, not dropped.
- **F6 (Phase 14 §7.6):** the full accessibility audit relocates to **Phase 26
  QA** or a standalone change (D8); the Phase 14 §7.6 baseline remains shipped.
- **F7 (Q1):** custom not-found/error pages remain out of scope — standalone
  `feature/*` or Phase 26 polish.
- **F14:** this phase's ROADMAP.md checkboxes update at merge as a separate
  `chore/*` change.

### Re-review obligations closed

ADR-0023 (audit immutability/tenant cascade), ADR-0025 (proxy trust),
ADR-0028 (header set + CSP), ADR-0032 (outbound delivery markers), Phase 11 (log
redaction), Phase 13 (IP trust), Phases 15–16 (security-sensitive docs/sandbox
parts), and Phase 17 (tooling/test-switch inventory) all mandated a Phase 18
re-review; each is evidenced in `docs/security-review.md` §1/§3 and closed by this
sign-off.

## Consequences

- Phases 19/21/22/24/25/26 inherit one artifact instead of re-deriving posture;
  Phase 26's "security review sign-off" QA item consumes
  `docs/security-review.md` §7 directly.
- AR-1/AR-2/AR-3 are now *tracked* risks with owners and exit criteria, not
  folklore: closing any of them requires updating the register, not archaeology.
- The guard consolidation (D1) intentionally produced **no** ADR: it was a
  behavior-preserving refactor proven by characterization tests; if a future
  review finds a semantic difference that was actually a defect, the fix cites the
  specification that made it one (phase spec §15).
- The register is MVP-scoped: it explicitly does not claim production-grade
  posture; the exit criteria are the bridge to that posture.

## Alternatives rejected

- **No consolidated record — each later phase re-reads the six source ADRs:**
  rejected; it repeats exactly the derivation cost this phase was meant to end,
  and risks a phase missing a mandate (the F2 pattern).
- **Fold the register into ADR-0028 or ADR-0025 as an addendum:** rejected; those
  ADRs are about their own decisions, and grafting cross-cutting risk ownership
  onto them hides the inheritance point.
- **Fix AR-1/AR-2/AR-3 now instead of accepting (D5(b)/D6(b)/D7(b) options):**
  rejected by confirmation 2026-10-13 — each remedy is a scoped project (CSP
  rendering-path change; SSRF hardening mode; auth-UX product design), not
  hardening polish, and none is justified by the sandbox's threat model.
