# ADR-0029: Documentation Authoring Strategy — TSX Content in `apps/web`, Re-authored for a Public Audience

- **Status:** Accepted
- **Date:** 2026-10-06
- **Phase:** 15
- **Scope:** How the public documentation area (`/docs/**`) is authored and related to
  the repository's canonical artifacts (Phase 15 D1, §15; F2/F4).

## Context

Phase 15 ships the first long-form content in `apps/web`. Three candidate approaches
existed, and the choice had to respect two hard constraints: the repository-root
`docs/*.md` files are **architecture artifacts**, and the master specification forbids
new packages without a concrete need.

1. **Root `docs/*.md` are internal.** `docs/api-conventions.md`, `docs/security-baseline.md`
   and the phase/ADR corpus reference internal decisions, operator configuration (proxy
   trust, Redis fail-open posture), and phase/ADR numbering. Rendering them wholesale
   would publish internal material on a public route (Phase 15 F2, §11.2).
2. **No authoring tooling exists in `apps/web`.** There is no markdown/MDX pipeline;
   pages are TSX modules imported directly by the vitest+RTL suites (Phase 15 F4).
3. **Docker dev mounts cover `apps/web/{app,components,lib,styles}` only.** Reading
   content from outside `apps/web` at build/dev time would require mount and Dockerfile
   changes (Phase 15 F8, §17).
4. **Accuracy is a hard rule.** Guides must cite one canonical source per fact and must
   not drift from the contract (§5.1, D8).

## Decision

**Documentation content is authored as TSX pages/components inside `apps/web`, re-authored
for a public audience, citing the canonical artifacts as sources — never rendering the
root `docs/*.md` files directly.**

- **Content lives with the app:** every guide is a route module under
  `apps/web/app/docs/**` (with shared presentational components for code blocks, callouts,
  and section navigation). Zero new dependencies, no build configuration, and the existing
  test/import patterns apply unchanged (consistent with ADR-0026's tooling stance).
- **Re-author, don't republish:** prose is written for developers integrating BrinnPay.
  Phase numbers, ADR numbering, decision histories, and operator-only configuration are
  not published (§5.1 rule 3, §11.2).
- **Citation, not coupling:** each guide states (in prose or a visible source note) the
  canonical artifact it derives from — `docs/openapi.yaml`, `docs/api-conventions.md`, or
  the named phase/ADR — so a reader can trace the fact and a reviewer can verify it.
- **Consistency is enforced, not assumed:** the small set of shared numeric/behavioral
  facts (retention windows, retry ladder, rate-limit defaults, error-code list) is guarded
  by automated checks comparing guides against their canonical source (D8 confirmed (a)).
- **MDX remains available later:** if content volume makes TSX unmanageable, an MDX
  pipeline can be adopted incrementally; this ADR fixes what Phase 15 ships, it does not
  forbid it.

## Consequences

- No dependency or build-pipeline risk; `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build` behave exactly as before for content changes.
- Docker mounts and `docker/web/Dockerfile` need no change for content (the contract
  import of D2 is build-time and covered separately by Phase 15 §17).
- Prose lives next to the tests that assert it, so an acceptance criterion (§12.4) and
  its content update ship in the same diff.
- The drift risk between three repeating surfaces (contract, conventions, guides) is real
  and is mitigated by D8's automated checks plus human review — not by sharing source
  files, which would publish internal material.
- Content edits require app-code review rather than docs-only review; acceptable for an
  MVP-scale docs area.

## Alternatives rejected

- **MDX/markdown pipeline in `apps/web`:** viable long-term ergonomics, but adds a
  dependency plus build/test configuration for the first content drop; deferred until
  volume justifies it.
- **Build-time rendering of root `docs/*.md`:** rejected — publishes internal artifacts
  (phase/ADR references, security-baseline internals) and couples the public site to
  architecture documents (F2). A sanitized subset would still require a second
  "public-safe" version of those files, which is the re-authoring decision by another
  name.
- **Rendering the canonical contract's prose as guides:** rejected — the contract is an
  API reference (ADR-0012), not an integration guide; conflating them would make
  non-breaking contract edits (D7) silently change public guide content.
