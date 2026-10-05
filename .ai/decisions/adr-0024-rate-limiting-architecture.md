# ADR-0024: Rate Limiting Architecture — Two-Stage Enforcement Over an Atomic Fixed-Window Counter

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** 13
- **Scope:** How the whole API surface is rate limited — the two enforcement points, the closed class
  catalog, the atomic fixed-window counter, hashed key derivation and the fail-open posture
  (phase 13 D2, D5, D7, D8, D13).

## Context

Phase 3 bounded `/auth/*` with a Redis fixed-window counter inside the `auth` module. Six things had to be
settled before that could become an API-wide capability:

1. **Where the IP check can live.** The API key identity only exists *after* authentication resolves it, so
   a single global guard cannot key on it. Two facts pull in opposite directions: the limiter must precede
   authentication (otherwise an unauthenticated flood costs a database lookup per request), and it must
   follow it (an API-key budget is meaningless without a key).
2. **What the endpoint-specific policy is.** A limit per operation is 46 arbitrary numbers with no product
   input and a permanent maintenance burden; one global limit does not meet the requirement at all.
3. **What counts.** Whether validation, authentication, authorization and idempotent replays consume budget
   decides whether the limiter is any use against a flood — most requests in a flood *fail*.
4. **Where the window lives.** Headers must report a reset without a second Redis round trip, and two
   concurrent first-requests must never both be admitted as the first of a window.
5. **What happens when Redis is down.** A sandbox should not trade availability for enforcement, but an
   unbounded in-process fallback can be grown into a memory exhaustion vector by an attacker.
6. **Who may write to a bucket key.** A key that contained an IP address, an email or an API-key id would
   leak identities into Redis, into backups and into any tooling that reads them.

## Decision

**One cross-cutting `rate-limiting` capability: a closed class catalog, a two-stage enforcement order, an
atomic fixed-window counter over Redis keyed by an opaque hash, and a fail-open default.**

- **One capability, two enforcement points (D7).** A global `APP_GUARD` stages the `ip` budget for every
  request under the API prefix, so it runs before any route authentication. A per-route `ApiKeyRateLimitGuard`
  stages the `api_key` budget on the dual-mode project routes, registered *after* the existing access guard,
  so it runs only once a key has resolved. Neither domain guard was modified: the stage-2 guard is a second
  guard on the same route. The third dimension (`account`) stays where the domain knowledge is — the
  `auth` module's guard consumes the shared capability and supplies the normalized email.
- **The catalog is the policy (D6).** Every operation maps to exactly one of seven classes — `auth.*`
  (carried over unchanged from Phase 3), `read`, `write`, `webhook.replay`, `webhook.endpoint-create` — each
  with its scopes and its configured limit. Adding a class is an amendment to the specification, never an
  ad hoc per-controller limit. A route that declares no class fails loudly at enforcement time, mirroring
  the `@RequireCapability` precedent: "unlimited" is always an explicit, reviewable choice.
- **Every attempt counts (D10).** Validation, authentication, authorization, business-rule failures and
  idempotent replays all consume budget; only preflight, health, Swagger and non-prefix traffic is excluded,
  and that exclusion is decided from the path and method before any Redis work.
- **Atomic fixed window (D2).** One Lua script does `INCR`, sets `EXPIRE` on the first hit, and returns the
  remaining `TTL` — so the count and the reset come from one round trip, no request can observe a count
  without a TTL, and two concurrent first-requests cannot both open the window. A sliding window or token
  bucket would be more accurate and materially more expensive in Redis memory and operations; the accuracy of
  a fixed window is acceptable for a sandbox.
- **Opaque keys (rule 5).** The key is `SHA-256` over (scope, normalized discriminator, class, window length)
  under one namespaced, versioned prefix, with a control character as the tuple separator so no combination
  of parts can be re-partitioned into a different tuple. Every key carries its window as a TTL, so Redis
  memory is bounded by distinct clients × classes within the window and no cleanup job exists.
- **Fail open, bounded (D8).** A Redis error degrades enforcement to an in-process fixed window capped at
  10,000 entries (expired entries dropped first, then oldest) with a single non-identifying warning per
  degradation episode, and never becomes a `5xx`; `RATE_LIMIT_FAIL_MODE=closed` rejects with `429` for
  deployments that prefer enforcement. Readiness is untouched either way: the limiter adds no dependency of
  its own to the health contract.
