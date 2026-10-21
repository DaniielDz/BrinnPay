# ADR-0047: Swagger UI (`/docs`) Serves in Production

- **Status:** Accepted
- **Date:** 2026-10-16
- **Phase:** 21
- **Scope:** The Swagger-in-production posture (D7/Q4, F14) — recorded
  either way so a later phase does not re-litigate it (§15).

## Context

F14: `setupSwagger` mounts Swagger UI unconditionally at `/docs` from the
canonical contract in every environment (`apps/api/src/main.ts`). The
contract itself is public by design since Phase 15 (ADR-0012/ADR-0030: the
canonical `docs/openapi.yaml` backs the public API reference), yet "public
docs" versus "no debug surfaces in production" is a posture decision, not an
implementation detail — Phase 21 builds the first production image, so the
question had to be answered before that image ships. D7/Q4 were escalated,
not assumed.

## Decision

- **D7(a)/Q4: keep serving Swagger UI at `/docs` in production**, exactly as
  today. The canonical contract is public by design, so `/docs` exposes
  nothing the public API reference does not; no code change and no
  environment-conditional Swagger mounting.
- The alternative — disabling Swagger outside development — would be an
  explicit *behavior change* requiring the authority's call and a recorded
  rationale (the public API reference in `apps/web` would remain regardless),
  because removing an existing production surface changes observable behavior
  (§4 rule 1: no product behavior changes in this phase).
- Any future change to this posture must follow the same path: a recorded
  decision with rationale, never a silent production tweak.

## Consequences

- **Positive:** zero code change in Phase 21; one documentation surface
  (`/docs` + the web API reference) generated from the same canonical
  contract (ADR-0030); no divergence between environments to explain in
  Phase 22 staging.
- **Negative:** production exposes an interactive documentation page —
  accepted, since it carries no secrets and no more than the already-public
  contract; deployments that want it off must reverse this ADR explicitly
  (e.g. with a firewall/reverse-proxy rule in Phase 22/24 rather than by
  silently editing application behavior).
- **Neutral:** the OpenAPI contract, versioned routes, and error envelopes
  are untouched (AC6/§12); rate limiting, guards, and request logging on
  `/docs` remain whatever they already are (no bypass added — §8 rule 8).
