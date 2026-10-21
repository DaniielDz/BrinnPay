# Phase 13 — Rate Limiting

| | |
| --- | --- |
| Phase | 13 — Rate Limiting |
| Status | **Confirmed — D1–D13 approved and open questions Q1–Q5 resolved by the product authority on 2026-10-02 (§13). Implementation-ready.** |
| Depends on | Phase 1 (contract, conventions, security baseline), Phase 2 (Redis, error envelope, request IDs, global prefix/validation bootstrap), Phase 3 (`AuthRateLimitService`/`AuthRateLimitGuard` — the capability this phase generalizes; auth limits and their env names), Phase 4 (org endpoints, 429 activation handover), Phase 5 (API keys and `ApiKeyContext` — the second limit dimension; 429 activation handover), Phase 6 (dual-mode project access guard), Phase 7 (payments, 429 activation handover), Phase 8 (idempotent replays are countable requests), Phase 10 (replay amplification and endpoint-cap carry-overs), Phase 11 (request logs record throttled requests), Phase 12 (429 writes no audit entry) |
| Blocks | Phase 14 (dashboard 429 surfacing), Phase 15 (rate-limit guide consumes §6), Phase 16 (sandbox scenarios must not be throttled), Phase 18 (security hardening review), Phase 19 (load testing configures limits), Phase 20 (throttling metrics) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 13 |

## 1. Objective

Protect the **whole** API surface with configurable rate limits and make the resulting
behavior observable and contractible:

1. **IP-based rate limiting** — every request under the API prefix consumes a per-client
   budget, including unauthenticated traffic, so credential-guessing and scraping floods are
   bounded before any authentication work happens.
2. **API-key-based rate limiting** — every API-key-authenticated request also consumes a
   per-key budget, so one tenant cannot exhaust another tenant's capacity and a leaked key
   has a blast radius.
3. **Endpoint-specific limits** — each operation belongs to a closed, reviewable class with
   its own limit; expensive/amplifying operations (webhook replay, endpoint registration)
   are capped separately from ordinary reads and writes.
4. **Rate limit headers** — every limited response reports the applicable budget and, on
   `429`, when to retry, using published standard header names.
5. **Documented behavior** — the policy is recorded in the canonical contract and the API
   conventions, and handed over as the authoritative source for the public developer guide
   (Phase 15).

The Phase 3 position is preserved: auth endpoints were already limited, and this phase
**generalizes and extends** that capability rather than replacing its behavior.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| IP-based rate limiting | §4.2 (scopes), §4.3 (stage 1), §5 |
| API key-based rate limiting | §4.2 (scopes), §4.3 (stage 2), §5 |
| Endpoint-specific limits | §4.2 (route-class catalog) |
| Rate limit headers | §4.4 |
| Rate limit behavior documented in developer documentation | §6.3, §7, §13 (D12) |

## 2. Scope

In scope:

- A cross-cutting **`rate-limiting`** capability module in `apps/api`, promoted out of the
  `auth` module into the cross-cutting layer `docs/domain-model.md` §3 already names as the
  home for rate limiting ("Cross-cutting capabilities — `idempotency`, `request-logging`,
  `audit-logging`, rate limiting, request validation, and request IDs — are application-level
  concerns shared by all modules").
- The generalized counter capability: scopes, route classes, windows, key derivation,
  atomicity, and the failure posture.
- The IP enforcement point that applies to every request under the API prefix, before route
  authentication runs.
- The API-key enforcement point that runs once a key has been resolved, on the dual-mode
  project routes.
- Response headers on limited routes (`RateLimit-*` on every response, `Retry-After` on
  `429`), including exposing those headers to cross-origin browser clients via the CORS
  response (§4.4 point 6).
- Environment-driven configuration with boot-time validation, preserving the Phase 3
  variables.
- Contract refinements in `docs/openapi.yaml` (ADR-0012): the limit headers and the `429`
  semantics. No new API version.
- A rate-limit section in `docs/api-conventions.md` — the authoritative policy source handed
  to Phase 15.
- Discharge of the handover obligations recorded by Phases 3, 4, 5, 6, 7, 10, 11 and 12
  (§11).

Explicitly **not** extended here: payment/refund/customer/webhook domain rules, the webhook
event catalog and retry ladder, request-log and audit-log semantics, idempotency behavior,
metrics/alerting, and any change to the Phase 3 auth limits' *values*.

## 3. Context and current-state findings

**What exists today**

- `apps/api/src/auth/rate-limit.service.ts` (`AuthRateLimitService`), `rate-limit.guard.ts`
  (`AuthRateLimitGuard`) and `rate-limit.decorator.ts` (`@AuthRateLimit(kind)`) implement
  Phase 3 D7: a Redis fixed-window counter (`INCR` + `EXPIRE` on first hit, one Lua round
  trip) keyed by **SHA-256 of a discriminator**, with an in-process fallback when Redis is
  unreachable, returning 429 `RATE_LIMITED` through the canonical envelope.
- `AuthController` applies `@UseGuards(AuthRateLimitGuard)` at the class level with kinds
  `session-creation`, `refresh`, `read`, `none`. Limits come from
  `auth.rateLimits` (`AUTH_RATE_LIMIT_WINDOW_SECONDS`, `AUTH_RATE_LIMIT_IP_LOGIN_MAX`,
  `AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX`, `AUTH_RATE_LIMIT_IP_REFRESH_MAX`,
  `AUTH_RATE_LIMIT_IP_READ_MAX`) — defaults 900 s window, 10/10/60/100.
- `ApiKeyAuthGuard` resolves `Authorization: Bearer sk_…` and attaches
  `request.apiKey: { key_id, project_id, organization_id, environment }`; the dual-mode
  `ProjectAccessGuard` (Phase 10) delegates to it for project-scoped routes.
- `ErrorCode.RATE_LIMITED` and the `429` mapping in `ApiExceptionFilter` exist; the contract
  already declares a `RateLimited` response on **every** operation (46 references) and
  `docs/api-conventions.md` §6 lists 429 as a general status.
- `RedisService` is available application-wide with `maxRetriesPerRequest: 1` and a 1.5 s
  ping timeout; `RequestLoggingMiddleware` (Phase 11) records every request under the API
  prefix on `finish`, including `429`s; Phase 12 records **no** audit entry for a `429`.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | Rate limiting lives inside the `auth` domain module and is class-scoped, so no other module can consume it — contradicting `docs/domain-model.md` §3 and phase 1 §162 (cross-cutting, not coupled to one module). | §4.1 — one `rate-limiting` capability; the auth guard becomes a consumer of it with unchanged behavior. |
| F2 | The existing counter returns only `{ allowed, remaining }`; the window's TTL is never read, so no reset time or retry hint can be produced without a second round trip. | §4.2 — the atomic script returns count **and** remaining TTL in one round trip (D2). |
| F3 | No `X-RateLimit-*`/`Retry-After` header is emitted anywhere; the `RateLimited` contract response declares only `X-Request-Id`. Phases 3/4 handover notes require "standard rate-limit headers". | §4.4 + §6.3 (D3, D4). |
| F4 | The `429` responses already declared across the contract are inert today; Phases 4/5/6/7 each recorded "Phase 13 activates the contract's 429 responses". | §4.3 — this phase makes them effective for all routes. |
| F5 | **Client IP is unresolved.** `request.ip` is used and Express `trust proxy` is configured nowhere. Behind the Phase 22/24 load balancer every client shares one bucket (functional failure), while trusting `X-Forwarded-For` blindly lets a caller forge arbitrary IPs and evade every IP bucket (security failure). | D1 — explicit, env-driven trust model plus discriminator normalization (IPv4-mapped IPv6, case, zone ids). |
| F6 | The API-key identity is only available **after** `ApiKeyAuthGuard`/`ProjectAccessGuard` resolves it, so a single global guard cannot key on it; and `ApiKeyContext.key_id` must never appear un-hashed next to Phase 3's hashed keys. | §4.3 two-stage enforcement (D7); §4.2 key derivation hashes the tuple (D2). |
| F7 | Nothing classifies routes. Phases 4/5/6/7/10/11/12 each explicitly declined to add ad hoc limits and deferred them here, so the classification must be introduced once, centrally, and be closed. | §4.2 route-class catalog (D6). |
| F8 | Phase 10 D16 and its security review defer **abuse-prevention** items to this phase: unbounded webhook replay, no per-project endpoint quota, and a note that the cross-project sweep fairness defect is *not* covered by a rate-limiting mandate. | D11 — replay and endpoint-creation caps expressed as route classes; pending-delivery bound and sweep fairness referred onward. |
| F9 | Counting semantics are undefined: whether validation (400), authentication (401), authorization (403/404) and idempotent replays consume budget, and whether CORS preflights/health probes/Swagger traffic do. | §4.2 rule set (D10). |
| F10 | Redis unavailability silently degrades to a per-process counter: no log beyond the first warning, no cap on the fallback map, and no way for an operator to demand strict enforcement. | §4.5 + D8 (bounded fallback store, strict mode, readiness unaffected). |
| F11 | The limiter adds a Redis round trip to every API request, and `RedisService` has no command timeout — a slow Redis would convert into added latency on every request rather than a failed limit. | §15 — bounded command timeout; D8 posture. |
| F12 | Phase 11 persists a request-log row per request and Phase 12 writes none for `429`s, so a flood converts into a flood of database inserts. | §8 — throttled requests remain request-logged (D13); write amplification referred to Phases 19/20. |

## 4. API application — `apps/api`

### 4.1 Module purpose and boundaries

One cross-cutting `rate-limiting` capability owns:

1. **Policy** — the closed catalog of route classes with their limit and window (§4.2), and
   the configuration that supplies them (§5).
2. **Accounting** — the atomic counter over Redis, keyed by an opaque hash of
   (scope, discriminator, class, window) (§4.2).
3. **Enforcement** — the IP enforcement point that precedes authentication and the API-key
   enforcement point that follows it (§4.3).
4. **Reporting** — the `RateLimit-*`/`Retry-After` headers and the `429` envelope (§4.4).

Boundaries (`docs/domain-model.md` §4):

- Domain modules (`auth`, `organizations`, `projects`, `api-keys`, `customers`, `payments`,
  `refunds`, `webhooks`) **declare** the class of their operations and never compute a limit,
  a window, a Redis key, or a header. They never import Redis for throttling.
- The capability reads only context the request already carries: the client IP (or the
  configured client-identity resolution, D1) and `ApiKeyContext` once resolved.
- The capability does **not** authenticate, authorize, or validate. It never turns a `401`
  into a `429` or the reverse, and it never runs a database query.
- The webhook **worker** process registers no limiter: it serves no HTTP traffic (§4.3 rule 7).
- Request logging (Phase 11), audit logging (Phase 12) and stdout logging (Phase 2) are
  separate concerns; throttling is observable **through** the request log, not by writing to it.

### 4.2 Domain rules

1. **Scopes (limit dimensions).** Exactly three, each optional per route class:

   | Scope | Discriminator | Available | Purpose |
   | --- | --- | --- | --- |
   | `ip` | Normalized client identity (D1) | Every request under the API prefix | Bounds unauthenticated floods and shared-origin traffic. |
   | `api_key` | The resolved key's `key_id` (never the presented plaintext, ADR-0006/ADR-0014) | Only after a key resolves | Tenant-isolated budget; bounds the blast radius of a leaked key. |
   | `account` | Normalized account email | Only on auth session-creation routes | Pre-existing Phase 3 dimension for credential stuffing. |

   No user/session/organization dimension is introduced (D5).

2. **Route classes (endpoint-specific limits).** Every contracted operation maps to exactly
   one class from a **closed** catalog. The catalog — not the numeric values — is the
   endpoint-specific policy; adding a class is an amendment to this section, never an ad hoc
   per-controller limit (F7, D6). Confirmed catalog and numbers:

   | Class | Routes | Limit / window | Scopes | Rationale |
   | --- | --- | --- | --- | --- |
   | `auth.session-creation` | `POST /auth/register`, `POST /auth/login` | 10 / 900 s (**unchanged**, Phase 3) | `ip`, `account` | Credential stuffing; already proven. |
   | `auth.refresh` | `POST /auth/refresh`, `POST /auth/logout` | 60 / 900 s (**unchanged**) | `ip` | Cookie-bound credential already limits abuse. |
   | `auth.read` | `GET /auth/me` | 100 / 900 s (**unchanged**) | `ip` | Cheap read. |
   | `read` | every other contracted `GET` | 600 / 60 s | `ip` | Must stay generous: the dashboard paginates and Phase 19 will load-test it. |
   | `write` | every other contracted `POST`/`PATCH`/`DELETE` except the two below | 120 / 60 s | `ip`, `api_key` | Mutations are the expensive, state-changing operations. |
   | `webhook.replay` | `POST /projects/{project_id}/webhook-endpoints/{endpoint_id}/events/{event_id}/replay` | 20 / 300 s | `ip`, `api_key` | F8: replay is a deliberate outbound amplifier. |
   | `webhook.endpoint-create` | `POST /projects/{project_id}/webhook-endpoints` | 10 / 3600 s | `ip`, `api_key` | F8/D16: each endpoint adds an in-transaction fan-out row. |

   A class may be declared per route or per controller; the mapping is reviewable in one
   place and every contracted operation resolves to exactly one class. A route with no
   declared class is a programming error, mirroring the Phase 10/Phase 4 precedent that a
   guarded route must declare its requirement.

3. **Windows.** A fixed window per class, env-driven (§5). The window is anchored at the
   **first** counted request in that window, not at a calendar boundary, and the counter is
   authoritative in Redis so replicas cannot disagree (D2).

4. **Atomicity.** Counting, window creation and reading the remaining TTL happen in a single
   atomic Redis operation. Two concurrent requests can never both be admitted as the first
   request of a window, and no request can observe a count without a TTL. Counters are
   never read and then written as two steps.

5. **Key derivation.** Every bucket key is an **opaque hash** (SHA-256, Phase 3 precedent)
   over the tuple (scope, normalized discriminator, class, window length), namespaced and
   versioned under a single prefix. No raw IP address, email address, API key, API-key id,
   path, or user agent may appear in a Redis key. Every key carries an expiry equal to its
   window, so Redis memory is bounded by distinct clients × classes within the window and no
   cleanup job is required.

6. **What counts (D10).** A request that reaches the limiter consumes one unit of **every**
   applicable scope of its class — including requests that are subsequently rejected with
   `400`, `401`, `403`, `404`, `409`, `422` or `5xx`, and including Phase 8 idempotent
   replays. Excluded before any counting: CORS preflight `OPTIONS`, health probes, Swagger
   UI traffic, and anything outside the API prefix. A `429` costs exactly the unit of the
   attempt that produced it.

7. **Process coverage.** The limiter is active in the API process only. The webhook worker
   (`worker.ts`) performs no HTTP requests and registers no limiter.

### 4.3 Enforcement order and API behavior

| Stage | Applies to | Behavior |
| --- | --- | --- |
| 0 — exclusions | Preflight, health, Swagger, non-API paths | Decided from the request path/method alone, before any Redis work. Never counted, never throttled. A health probe must never receive a `429` — a throttled readiness probe would remove a healthy instance from rotation, which is a self-inflicted outage. |
| 1 — `ip` dimension | Every request under the API prefix | Runs **before** any route authentication, so unauthenticated floods are bounded without a database lookup. On exhaustion → `429`. |
| 2 — `api_key` dimension | Dual-mode project routes, only once a key resolved | Runs **after** the access guard has attached `ApiKeyContext`. In session mode there is no `api_key` bucket and stage 1 alone applies (D5). On exhaustion → `429`. |
| 3 — route | Everything else | Unchanged handler behavior. |

Ordering rules:

- Within one request, stage 1 is evaluated before stage 2: the IP check is the cheaper check
  and the one that protects shared infrastructure.
- The limiter never runs after a handler has produced a response; it cannot convert a
  successful operation into a `429`.
- `429` responses use the canonical envelope with `code: RATE_LIMITED`, status **429**, and
  the ingress-assigned `X-Request-Id` — identical to the Phase 3 behavior, plus headers.
- No new error code is introduced. A throttled request is still a request: it produces a
  Phase 11 request-log row and **no** Phase 12 audit entry (D13).
- Idempotent replays are throttled like any other request; a `429` stores nothing for Phase 8
  (only committed successes are replayable), so the key stays usable.

### 4.4 Response headers

1. **On every response of a limited route** — allowed or rejected — the response reports the
   applicable budget:

   | Header | Meaning |
   | --- | --- |
   | `RateLimit-Limit` | The limit value of the reported bucket |
   | `RateLimit-Remaining` | Units left in the current window |
   | `RateLimit-Reset` | Delta-seconds until the current window resets |

2. **On `429` only**: `Retry-After`, an integer delta-seconds until the reported bucket's
   window resets. Derived from the same atomic counter read, so it is never guessed and
   never a negative or zero value.

3. **Which bucket is reported (D4).** When more than one scope applies, the header set must
   be deterministic. Confirmed: report the bucket closest to exhaustion (lowest remaining,
   with a fixed scope tie-break), so a developer is never told there is headroom on a request
   that is about to be rejected. Recorded alternative: fixed scope precedence
   (`api_key` before `ip`).

4. Header names are the published standard forms (`RateLimit-Limit`, `RateLimit-Remaining`,
   `RateLimit-Reset`) plus `Retry-After`, per D3. The legacy `X-RateLimit-*` names are not
   assumed.

5. Headers never disclose the discriminator, the key, the Redis key, or the internal class
   name beyond what the contract documents. Any `details` payload on the `429` envelope is
   limited to budget numbers (`limit`, `remaining`, `window_seconds`) and never to an
   identity (D13).

6. **Browser visibility (Q3, resolved).** The limit headers must be readable by
   cross-origin browser JavaScript, so the CORS response exposes them: `RateLimit-Limit`,
   `RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After` are listed in
   `Access-Control-Expose-Headers` on API responses. Without this the dashboard cannot show
   a remaining-budget indicator, which is the reason the question was raised. Only these
   non-secret budget fields are exposed — exposing the header is a visibility change, not a
   disclosure of internal policy beyond what §4.4 already permits, and it grants no access to
   any identity, key or internal name.

## 5. Configuration

- A new environment-driven configuration section owns the policy. Every number is a
  configured value, never a literal in code, so tests, the sandbox, staging and production
  can differ without a rebuild (Phase 3 D7 rationale, Phase 11 D5 precedent).
- **Boot-time validation**, following the Phase 11 precedent: a non-integer or non-positive
  limit/window fails at boot rather than becoming runtime behavior. The limiter never
  silently disables itself because of a typo.
- **Phase 3 continuity (D9).** The existing `AUTH_RATE_LIMIT_*` variables keep their exact
  names, defaults, and meaning, and continue to govern `auth.*` classes. Renaming them would
  break deployed configuration, which `AGENTS.md` forbids without a specification change.
- No secret is involved: rate-limit configuration is non-secret operational tuning.

## 6. Data requirements summary

- **No database change.** No table, column, index or migration (ADR-0011 untouched). All
  limiter state is ephemeral Redis state with a window-scoped expiry.
- **No new domain entity**, hence no new row in `docs/domain-model.md` §2/§5; the
  cross-cutting capability is named in §3 already. If the fallback in-process store is kept,
  its memory is bounded (F10).
- **No webhook events, no queue usage, no audit-log changes, no request-log schema change.**

### 6.1 Data requirements

| Requirement | Statement |
| --- | --- |
| Storage | Redis only. The limiter performs no PostgreSQL access. |
| Key material | SHA-256 of a namespaced, versioned tuple; no raw IP, email, API key, key id, path or user agent (rule 5). |
| Expiry | Every counter key expires with its window; no cleanup job; no unbounded growth. |
| Clock | The window is owned by Redis (TTL); the API's clock only formats `RateLimit-Reset`, so clock skew between replicas cannot desynchronize buckets. |
| PII | No IP address, email or key identity is persisted by the limiter, logged by it, or added to request-log or audit records (§8). |

### 6.2 Configuration requirements

| Class | Limit | Window | Env var |
| --- | --- | --- | --- |
| `auth.session-creation` (`ip`) | 10 | 900 s | `AUTH_RATE_LIMIT_IP_LOGIN_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECONDS` (unchanged) |
| `auth.session-creation` (`account`) | 10 | 900 s | `AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX` (unchanged) |
| `auth.refresh` (`ip`) | 60 | 900 s | `AUTH_RATE_LIMIT_IP_REFRESH_MAX` (unchanged) |
| `auth.read` (`ip`) | 100 | 900 s | `AUTH_RATE_LIMIT_IP_READ_MAX` (unchanged) |
| `read` | 600 | 60 s | `RATE_LIMIT_READ_MAX` / `RATE_LIMIT_WINDOW_SECONDS` |
| `write` | 120 | 60 s | `RATE_LIMIT_WRITE_MAX` / `RATE_LIMIT_WINDOW_SECONDS` |
| `webhook.replay` | 20 | 300 s | `RATE_LIMIT_WEBHOOK_REPLAY_MAX` / `RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS` |
| `webhook.endpoint-create` | 10 | 3600 s | `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX` / `RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS` |
| Behavior | fail-open (default) or fail-closed | — | `RATE_LIMIT_FAIL_MODE=open\|closed` (D8) |
| Client identity | direct socket peer, or trusted proxy chain | — | `TRUST_PROXY_HOPS` / `TRUST_PROXY_CIDRS` (D1) |

The table's **numbers are confirmed** (D6, approved 2026-10-02): they were reviewed and
adopted as the sandbox defaults. They are generous by design — a sandbox whose own developer
cannot run a payment/retry/replay loop is not usable — and the sandbox/staging values are the
ones documented for developers. They remain configurable, so raising them later is an
environment change and never a code change; Phase 19/20 may revisit them if load tests show
otherwise.

### 6.3 Contract and documentation requirements

- `docs/openapi.yaml` (ADR-0012, refined in place, no new version): define the limit headers
  once in `components/headers`, reference them on the `RateLimited` response, describe the
  policy (scopes, class catalog, default limits, window anchoring, `Retry-After` semantics)
  where the contract documents rate limiting, and keep every already-declared `429` response
  — those declarations become **effective** in this phase. Lint must stay clean.
- `docs/api-conventions.md`: a rate-limiting section stating the scopes, the class catalog
  and its defaults, the header semantics, what a `429` means for retries, and the
  Redis-unavailability posture — the authoritative source Phase 15 renders publicly. It also
  records that the limit headers are CORS-exposed (§4.4 point 6), so browser clients can read
  them without a proxy change.
- `apps/api/.env.example` and `docker/compose.yml` are updated for the new variables, with
  non-secret development defaults and no secrets.
- Phase 14/15/16/19/20 handovers (§11).

## 7. Web application

No dashboard feature is in scope (the roadmap assigns no UI to Phase 13). No page, route,
layout or client change is made in `apps/web` by this phase.

The CORS exposure decided in Q3 (§4.4 point 6) is an **API-side change only**. It belongs to
this phase precisely so the dashboard *can* read remaining budget; building the indicator is
Phase 14's work, and it needs no further API decision.

One handover obligation is recorded for Phase 14: the dashboard must treat a `429` as a
*retryable* condition rather than a generic failure, and must not present it as an
authorization or data problem.

## 8. Security requirements

- **Abuse prevention is the security goal.** Limits exist to bound credential guessing,
  scraping, enumeration, and outbound amplification. A limit that can be bypassed by
  changing a header is a defect, not a tuning problem.
- **Client identity cannot be forged (D1).** When proxy trust is configured, only a
  configured proxy's forwarding headers are honored, and hop counts/CIDRs are bounded.
  Forwarded headers from any other source are ignored for limit purposes. A deployment that
  trusts forwarded headers without a proxy in front allows an attacker to mint unlimited IP
  buckets — the security review must confirm the posture of each environment.
- **Discriminator normalization (D1).** The client identity is canonicalized before hashing
  (IPv4-mapped IPv6 collapsed to IPv4, IPv6 re-serialized in RFC 5952 form so every spelling
  of one address is one string, lowercased, zone identifiers and brackets removed),
  so one client cannot obtain several budgets by varying the textual form of its address.
  Forwarded entries that do not parse as an address are never used as an identity: the
  rightmost entry must be an address or the chain is not read at all, because dropping an
  unparseable entry would shift the walk onto an entry the caller chose.
- **Key material never leaks.** No raw IP, email, API key, key id, or user agent in Redis
  keys, logs, request-log rows, audit entries, error messages, or headers. The existing
  hashed-key precedent is preserved and extended to every scope. Passwords, refresh tokens
  and session tokens are never involved.
- **Non-disclosure.** A `429` reveals only that a limit was exceeded and when to retry. It
  must not disclose whether a credential, key, project or organization exists — the limiter
  runs before and independently of authentication, and its response is identical for an
  unknown key, a revoked key, and a valid key. Exposing the limit headers to browsers (§4.4
  point 6) discloses the caller's own remaining budget and nothing about any other identity;
  the exposure must not be widened to internal fields.
- **No limiter-induced authorization bypass or escalation.** The limiter never grants access,
  never widens scope, and never downgrades a `401`/`403` into a `200`.
- **Availability of the limiter is not the API's availability (D8).** A Redis outage degrades
  enforcement and must never make `/health/ready` fail for the limiter alone (Phase 2 D9
  semantics), nor turn a Redis error into a `5xx` for a request that would otherwise succeed.
- **Bounded memory (F10).** The degraded in-process store is bounded so it cannot be grown
  by a flood of distinct identities, and the degradation is logged (once, without identity
  values) so it is never silent.
- **Input validation.** No client input controls a limit: class selection comes from server
  metadata, limits from configuration. Query/path/body values never enter a bucket key.
- **No injection.** Redis access is a fixed script with parameterized arguments; no key is
  built by string-concatenating unvalidated input beyond the normalized discriminator, which
  is hashed before use.
- An explicit **security review** (IP trust, identity normalization, key derivation,
  non-disclosure, fail-open blast radius) is required before sign-off (AGENTS.md).

## 9. Acceptance criteria

1. The five Phase 13 roadmap checkboxes (IP, API key, endpoint-specific, headers,
   documentation) are implemented and traced to §1/§2, and `docs/openapi.yaml` +
   `docs/api-conventions.md` reflect the confirmed policy and lint clean.
2. Every request under the API prefix is counted against an `ip` bucket, and the count is
   applied **before** any authentication or database work — provable by throttling an
   unauthenticated route until `429` while the database is unreachable.
3. An API-key-authenticated request consumes both its `ip` and its `api_key` bucket; a
   session-authenticated request consumes only the `ip` bucket (D5).
4. Bucket isolation holds: exhausting one API key's budget does not throttle a second key of
   the same project, a key of another project, or session traffic from the same client.
5. Every contracted operation resolves to exactly one class from the closed catalog; a route
   without a declared class fails loudly rather than being silently unlimited.
6. Exceeding a limit yields **429** with the canonical envelope (`RATE_LIMITED`,
   `X-Request-Id` present, no internals), no handler execution, and no side effect.
7. Limited routes report `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on
   allowed **and** rejected responses; `429` responses additionally carry an integer
   `Retry-After` equal to the seconds until the reported bucket resets (never negative,
   never zero). Those four headers are listed in `Access-Control-Expose-Headers` so a
   cross-origin browser client can read them, and no header outside that set is newly exposed.
8. Counting and window creation are atomic: concurrent first-requests in one window admit
   exactly `limit` requests, and a rejected request still consumed exactly one unit.
9. Excluded surfaces are never counted and never throttled: CORS preflight, `/health/live`,
   `/health/ready`, Swagger UI traffic, and non-API paths — including when every real limit
   is exhausted.
10. Phase 3 behavior is unchanged: `auth.*` classes keep their limits, windows, per-account
    dimension, 429 shape, and the existing `AUTH_RATE_LIMIT_*` variable names and defaults
    (D9).
11. Keys are opaque: no Redis key, log line, request-log row, audit entry, response header or
    error body produced by this phase contains a raw IP address, email address, API key or
    API-key id (rule 5, §8).
12. Redis unavailable → the documented posture holds: default fail-open with a single warning
    and a bounded fallback store, no `5xx`, readiness unaffected; fail-closed mode rejects
    with `429` instead (D8). Both modes are proven by tests.
13. Configuration validation rejects a non-integer or non-positive limit/window at boot, and
    the limiter cannot be silently disabled by a configuration mistake.
14. Throttled requests are still recorded as Phase 11 request-log rows and produce no Phase 12
    audit entry (D13).
15. Idempotent replays obey the limits and a `429` stores no idempotency record, so the same
    `Idempotency-Key` remains usable afterwards.
16. Repository checks required by AGENTS.md pass: lint, typecheck, unit tests, relevant
    integration/e2e tests, build — plus OpenAPI validation in CI.

## 10. Testing requirements

- **Unit**
  - key derivation: hashing of the tuple, namespacing, and proof that no raw IP/email/key id
    appears in a key;
  - discriminator normalization (IPv4-mapped IPv6, case, zone id, brackets);
  - window math: anchor at first hit, remaining TTL, `RateLimit-Reset` and `Retry-After`
    formatting (never negative/zero, integer delta-seconds);
  - route-class resolution: default mapping, per-route override, missing class is an error,
    unknown class is rejected;
  - counting rules: allowed/rejected requests, `400`/`401`/`403`/`404`/`422`, idempotent
    replays, and the exclusion set;
  - header selection with multiple applicable scopes (D4 tie-break is deterministic);
  - failure posture: fail-open (single warning, bounded store, no throw) and fail-closed;
  - configuration validation (non-integer, zero, negative, malformed);
  - `RATE_LIMIT_*` ↔ `AUTH_RATE_LIMIT_*` mapping, including that legacy names still produce
    the Phase 3 values (D9).
- **Integration (real Redis)**
  - the atomic script: one round trip returns count and TTL; concurrent first-requests admit
    exactly `limit`; the window resets after expiry; keys carry the expected TTL;
  - two independent limiter instances sharing one Redis enforce the same budget (the
    cross-replica property that justifies Redis over in-process storage);
  - bucket isolation across scopes, projects and keys;
  - degraded mode: Redis down → fallback store still bounds a single process and stays
    within its memory bound; recovery restores Redis-backed counting.
- **E2E (API)**
  - the status table of §4.3 for representative routes of every class, in both session and
    API-key mode;
  - header presence and values on allowed and rejected responses, including `Retry-After`
    consistency with the observed reset;
  - the limit headers are listed in `Access-Control-Expose-Headers` and are readable from a
    cross-origin client, while no other internal header is newly exposed (§4.4 point 6);
  - exclusions under saturation (preflight/health/Swagger still succeed while a real route
    returns `429`);
  - Phase 3 regression: auth limits still return `429` on the unchanged variables;
  - a throttled request produces a request-log row with status 429 and **no** audit entry;
  - an idempotent replay is counted; a `429` on an idempotent mutation leaves the key
    reusable, and the subsequent request succeeds.
- **Configuration**
  - `apps/api/.env.example` and `docker/compose.yml` list every new variable with the same
    default the code uses; the local Compose stack boots with the documented values.
- Tests run deterministically with no real credentials and no secret or identity logging;
  e2e environments must be able to raise or disable the limits (the existing
  `test/jest-e2e.setup.ts` precedent) **without weakening the assertions of §9's numbered
  criteria**, which belong to dedicated rate-limit e2e cases.

## 11. Out of scope

- **Per-organization, per-user, or per-project quotas** and any plan/tier-based limits — the
  roadmap asks for IP and API key only (D5).
- **Multiple simultaneous windows per class** (e.g. a per-minute and a per-day budget) —
  one window per class; a second window is an amendment, and is only worth adding when
  Phase 19/20 demonstrates a need.
- **Distributed or multi-region limiting**; the counter is per Redis deployment.
- **Metrics, dashboards, alerting, and throttling telemetry beyond the Phase 11 request log**
  (Phase 20).
- **Dashboard UI for limits or remaining budget** (Phase 14), and the public developer guide
  (Phase 15) — this phase supplies their source material.
- **A pending-delivery bound per webhook endpoint** and **per-project fairness in the worker
  sweeps** — Phase 10 explicitly classified the fairness defect as an availability problem
  outside a rate-limiting mandate (D11).
- **Changing payment/refund/webhook/customer/idempotency domain rules**, the webhook retry
  ladder, or request/audit-log semantics.
- **Changing the Phase 3 auth limit values** or removing their env variables (D9).
- **Automatic 429 backoff inside SDKs** (no SDK in the MVP), and CLI/SDK rate-limit helpers
  (roadmap Future).
- **Sandbox-specific throttling scenarios** such as deliberately forcing a `429`
  (Phase 16 owns simulation scenarios; this phase must keep the sandbox usable, not add
  failure injection).
- **Load-testing infrastructure** (Phase 19) and **staging/production deployment**
  (Phases 21–24), including the proxy that makes D1 necessary.

## 12. Decisions (D1–D13 — confirmed 2026-10-02)

Every row below is derived from the roadmap, the master specification, the prior-phase
handover notes and the existing code. **All thirteen were reviewed and approved by the
product authority on 2026-10-02** (Q1–Q5 of §13 answered in the same review). Each states the
adopted position and the rejected alternative so the trade-off remains visible to anyone
revisiting it; the numbers in §6.2 are part of D6 and are confirmed.

| # | Decision | Adopted position | Rejected alternative |
| --- | --- | --- | --- |
| D1 | Client identity and proxy trust | Env-driven trust model: direct socket peer by default; a deployment behind a load balancer sets an explicit bounded proxy trust — a **CIDR allowlist of proxy addresses** (an entry shorter than `/8` for IPv4 or `/32` for IPv6 is refused, and an IPv4-mapped IPv6 entry is held to the IPv4 floor — an entry broad enough to cover the routing table is not a list of proxies), plus an optional bounded hop count that limits how much of the chain is read — and forwarded headers from any other source are ignored for limit purposes. Boot refuses a hop count with no allowlist: a hop count bounds *how much* of a chain is read, never *who* wrote it. Identity is canonicalized (IPv4-mapped IPv6 collapsed to IPv4, IPv6 re-serialized in RFC 5952 form, case, zone id, brackets) before hashing. One model for both this phase and the Phase 3 auth limits. | Always trusting `X-Forwarded-For` (trivially forgeable → unlimited IP buckets); trusting by hop count alone, with no peer allowlist (same forgeability — the client writes the entries a bare hop count indexes); always using the socket peer (behind the Phase 22/24 load balancer every client shares one bucket, so the limits become a self-inflicted outage); leaving it implicit as today (same failure, discovered in production). |
| D2 | Algorithm | Keep the proven fixed-window counter (single atomic Redis script), window anchored at the first counted request, script extended to return the remaining TTL so headers need no second round trip. | Sliding window / token bucket / GCRA (better burst accuracy, materially more Redis memory and operations, and the current accuracy is acceptable for a sandbox); separate read-then-write steps (race). |
| D3 | Header names | Published standard fields `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` on `429`, emitted on every response of a limited route. | `X-RateLimit-*` legacy names (what most gateways historically sent; not the published standard, and "standard headers" was the requirement); emitting both (duplicated, divergent semantics); only on `429` (developers cannot budget proactively). |
| D4 | Which bucket the headers report | The bucket closest to exhaustion (lowest remaining), with a fixed scope tie-break, so the header never promises headroom on a request about to be rejected. | Fixed precedence (`api_key` before `ip`) — simpler to explain, but can report a comfortable budget while the other scope is nearly exhausted. |
| D5 | Dimensions | `ip` always; `api_key` only in API-key mode; `account` only on auth session-creation. No session-user or organization dimension. | Adding a session-user bucket (better containment of a stolen access token, but a shared NAT egress would throttle unrelated dashboard users, and credential attacks are already covered per-account by Phase 3); per-organization limits (no roadmap basis; cross-cutting configuration per tenant is a product feature). |
| D6 | Class catalog and numbers | The seven classes of §4.2 with the generous sandbox defaults of §6.2, all env-driven. | Per-operation limits for all 46 operations (46 arbitrary numbers with no product input, and a maintenance burden for no benefit); one global limit for everything (the "endpoint-specific" requirement would be unmet); Stripe-like published tiers (adopting an external product's numbers without product input). |
| D7 | Enforcement points | Two stages: a global IP enforcement point that precedes route authentication, and an API-key enforcement point invoked after the access guard resolves the key on dual-mode project routes. | One global guard only (cannot key on the API key, so the API-key requirement fails); having the dual-mode access guards call the limiter (couples domain guards to a cross-cutting concern and forks the policy); an interceptor for the API-key stage (interceptors do not run when a guard rejects — acceptable here, but the guard-based point is simpler to reason about and test). |
| D8 | Redis-unavailability posture | Fail-open by default with a single non-identifying warning, a bounded in-process fallback, no `5xx`, and readiness unaffected; `RATE_LIMIT_FAIL_MODE=closed` available for deployments that prefer enforcement over availability. | Fail-closed only (a Redis outage becomes a full API outage — a sandbox should not trade availability for enforcement); an unbounded fallback map (memory growth driven by an attacker). |
| D9 | Phase 3 configuration continuity | The `AUTH_RATE_LIMIT_*` variables keep their names, defaults and meaning and continue to govern the `auth.*` classes; the auth guard becomes a consumer of the shared capability. No new names for auth. | Renaming/migrating to `RATE_LIMIT_AUTH_*` with legacy aliases (more config surface for no behavioral gain, and a compatibility risk `AGENTS.md` asks us not to take without cause). |
| D10 | What counts | Every attempt that reaches the limiter counts, including requests later rejected by validation/authentication/authorization/business rules and idempotent replays; preflight, health, Swagger and non-API paths are excluded before counting. | Counting only successful requests (useless against a flood — the flood's requests mostly fail); excluding `401`s (unauthenticated brute force is the primary target). |
| D11 | Phase 10 carry-overs | Discharge the two items Phase 10 assigned here: a replay cap and an endpoint-creation cap, expressed as route classes (`webhook.replay`, `webhook.endpoint-create`). Refer the pending-delivery bound and the sweep fairness defect onward, as Phase 10 itself classified them outside a rate-limiting mandate. | Also bounding pending deliveries per endpoint (a state-count bound, not a rate — belongs with the delivery model); implementing sweep fairness here (explicitly out of Phase 10's own scope note); leaving the replay amplifier unbounded (Phase 10's security review deferred it to this phase for a reason). |
| D12 | Documentation deliverable | Make the policy machine-readable (configuration) and contract-visible (`docs/openapi.yaml` headers + policy description, `docs/api-conventions.md` section), then hand the table to Phase 15 for the public guide. | Writing the public documentation page now (Phase 15 owns the docs application; this phase would duplicate it); documentation living only in configuration (invisible to developers and to the contract). |
| D13 | `429` observability and payload | Throttled requests are request-logged (Phase 11 completeness) and write no audit entry (Phase 12); the `429` envelope carries only budget numbers in `details`, never an identity. | Suppressing request logs for `429`s (hides the attack signal — though it would reduce the write amplification of F12, which is referred to Phases 19/20 instead); putting the scope/class name or remaining budget in the body (leaks internal policy). |

## 13. Resolved questions (Q1–Q5 — closed 2026-10-02)

These were put to the product authority and answered on 2026-10-02. Each is now binding
specification, not an open item.

1. **Default limits — accepted as proposed (D6).** `write = 120 / 60 s` per API key is high
   enough for load-testing and sandbox tooling, and `read = 600 / 60 s` per IP is high enough
   for a dashboard user behind a shared egress. The values in §6.2 stand unchanged. If a
   future phase finds them tight, raising them is configuration-only.
2. **Session-user budget — no (D5).** Session-authenticated requests are covered by the `ip`
   bucket and, for session creation, the `account` bucket. There is no user dimension, so no
   new scope and no new decision.
3. **Browser visibility of limit headers — yes.** `RateLimit-Limit`, `RateLimit-Remaining`,
   `RateLimit-Reset` and `Retry-After` are added to `Access-Control-Expose-Headers` (§4.4
   point 6), which is now a requirement of this phase and an acceptance criterion.
4. **"Endpoint-specific limits" — the closed class catalog (D6).** Operations map to exactly
   one of the seven classes in §4.2; there is no per-operation limit table.
5. **"Raise your limits" path — out of scope (D5).** A per-project developer-facing override
   is a tenant quota feature, not a rate limiter, and remains excluded (§11).

## 14. Architectural decisions to record

To be authored in `.ai/decisions/` during implementation, continuing the existing series:

- **Rate limiting architecture**: two-stage enforcement (pre-authentication IP, post-
  authentication API key), the closed class catalog, the atomic fixed-window counter, hashed
  key derivation, and the fail-open posture (D2, D5, D7, D8).
- **Client identity and proxy trust**: the trust model and discriminator normalization, and
  why it also governs the Phase 3 auth limits (D1).

## 15. Implementation considerations (not new requirements)

- Promote the existing capability into a cross-cutting `rate-limiting` module (mirroring the
  `request-logging` / `audit-logging` / `idempotency` module shape) and keep the auth guard as
  a thin consumer, so Phase 3 behavior and tests keep passing unchanged.
- Extend the existing Lua script to return the counter **and** its remaining TTL in one round
  trip; do not add a second `TTL` call per request.
- Bound the Redis command path: a slow Redis must surface as a fast failure (then fail-open
  per D8), not as added latency on every request.
- Enforce the exclusion decision before any Redis work, reusing the existing
  API-prefix/preflight predicates that Phase 11 already established rather than duplicating
  path logic.
- Declare route classes with metadata (a decorator) resolved by `Reflector`, mirroring
  `@AuthRateLimit`; require a class on every contracted route so "unlimited" is always an
  explicit, reviewable choice.
- Register the API-key enforcement point only on the dual-mode project routes; do not touch
  the Phase 4 org guard, the Phase 5 project guard, or the Phase 10 `ProjectAccessGuard`
  logic.
- Do not modify application source as part of specification work.

## 16. Dependencies

- **Inputs:** Phase 3 (the existing limiter and its configuration contract), Phase 2 (Redis,
  error envelope, request IDs, bootstrap), Phase 5 (`ApiKeyContext`, API-key prefix), Phase 10
  (dual-mode project access guard, replay route, endpoint-creation route), Phase 11
  (request-log coverage of `429`s, exclusion predicates), Phase 12 (no audit entry on `429`),
  phase 1 artifacts and ADR-0012.
- **Blocks:** Phase 14 (dashboard `429` presentation), Phase 15 (rate-limit guide), Phase 16
  (sandbox scenarios must stay inside limits), Phase 18 (security hardening review of IP
  trust and key derivation), Phase 19 (load tests must configure limits), Phase 20
  (throttling metrics).
- **Coordination obligations out of this phase:**
  - Phase 14: present `429` as retryable. The browser-visibility question is **closed** —
     this phase exposes the limit headers (§4.4 point 6), so a remaining-budget indicator
     needs no further API decision.
  - Phase 15: the §6.2 class table and §6.3 policy text are the source for the public guide.
  - Phase 16: sandbox decline/timeout/replay-failure scenarios must not be throttled by
    accident; scenario volumes may require raised limits.
  - Phase 19: load-test scenarios must set their own limits, and F12's request-log write
    amplification must be measured. One case of that amplification is reachable today and
    must be scoped by the same work: a request under `/api/v1` that matches no route
    returns `404` **without consuming budget** — a guard cannot run for a route that was
    never matched — yet is still request-logged, so a scan of nonexistent paths writes a
    row per request while spending no budget and doing no handler work. Bounding it needs
    either a limiter stage before routing or an exclusion from the request log; both are
    beyond this phase's approved scope (§4.2 rule 1 counts only requests that reach a
    route).
  - Phase 20: throttled-request counts, per-class exhaustion, and the degraded-mode warning
    are the metrics this phase's behavior implies.
  - Phases 22/24: the proxy that makes D1 necessary, and the `TRUST_PROXY_*` values per
    environment.

## 17. Definition of done

The phase is complete only when:

1. Decisions D1–D13 are confirmed in §12 and Q1–Q5 resolved in §13; the §6.2 numbers match
   the confirmed values and any later change is an amendment, not an implicit adjustment.
2. All acceptance criteria in §9 are satisfied and traced to the five roadmap checkboxes.
3. Tests pass: unit, integration (real Redis), e2e API, and configuration tests of §10 —
   including atomicity, bucket isolation, the exclusion set, both failure postures, and the
   Phase 3 regression.
4. Repository-required checks pass: lint, typecheck, unit tests, relevant
   integration/e2e tests, build, and OpenAPI validation.
5. The security requirements of §8 have been explicitly reviewed (proxy/IP trust,
   normalization, key derivation, non-disclosure, degraded-mode blast radius), with no known
   critical security issue remaining.
6. `docs/openapi.yaml` and `docs/api-conventions.md` reflect the confirmed policy; the
   architectural decisions are recorded in `.ai/decisions/`; the §11 handover obligations are
   marked as handed over; and no application source was modified as part of specification
   work.