- **Throttled is still a request (D13).** A `429` produces a Phase 11 request-log row and no Phase 12 audit
  entry, and its `details` carry budget numbers only — never a scope, a class name or an identity.

## Consequences

- The limiter is one Redis command on the request path, bounded by an explicit command timeout so a slow
  Redis surfaces as a fast failure (and therefore the documented degraded posture) rather than as added
  latency on every request.
- `auth.rateLimits` keeps the `AUTH_RATE_LIMIT_*` names and values (D9); the new classes read `RATE_LIMIT_*`.
  Renaming the Phase 3 variables would break deployed configuration, which `AGENTS.md` forbids without a
  specification change.
- Because `auth` now consumes the shared capability, `AuthModule` imports `RateLimitingModule`. The webhook
  worker imports `AuthModule` for the session guard, so its module graph transitively contains the limiter's
  services. They are inert there: the worker serves no HTTP traffic, resolves no routes, and therefore runs
  no enforcement point (§4.2 rule 7 is satisfied in behavior, not by graph exclusion).
- The reported budget is the bucket closest to exhaustion (D4), which is the only choice that never promises
  headroom on a request about to be rejected. The cost is that the header set is not simply "the API key's
  budget", so the conventions must state the rule.
- Phase 14 must present `429` as retryable rather than as an authorization or data failure; the CORS
  exposure of the four budget headers is what lets it show a remaining-budget indicator. Phase 15 consumes
  the §6.2 table as its source. Phase 16 must keep sandbox scenarios inside the limits. Phase 19 must set
  its own limits for load tests and measure F12's request-log write amplification. Phase 20 owns throttled-
  request, per-class-exhaustion and degraded-mode metrics.
- Two properties of the result are accepted rather than solved here, and each is recorded so a later phase
  owns the remedy explicitly:
  - **Login lockout is per-account.** The `account` scope is charged on the submitted email before the
    request is validated, so an unauthenticated caller who can guess an address spends its budget and keeps
    it spent, and the real owner then sees `429` for the rest of the window. That is the intended cost of
    denying an attacker unlimited attempts against one account; nothing distinguishes the two. A phase that
    owns the auth experience (progressive delay, challenge, or a per-attacker dimension) would own the
    remedy. Documented in `api-conventions.md` §10.5.
  - **Unmatched paths cost nothing but a request-log row.** A request under `/api/v1` that matches no route
    returns `404` without consuming budget, because no guard can run for a route that was never matched,
    while still being request-logged. It does no handler work, so it is amplification of Phase 11's writes
    rather than of any bounded resource — referred to Phases 19/20 with F12 in the specification's §16
    coordination obligations.

## Alternatives rejected

- **One global guard only:** rejected — it cannot key on the API key, so the API-key requirement fails.
- **Domain guards calling the limiter:** rejected — couples domain guards to a cross-cutting concern and
  forks the policy into every module.
- **An interceptor for the API-key stage:** viable (interceptors do not run when a guard rejects, which is
  acceptable here), but the guard-based point is simpler to reason about and to test.
- **Per-operation limits:** rejected — 46 arbitrary numbers with no product input.
- **A single global limit:** rejected — does not meet the endpoint-specific requirement.
- **Published tiers copied from an external product:** rejected — adopting another product's numbers without
  product input is not a decision this project can make.
- **Sliding window / token bucket / GCRA:** rejected for now — materially more Redis memory and operations
  for accuracy that a sandbox does not need; a second window is an amendment, justified only if Phase 19/20
  demonstrates a need.
- **Separate read-then-write steps:** rejected — a race that can admit more than `limit` requests per window.
- **Legacy `X-RateLimit-*` names, or emitting both:** rejected — the published standard fields are the
  requirement, and duplicated names diverge semantically.
- **Fixed scope precedence in the headers:** rejected — it can report a comfortable budget while the other
  scope is nearly exhausted.
- **A session-user or per-organization dimension:** rejected — a shared NAT egress would throttle unrelated
  dashboard users, credential attacks are already covered per account, and per-organization limits are a
  tenant-quota feature with no roadmap basis.
- **Fail closed only:** rejected — a Redis outage would become a full API outage.
- **An unbounded fallback map:** rejected — attacker-controlled memory growth.