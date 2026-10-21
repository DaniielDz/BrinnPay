# Phase 15 — Developer Experience

| | |
| --- | --- |
| Phase | 15 — Developer Experience |
| Status | **Approved — D1–D8 confirmed and Q1–Q4 answered by the product authority on 2026-10-06, exactly as recommended (D1–D8 = option (a) each; Q1 §10.1–10.5 only; Q2 handover guides in scope; Q3 ROADMAP bookkeeping out of scope; Q4 display-only reference). This specification is ready for implementation.** |
| Depends on | Phase 1 (§7 API conventions, §11.1 `/docs/**` route reservation, §13.2 canonical contract), Phase 2 (Swagger UI from the canonical contract, OpenAPI lint in `pnpm lint`), Phase 3 (authentication behavior the guides describe), Phase 4–5 (organizations, projects, API keys — the onboarding steps), Phase 6–7 (customers, payments and the default-success simulation), Phase 8 (idempotency), Phase 9 (refunds), Phase 10 (webhooks: events, signature, retries, retention, destination policy), Phase 11 (request IDs, request-log retention), Phase 12 (audit-log catalog and lifecycle), Phase 13 (rate-limit policy — authoritative source for the public guide, D12), Phase 14 (public shell, `/docs` stub, D9 test scope, CSP and accessibility baseline) |
| Blocks | Phase 16 (the sandbox guide gains scenario content when decline/timeout/webhook-failure triggers ship), Phase 17 (docs flows become e2e targets), Phase 25 (README/CONTRIBUTING/local-development content reuses this phase's guide rather than duplicating it), Phase 26 (verify public API and integration documentation before release) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 15 |
| Branch | `chore/phase-15-dev-exp` (checked out, empty of changes) |

## 1. Objective

Make BrinnPay **understandable and easy to integrate** by shipping the complete
**public documentation area** of `apps/web`: a navigable `/docs/**` section with
integration guides, cURL and code examples, a developer onboarding path, and an API
reference generated from the canonical OpenAPI contract — all static, public, and
accurate to the implemented system.

This phase adds **no product features to the API**. It publishes what Phases 3–13
already built, from their own authoritative sources.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| Public documentation section in `apps/web` | §4 |
| OpenAPI documentation | §6 (contract stays canonical; D7 refinements) |
| API reference docs | §6 (D2) |
| Authentication guide | §5.3 |
| API key usage guide | §5.4 |
| TEST/LIVE environment guide | §5.5 |
| Payments guide | §5.6 |
| Refunds guide | §5.7 |
| Idempotency guide | §5.8 |
| Webhooks guide | §5.9 |
| Error handling guide | §5.10 |
| cURL examples | §7 |
| Code examples | §7 (D3) |
| Integration guides | §5 umbrella + §5.2 quickstart (D4) |
| Sandbox usage guide | §5.12 (D6) |
| Local development guide | §8 (D5) |
| Developer onboarding flow | §5.2 (D4) |
| (handover, not on the roadmap list) Rate-limit guide | §5.11 — Phase 13 D12 obligation; Q2 confirmed in scope |
| (handover, not on the roadmap list) Request-ID / request-log retention guidance | §5.11 — Phase 11 obligation; Q2 confirmed in scope |
| (handover, not on the roadmap list) Audit-log lifecycle guidance | §5.11 — Phase 12 obligation; Q2 confirmed in scope |

## 2. Scope

In scope:

- **Documentation area** at `/docs/**` in `apps/web`: index, section navigation, and the
  guide pages required by §4 and §5, inside the Phase 14 public shell (public nav, footer,
  styling, responsive and accessibility baseline unchanged in behavior).
- **Content**: the guide inventory of §5, written to the rules of §5.1, sourced from the
  canonical artifacts named per guide.
- **API reference**: presentation of `docs/openapi.yaml` to developers per §6 (D2
  confirmed (a): embedded, display-only, generated at build time).
- **Examples**: cURL and code examples per §7 (D3 confirmed (a): cURL + JavaScript +
  Python).
- **Local development guide** per §8 (D5 confirmed (a): one guide, both audiences).
- **Cross-cutting**: internal link integrity, per-page metadata, content-consistency
  protection (D8), and preservation of the Phase 14 public-area constraints (§9).
- **Tests** for all of the above (§13), including updating the Phase 14 tests that assert
  the `/docs` stub.

Explicitly **not** in scope (§14): any API endpoint, contract-semantic, database, or
migration change; SDKs/CLI; docs search; dashboard changes; Phase 16 sandbox scenarios;
README/CONTRIBUTING (Phase 25); pricing/marketing/legal pages.

## 3. Context and current-state findings

**What exists today** (branch `chore/phase-15-dev-exp`, Phases 1–14 merged):

- `/docs` is an **intentional stub** (Phase 14 §4.1): a heading, one sentence, two
  buttons. `public-pages.spec.tsx` ("keeps /docs as the phase 15 entry point") and
  `home.smoke.spec.tsx` assert stub-era content — they must be updated in the same change
  that adds content (F1).
- **Entry points already exist and must be honored**: public nav ("Docs"), footer
  ("Docs"), home CTAs, product page, and the dashboard overview quick link. The docs IA
  must satisfy all of them without changing their targets.
- **Canonical sources are rich and already written** (§5 cites them per guide):
  `docs/openapi.yaml` (~3.5k lines, single source of truth per ADR-0012) and
  `docs/api-conventions.md` — whose §10 (rate limiting) is explicitly marked *"Phase 15
  renders this section publicly"*. Phase specs and ADRs carry the remaining facts.
- **Swagger UI is already served by the API** from the canonical contract (Phase 2 D5,
  mount path `docs`, unconditional in `main.ts`), so `{API origin}/docs` renders the
  contract today. It lives on a **different origin** from the web app's `/docs` (no route
  conflict, but a naming/UX point for D2).
- `apps/web` has **no markdown/MDX tooling**; tests import pages as TSX modules and the
  Docker dev mounts cover `apps/web/{app,components,lib,styles}` only — repo-root `docs/`
  is not mounted (F8, §17).
- Phase 14 shipped CSP and a public-area content rule (D9): public pages carry **no
  session material, tokens, key material, or authenticated/dashboard content**. Any
  embedded reference renderer must keep CSP violations at zero (F9).

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | `/docs` is a stub and its tests assert stub behavior. | §13 — content tests replace stub assertions in the same change. |
| F2 | Root `docs/*.md` are **architecture artifacts**: they reference phases, ADRs, internal decisions, and security-baseline internals (proxy trust, Redis fail-open). Rendering them wholesale would publish internal material. | D1 confirmed (a) — re-author for a public audience, citing sources; Q1 answered: publish §10.1–10.5 only (§16). |
| F3 | The contract is already rendered publicly by the API's Swagger UI; a second rendering mechanism may duplicate it. | D2 confirmed (a) — embedded reference, Swagger kept as secondary path. |
| F4 | No authoring format for long-form content exists in `apps/web`. | D1 confirmed (a) — TSX content in the web app. |
| F5 | Roadmap Phase 15 has **no bullets** for the three handover-mandated guides (rate limits — Phase 13 D12; request-ID/retention — Phase 11; audit lifecycle — Phase 12), yet Phase 13's "documented in developer documentation" checkbox is already checked. | §5.11 includes them as handover obligations; **Q2 answered: confirmed in scope** for Phase 15. |
| F6 | Roadmap orders **Sandbox usage guide (15)** before **Sandbox scenarios (16)**. Decline/timeout/webhook-failure triggers do not exist yet; only Phase 7's default-success simulation does. | D6 confirmed (a) — document implemented behavior only. |
| F7 | "Developer onboarding flow" and "Local development guide" are ambiguous; Phase 25 also lists "Local development documentation". | D4 confirmed (a) — docs quickstart, no dashboard UI; D5 confirmed (a) — one guide covering both audiences. |
| F8 | If content or the contract is read from outside `apps/web` at build/dev time, Docker mounts and the web Dockerfile do not currently include it. | §17 — implementation consideration; D1 confirmed keeps content inside `apps/web`, contract import is build-time only. |
| F9 | Embedding a reference renderer can break the Phase 14 CSP (`unsafe-eval`, remote origins) or the "no CSP violations" criterion. | §11.6 — renderer must be bundled/self-contained and validated against the running build; Q4 answered: display-only (no `connect-src` widening). |
| F10 | Published examples and contract examples must contain only placeholder credentials. | §11.4 — verified by test (§13). |
| F11 | ROADMAP.md checkbox bookkeeping (Phases 4–12 unchecked; Phase 13 docs checkbox checked early) — same class as Phase 14 F10. | **Q3 answered** — reported, not fixed inside this phase's file scope. |

## 4. Documentation area — `apps/web`

### 4.1 Information architecture (public URLs)

The docs area is a section of the public route group served by the existing public shell.
The following routes are the **minimum required surface**; slugs are part of this
specification because navigation, tests, and external links depend on them:

| Route | Content |
| --- | --- |
| `/docs` | Documentation index: complete section list with one-line descriptions, prominent quickstart entry, link to the API reference. Replaces the stub. |
| `/docs/quickstart` | Developer onboarding path (§5.2, D4). |
| `/docs/authentication` | §5.3 |
| `/docs/api-keys` | §5.4 |
| `/docs/environments` | §5.5 (TEST/LIVE) |
| `/docs/payments` | §5.6 |
| `/docs/refunds` | §5.7 |
| `/docs/idempotency` | §5.8 |
| `/docs/webhooks` | §5.9 |
| `/docs/errors` | §5.10 |
| `/docs/rate-limits` | §5.11 (handover, Q2) |
| `/docs/logs` | §5.11 (request IDs, request logs, audit logs — one page or two, content per §5.11) |
| `/docs/sandbox` | §5.12 (D6) |
| `/docs/local-development` | §8 (D5) |
| `/docs/api-reference` | §6 (D2 confirmed: embedded, display-only, generated at build time from `docs/openapi.yaml`) |

### 4.2 Area requirements

- **Static and public:** every docs route is static server-rendered, unauthenticated, and
  performs **no API calls** (Phase 1 §11.1, Phase 14 §4.1). No session material, tokens,
  key material, or dashboard content anywhere in the docs area (Phase 14 D9 — the
  existing negative assertions must keep passing).
- **Navigation:** the index lists every guide; a persistent section navigation (sidebar or
  equivalent) is present on every docs page and exposes the current location; every guide
  links back to the index. The existing public nav/footer "Docs" links keep working.
- **Metadata:** per-page `<title>`/description for index and every guide (Phase 14
  precedent).
- **Responsive and accessible** to the Phase 14 baseline (§7.1/§7.6): navigation reachable
  on small screens, heading order correct, code blocks scroll within their own region,
  contrast sufficient, no keyboard traps.
- **Content placement:** guide content lives in the web application (D1 confirmed —
  TSX); nothing in the docs area may depend on a running API or database.

## 5. Content requirements — guide inventory

### 5.1 Documentation domain rules (apply to every guide)

1. **Accuracy over completeness:** document only implemented, contracted behavior. No
   invented features, endpoints, limits, guarantees, or roadmap promises (master
   specification; AGENTS.md "do not invent business behavior").
2. **One source of truth per fact:** every guide states (in prose or a visible source
   note) the canonical artifact it derives from — `docs/openapi.yaml`,
   `docs/api-conventions.md`, or the named phase/ADR. Where a fact exists in the contract,
   the guide and the contract must not disagree (protection per D8).
3. **No internal artifacts rendered verbatim** (F2/D1): phase numbers, ADR numbering,
   internal decision histories, security-baseline internals, and operator-only
   configuration are not published as-is. Public prose re-authors the developer-facing
   substance.
4. **Conventions are restated, not redefined:** money format (`"10.00"` + `usd`, decimal
   strings), lowercase environment values (`test`/`live`) vs uppercase UI copy (`TEST`/
   `LIVE`), snake_case JSON, UTC ISO 8601 timestamps, opaque UUIDv7 IDs, `req_…` request
   IDs, cursor pagination (`limit`, `cursor`, `next_cursor`, `has_more`) appear exactly as
   `docs/api-conventions.md` defines them.
5. **Honesty about simulation:** every guide that touches payments states that BrinnPay
   simulates payments and processes no real money, and no guide implies real card
   processing or card-data collection (master specification).
6. **Errors are documented as the envelope**, never as ad-hoc strings (§5.10).

### 5.2 Quickstart / developer onboarding (roadmap: "Developer onboarding flow", "Integration guides") — D4

Confirmed path (D4 = (a), docs quickstart, no dashboard changes):

- A single sequential guide at `/docs/quickstart` covering, end to end, using **only
  existing behavior**: create an account → (a default personal organization already
  exists, ADR-0010) → create a project → create an API key (TEST) → create a customer →
  create a payment → observe it reach `succeeded` (default simulation, §5.6) → register a
  webhook endpoint and verify a delivery (§5.9).
- Each step states where it happens (dashboard vs API), the exact call or action, and the
  expected result; every step links to the corresponding full guide.
- The quickstart uses TEST environment values and placeholder credentials only.
- The quickstart must not require anything that does not exist (no failure scenarios, no
  CLI, no SDK — D6, §14).
- **No dashboard/onboarding-UI changes** under the recommended option (Phase 14's
  overview empty states already carry in-product guidance).

### 5.3 Authentication guide

Source: `docs/api-conventions.md` §3, `docs/openapi.yaml` security schemes, Phase 3/Phase 1
§7.3, §11.5.

Required content:

- The **two authentication modes** and that they are not equivalent: API-key bearer
  (`Authorization: Bearer sk_test_…`/`sk_live_…`) for programmatic access, scoped to one
  project + environment; session JWT for dashboard/user endpoints, scoped to organization
  memberships and RBAC.
- Which route areas accept which mode (the §3 table: session-only areas vs dual-mode
  resource areas).
- How each credential is obtained (key: created in the dashboard; session: `login`/
  `refresh` endpoints, refresh token only as an `HttpOnly` cookie — as the contract
  already documents it).
- What each failure looks like: missing/invalid credential → `401 UNAUTHENTICATED`;
  valid credential without permission → `403 FORBIDDEN`; inaccessible resource → `404`
  (tenant isolation never leaks existence).
- A minimal authenticated request example (§7).

### 5.4 API key usage guide

Source: Phase 5, ADR-0006, ADR-0014, `openapi.yaml` `ApiKeyAuth`.

Required content: key format and prefixes (`sk_test_`/`sk_live_`); scope = exactly one
project + environment and **no** organization-management authority; created in the
dashboard; **shown once at creation** and stored hashed (never recoverable); rotate =
create-then-revoke (concurrent validity of both during rotation, as Phase 5 specifies);
revoke takes effect immediately; keys are never logged; what to do on suspected leak
(revoke/rotate); `401` on unknown/revoked keys; rate limits charge the key's budget as
well as the caller's IP budget (§5.11).

### 5.5 TEST/LIVE environment guide

Source: Phase 1 §5.2, ADR-0006, `api-conventions.md` §3/§8.

Required content: both environments are simulated and process no real money; a project
supports both by default; API values are lowercase `test`/`live`, UI copy is `TEST`/`LIVE`,
key prefixes carry the environment; with an API key the environment **comes from the key**
and a payload value must match (mismatch → `422`); with a session the environment is
declared explicitly (payload field or list filter); TEST/LIVE data is never mixed;
environment-scoped resources belong to exactly one environment, while **API keys are
project-wide** (Phase 5 D5); how the dashboard selector relates (query parameter,
default `test`).

### 5.6 Payments guide

Source: Phase 7, ADR-0001/0002/0003, `openapi.yaml` payments operations.

Required content: create/retrieve/list with cursor pagination; required create body
(`environment`, `customer_id`, `amount`, `currency`, optional `description`) — a customer
must exist first; money as decimal strings with lowercase currency, **USD only** in the
MVP; the state machine `pending → processing → succeeded` and the **default-success
simulation** (advancement driven by the simulation, safe across restarts); that `failed`
exists in the model but **no failure trigger is exposed yet** (Phase 16 — D6, worded
strictly as current behavior); environment scoping and the dual-mode authorization rules;
`Idempotency-Key` on create (§5.8); which roles/sessions may create payments (per the
Phase 7 capability rules) and that API keys act within their project+environment;
simulation timing is observable via status polling (the dashboard does this).

### 5.7 Refunds guide

Source: Phase 9, `openapi.yaml` refunds operations.

Required content: refunds are created **against a succeeded payment** and complete
synchronously with `status: succeeded` (HTTP 201) **without changing the payment's
status**; omitted `amount` = full **remaining** balance after earlier refunds, explicit
positive `amount` must not exceed it; over-refund/exhausted/ineligible payment → `422`
(`BUSINESS_RULE_VIOLATION`, incl. `PAYMENT_ALREADY_REFUNDED` where the contract uses it);
key reused for a different payment → generic `409` that reveals nothing; `Idempotency-Key`
scope `refunds.create`, 24-hour replay of the original 201; authorization: all roles may
read, **owner/admin may create** (sessions), API keys project/environment scoped; listing
refunds is per payment with cursor pagination; optional `reason`/`currency` (usd only).

### 5.8 Idempotency guide

Source: `api-conventions.md` §4, ADR-0004, Phase 8.

Required content: the `Idempotency-Key` header (1–255 chars, trimmed); scope tuple
**(project, operation_scope, key)** with operation scopes `payments.create` and
`refunds.create`; within the **24-hour** retention window the same key replays the
original stored response without re-executing; a different operation scope with the same
key is an independent operation; after 24 hours reuse counts as a new operation; only
committed successful responses are stored (a rejected request leaves the key usable);
replays carry the current request's `X-Request-Id`; concurrency safety (one side effect,
every caller sees the committed response); a `429` stores nothing so the key stays
usable; guidance on client retry patterns (safe retries, key reuse across network
failures).

### 5.9 Webhooks guide

Source: Phase 10 (incl. ADR-0015…0019), `openapi.yaml` webhooks operations.

Required content:

- Endpoint registration: destination URL + `event_types` as a non-empty subset of the
  **closed catalog** (`payment.created`, `payment.succeeded`, `payment.failed`,
  `refund.created`); duplicate URLs allowed; environment scoping and dual-mode auth;
  `webhook.endpoint-create` rate class (10/hour).
- **Signing secret**: returned only at creation, unrecoverable afterwards; recovery is
  delete-and-recreate (no rotation operation in this version).
- **Signature verification**: headers `BrinnPay-Signature`, `BrinnPay-Event-Id`,
  `BrinnPay-Event-Type`, `BrinnPay-Delivery-Id`, `BrinnPay-Attempt`,
  `User-Agent: BrinnPay-Webhooks/1.0`; value `t=<unix-seconds>,v1=<lowercase-hex>` where
  the signed message is `${t}.${rawBody}` (HMAC-SHA256) — verified against the **raw
  body bytes**, not a re-serialization, with a tolerance window on `t`.
- **Delivery semantics**: at-least-once and **unordered**; deduplicate by envelope `id`
  (equals `BrinnPay-Event-Id`).
- **Retries**: up to **5 attempts total**, exponential backoff with full jitter
  (≈ 0 s, 30 s, 2 min, 10 min, 1 h, capped); a parseable `Retry-After` is honored and
  clamped; retryable = network errors/timeouts and 408/425/429/5xx; terminal = any other
  4xx and every 3xx; redirects are never followed and response bodies are never read —
  a destination behind a redirect must expose its direct URL.
- **Replay**: manual replay endpoint/UI, its rate class (20/300 s), and that expired
  events are `404`.
- **Retention**: events are retained **30 days** (Phase 10 D9), then absent from listings
  and un-replayable; deliveries live with their endpoint.
- **Destination rules** (developer-facing subset of ADR-0019): absolute `http`/`https`
  URL, host required, ≤ 2048 chars, no embedded credentials, no fragment; **localhost and
  private hosts are allowed by default** (so local receivers work); a deployment may
  restrict hosts, in which case a denied host fails terminally without an outbound
  request.
- Recommended consumer behavior: verify signature → persist/dedupe → ack quickly
  (2xx) → process asynchronously; failures surfaced in the dashboard delivery list.

### 5.10 Error handling guide

Source: `api-conventions.md` §6/§7, `apps/api` `ErrorCode`, Phase 1 §7.6.

Required content: the JSON error envelope (`error.code`, `error.message`,
`error.request_id`, optional `error.details`); the stable base codes
(`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`BUSINESS_RULE_VIOLATION`, `RATE_LIMITED`, `INTERNAL_ERROR`) plus representative domain
codes (e.g. `PAYMENT_ALREADY_REFUNDED`); the status-code table (400/401/403/404/409/422/
429/5xx) and what a client should do with each (retry only 429 and transient 5xx — with
`Retry-After` when present; never blindly retry 4xx); `X-Request-Id` on every response
and in the envelope, for support/issue reporting; the guarantee that responses never
contain internals (stack traces, SQL, secrets).

### 5.11 Logs, rate limits, and audit trail (handover obligations — Q2 confirmed in scope)

- **Rate limits** (Phase 13 D12 — authoritative source: `api-conventions.md` §10 +
  `openapi.yaml`): the scopes (`ip`, `api_key`, `account`; no session/org dimension), the
  operation-class catalog with **sandbox default numbers**, fixed windows anchored at the
  first counted request, what counts (including rejected requests; excluded: preflight,
  health, Swagger traffic), the response headers (`RateLimit-Limit/Remaining/Reset`,
  `Retry-After` on 429) and their CORS exposure, and `429` semantics (retryable; runs no
  handler; changes nothing; `error.details` carries budget numbers only; reveals nothing
  about credential existence). **Q1 answered: publish §10.1–10.5 only** (scopes, class
  catalog, headers, `429` semantics); §10.6–10.8 stay repository/operator documentation.
- **Request IDs and request logs** (Phase 11): `req_…` generation at ingress, propagation
  into logs/errors/webhook records, using the request ID when reporting issues, and the
  **30-day default retention** of request logs (Phase 11 D5) — documented for developers
  as the phase requires.
- **Audit logs** (Phase 12): append-only lifecycle (entries are never updated or
  deleted), deletion only by **organization cascade**, org-wide scope, dashboard
  visibility, session-only access (API keys → `401`), and the existence of a closed
  action/resource catalog — described at the level Phase 12 publishes, without
  reproducing internal actor/allowlist details (F2).

### 5.12 Sandbox usage guide (roadmap ordering — D6)

Source: master specification, Phase 7 §4.6, ADR-0003.

Required content: what "sandbox" means here (simulated payment infrastructure, **no real
money, no real card data**, both `TEST` and `LIVE` simulated); the default-success
simulation and how to observe it (`pending → processing → succeeded`, dashboard polling);
that the environment/model surface is identical to what a real integration would use;
**only implemented behavior** — decline/timeout/webhook-failure scenarios are Phase 16
and must not be described as available (D6 confirmed (a): publish now with this
constraint; Phase 16 extends the guide).

## 6. OpenAPI documentation and API reference (D2, D7)

- `docs/openapi.yaml` remains the **canonical, single contract** (ADR-0012): the API
  reference is *generated from it*, never hand-written, and no second contract may be
  authored (a hand-written reference is rejected — F3/D2 option (c)).
- The contract must be **discoverable from the docs area**: `/docs` and the index expose
  the API reference at the embedded `/docs/api-reference` route (D2 confirmed (a)), and
  `pnpm lint:openapi` (Redocly) stays at zero errors.
- **Documentation completeness:** every operation reachable from the reference shows its
  summary, description, security, parameters, and documented responses as authored;
  non-breaking documentation refinements (descriptions, examples, tag summaries) are
  permitted in this phase under **D7 (confirmed (a))**; any *semantic* change (path,
  schema, status code, required field) is a contract change and must be escalated, not
  made here.
- **Base URL handling:** the contract declares `servers: url: /api/v1` (relative). The
  published reference must present a usable base URL for the deployment (the configured
  API origin + `/api/v1`) or clearly instruct the reader to prefix it — it must not
  present a wrong absolute host.
- **Renderer requirements (D2 confirmed (a)):** it is bundled from the workspace
  dependency set (no remote asset origins), must not require `unsafe-eval`, renders at
  build time from the canonical file, and is validated against the Phase 14 CSP on a
  running build (§11.6).
- **Display-only (Q4 answered):** the embedded reference presents the contract; it does
  not send requests. "Try it" interactivity is out of scope (§14) — the API's Swagger UI
  remains the surface that offers it.
- The API's own Swagger UI (Phase 2 D5) keeps working unchanged and is linked as a
  secondary path; both surfaces render the same file and must not contradict each other.

## 7. Examples (cURL and code examples)

- **cURL is mandatory** for every guided flow that makes an API call: quickstart,
  authentication, payments, refunds, idempotency, webhooks (registration, delivery
  inspection, replay), and at least one error/rate-limit demonstration.
- **Code examples** (roadmap bullet separate from cURL): the language set is **D3
  confirmed (a)** — JavaScript `fetch` and Python `requests` alongside cURL — shown for
  the same core flows — create payment, create refund, verify webhook signature, retry
  after `429`.
- Every example must be **correct against the contract**: right method, path, headers
  (`Authorization`, `Content-Type`, `Idempotency-Key` where applicable, `X-Request-Id`
  awareness), body shape (`snake_case`, money as decimal string, lowercase environment),
  and the documented success/error response.
- **Placeholders only**: base URL as the configured API origin or an obvious placeholder
  (never a hardcoded environment hostname in content), keys as `sk_test_…`, secrets as
  `<your-signing-secret>`, IDs as obvious placeholders. No example may contain a working
  credential (§11.4, tested per §13).
- Signature-verification examples must implement exactly the §5.9 scheme (raw body,
  `t` + `v1`, HMAC-SHA256) — they are copy-paste reference implementations in prose, not
  a shipped library (§14).

## 8. Local development guide (D5 confirmed (a))

Scope (D5 confirmed (a): **both** audiences in one guide, no duplication with Phase 25):

- **Running BrinnPay itself:** prerequisites (pnpm via corepack, Docker), starting the
  stack with Docker Compose, service ports (API, web, PostgreSQL, Redis), applying
  migrations, running the required checks (`pnpm lint`, `pnpm lint:openapi`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`), and where the canonical
  artifacts live (`docs/openapi.yaml`, `docs/api-conventions.md`, this documentation
  area). Non-secret configuration only (§11.3).
- **Developing an integration locally:** pointing a local application at the sandbox API,
  using TEST keys, and receiving webhooks on `localhost` (allowed by default per
  ADR-0019), including the signature-verification gotcha of raw bodies behind common
  local frameworks.
- Phase 25 later **links or lightly adapts** this content for the public repository
  (README/CONTRIBUTING) instead of writing a second local-development document — recorded
  as this phase's handover (§18).

## 9. Cross-cutting requirements

1. **Link integrity:** every internal link in the docs area resolves to a route that
   exists in the application (the §4.1 table plus public/auth/dashboard routes); no
   orphaned pages (every guide reachable from the index); no links to Phase-16 or
   not-yet-built features (D6).
2. **Consistency protection (D8):** the small set of facts shared between published
   guides and canonical sources — rate-limit defaults, 24-hour idempotency retention,
   5-attempt webhook retry ladder, 30-day request-log/event retention, the signature
   format, the base error-code list — is guarded by automated checks (§13), so a future
   change to `api-conventions.md` or the contract cannot silently diverge from the
   published guides.
3. **Performance:** docs pages are static; no client-side fetching of content; the docs
   area adds no runtime dependency on API/Redis/PostgreSQL.
4. **Presentation** follows the Phase 14 design system (plain CSS tokens, buttons,
   code-block styling) so the docs area reads as the same product; no new UI dependency.
5. **No scope creep into the dashboard:** docs links may be added only where a link
   target already exists (the dashboard overview already links to docs); no new
   dashboard surfaces.

## 10. Data requirements

- **No new persistence, no migrations, no schema change, no new API endpoint.** This
  phase is content, presentation, and tests.
- Build-time inputs only: `docs/openapi.yaml` (if D2 embeds, per F8/§17) and the web
  app's own content files.
- Configuration consumed: the already-wired `NEXT_PUBLIC_API_BASE_URL` (for example base
  URLs / reference server resolution). **No new environment variables and no new
  secrets**; nothing sensitive may enter `NEXT_PUBLIC_*`.

## 11. Security requirements

1. **Public-area hygiene:** the docs area is static and unauthenticated; it contains no
   session material, tokens, cookies, key material, tenant data, or dashboard content
   (Phase 14 D9 assertions must pass unchanged in intent).
2. **No internal disclosure:** no infrastructure hostnames, database/Redis details,
   secret-bearing configuration, security-baseline internals (proxy trust, fail-mode
   tuning), or internal-only operational procedures (F2, §5.1 rule 3). Developer-facing
   substance of those artifacts may be re-authored; the artifacts themselves are not
   published.
3. **Secrets and examples:** placeholders only (§7); no real or reconstructable
   credentials, passwords, signing secrets, JWTs, or refresh tokens in content, code
   samples, or contract examples (verified by test, §13).
4. **Contract accuracy as a security control:** the docs must not document authorization
   behavior the API does not enforce (e.g. never suggest an API key carries organization
   authority, or that a `404`/`403` distinction can be probed).
5. **Injection/XSS:** guide content is rendered through React escaping; no
   `dangerouslySetInnerHTML` for any content source; if a renderer component is embedded
   (D2), it must not introduce an HTML-injection path from the contract file.
6. **CSP compatibility:** the Phase 14 header set keeps holding — no `unsafe-eval`, no
   new remote origins in `script-src`/`style-src`/`connect-src` beyond the already
   allowed API origin; validated on a running build with zero CSP violations (F9).
7. **External links** (if any are introduced): `rel="noopener noreferrer"`; docs introduce
   no third-party embeds, trackers, or remote fonts.
8. **Rate limiting:** docs traffic is static (excluded concerns do not apply); the docs
   area must never trigger authenticated API calls or automated retries.
9. **Secure logging:** no changes to logging; content tests must not embed credentials.
10. Security-sensitive aspects (CSP interaction, contract exposure) are in scope for the
    Phase 18 review; this phase must not introduce a known critical issue.

## 12. Acceptance criteria

1. `/docs` is a real documentation index listing every guide in §4.1, with quickstart and
   API-reference entry points, per-page metadata, and no authenticated content.
2. Every route in §4.1 exists, renders statically, is reachable from the index, and
   carries its own title/description; internal link integrity holds (§9.1).
3. A persistent, accessible section navigation appears on all docs pages and identifies
   the current page; public nav/footer "Docs" links land on the index.
4. Each guide in §5.3–§5.12 contains **all** required content for its section, matches
   the cited canonical source, and contains no invented behavior (§5.1).
5. The quickstart (§5.2) is completable end to end using only implemented behavior, with
   every step linked to its full guide, and requires no dashboard changes beyond existing
   links (D4).
6. The API reference is presented from `docs/openapi.yaml` per the confirmed D2, reachable
   from `/docs`, with no hand-written parallel contract; `pnpm lint:openapi` passes with
   zero errors.
7. Contract changes in this phase are limited to D7-permitted documentation refinements;
   no semantic change was made (diff review).
8. cURL examples appear for every guided flow in §7; the confirmed D3 language set is
   present for the core flows; all examples follow the contract (§7) and contain only
   placeholders.
9. The local-development guide matches the confirmed D5 scope and is the single source
   that Phase 25 will link (no duplicate content written here).
10. Published numeric/behavioral facts shared with canonical sources are protected by the
    automated consistency checks of §9.2/D8, and those checks pass.
11. The public-area security assertions (no session material, tokens, key material,
    dashboard content) pass for every docs route; no working credential appears anywhere
    in content or tests.
12. The app builds and runs with **zero CSP violations** and unchanged Phase 14 headers;
    if a renderer is embedded, it works with the shipped CSP (§11.6).
13. Docs pages are responsive at small mobile and desktop widths (no horizontal page
    scrolling; code blocks scroll internally) and meet the Phase 14 accessibility baseline.
14. Phase 14 tests that asserted the `/docs` stub are updated in the same change and the
    full checks pass locally and in CI: `pnpm lint`, `pnpm lint:openapi`,
    `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.
15. No API endpoint, contract-semantic, database, or migration change was introduced; no
    out-of-scope item (§14) was implemented.
16. Handover-mandated content (§5.11) is published (Q2 confirmed it in scope); the
    sandbox guide (§5.12) states only implemented behavior per D6.

## 13. Testing requirements

### 13.1 Web (`apps/web`)

- **Unit (vitest + RTL, existing patterns):**
  - Index: renders the complete section list with correct link targets; no authenticated
    content (extend the Phase 14 D9 assertions to every docs route).
  - Per guide: renders its required headings/sections and the key required facts (one
    focused test group per guide — e.g. idempotency guide states the 24-hour window;
    webhooks guide states the 5-attempt ladder and the `t=…,v1=…` scheme; refunds guide
    states omitted-`amount` = remaining balance; rate-limits guide states the class
    defaults).
  - Navigation: section nav present with current-page indication; every internal link
    resolves to a known route (link-integrity test over the docs area).
  - Metadata: each docs page exports a title/description matching its subject.
  - Consistency checks (D8): published shared facts equal their canonical source
    (parsed from `docs/api-conventions.md` / `docs/openapi.yaml` / shared constants as
    applicable) — these fail when either side drifts.
  - Examples hygiene (§11.3): no content or test fixture contains a string matching a
    real-looking credential outside the documented placeholder patterns; signature example
    verifies a known vector for `${t}.${rawBody}`.
  - API reference (embedded, D2): renders operation summaries/paths from the loaded
    contract fixture; the "no parallel contract" rule is asserted by having the test load
    the canonical file; the reference sends no requests (display-only, Q4).
  - Regression: all Phases 3–14 web suites keep passing (including the re-scoped stub
    assertions now pointing at real content).
- **E2E smoke (`test:e2e`, established jsdom pattern):**
  - Public flow: home → docs index → quickstart → one technical guide → API reference
    (or link-out), all static, no authenticated content, navigation intact.
  - A smoke asserting the docs area renders without an API being stubbed (proves no
    runtime API dependency).

### 13.2 Shared

- Repository-root checks: `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:e2e`, `pnpm build` — green locally and in CI.
- No secrets in test data or fixtures; tests assert roles/names/behavior, not styling
  internals (Phase 14 rule).
- Manual verification on a running build for CSP (§11.6) and responsive layouts.

## 14. Out of scope

- **Any API endpoint, contract-semantic, database, migration, worker, or auth change.**
  Contract work is limited to D7 documentation refinements; anything else escalates
  (AGENTS.md).
- **SDKs, client libraries, CLI, and a shipped webhook-verification package** (master
  specification "Future"; examples remain in-document per §7).
- **Docs search, full-text filtering, versioned/multi-version docs** (only API `v1` exists
  — ADR-0005), i18n, dark mode, comments/analytics, or third-party docs tooling as a
  hosted service.
- **Interactive "try it" console** — Q4 answered: the embedded reference is display-only,
  so no API-backed playground is built; it is a product feature, not documentation.
- **Dashboard/onboarding UI changes** (D4 confirmed (a)) and any new dashboard
  surface (§9.5).
- **Phase 16 content**: decline/timeout/webhook-failure scenarios, failure-code catalog,
  sandbox scenario triggers (D6 confirmed (a)).
- **README, CONTRIBUTING, SECURITY, LICENSE, issue/PR templates** — Phase 25; this phase's
  local-development guide is their future source (§18).
- **Pricing, legal, and marketing pages**, session-aware public navigation, and any
  content the master specification leaves out of the MVP.
- **ROADMAP.md checkbox bookkeeping** (Q3 answered: stays outside this phase's file
  scope) and `.ai/` artifact restructuring.
- **Performance/load work (Phase 19), the systematic security review (Phase 18),
  browser-real e2e tooling (Phase 17).**

## 15. Decisions (D1–D8 — confirmed 2026-10-06)

Each decision listed options and a recommendation. **The product authority confirmed all
eight decisions on 2026-10-06, choosing the recommended option (a) in every case. The
choices below are binding for implementation; ADRs for D1 and D2 are recorded as
ADR-0029 and ADR-0030.**

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Docs authoring format and relationship to root `docs/*.md` | **(a) Author content as web-app content (TSX pages/components), re-authored for a public audience, citing canonical sources** — zero new dependencies (consistent with Phase 14 D1), fits existing tests/build/mounts. (b) MDX/markdown pipeline in `apps/web` — better long-form ergonomics, adds a dependency and test/build configuration; viable if content volume proves unmanageable. (c) Build-time rendering of root `docs/*.md` — **rejected**: publishes internal material (phase/ADR references, security-baseline internals) and couples public docs to architecture artifacts (F2). | Confirmed (a) 2026-10-06 |
| D2 | API reference mechanism | **(a) Embedded reference at `/docs/api-reference`, generated at build time from `docs/openapi.yaml` with a bundled renderer** — first-party, single origin, contract stays canonical; costs one dependency plus CSP validation. (b) Link out to the API's existing Swagger UI at `{API origin}/docs` — zero new code, already renders the canonical contract; cross-origin UX and depends on Swagger remaining exposed in the deployment. (c) Hand-written reference — **rejected** (ADR-0012: parallel contract, guaranteed drift). Recommendation: **(a)**, keeping (b) as a documented secondary path (both can coexist since they render the same file). | Confirmed (a) 2026-10-06 |
| D3 | Code-example language set | **(a) cURL + JavaScript (`fetch`) + Python (`requests`)** — the three flows-relevant languages, no SDK implied. (b) cURL only (roadmap lists "code examples" separately, so cURL alone under-delivers). (c) more languages — not justified without SDKs. Recommendation: **(a)**, with cURL mandatory everywhere (§7). | Confirmed (a) 2026-10-06 |
| D4 | Meaning of "Developer onboarding flow" | **(a) Docs quickstart at `/docs/quickstart` (§5.2), no dashboard changes** — smallest, no contract/API impact, Phase 14 overview already guides in-product. (b) Dashboard first-run onboarding UI — would modify Phase 14's shipped dashboard scope. Recommendation: **(a)**. | Confirmed (a) 2026-10-06 |
| D5 | Scope of "Local development guide" and the Phase 25 overlap | **(a) One guide with both audiences** (§8): running BrinnPay locally + developing an integration locally (localhost webhooks); Phase 25 links/adapts it. (b) Integration-local only, deferring repo-contribution content to Phase 25. (c) Defer the whole bullet to Phase 25 — **rejected**: the roadmap places it in Phase 15. Recommendation: **(a)**. | Confirmed (a) 2026-10-06 |
| D6 | Sandbox guide vs Phase 16 ordering | **(a) Publish now, documenting only implemented behavior** (default-success simulation; no failure triggers presented as available); Phase 16 extends the guide. (b) Move the roadmap bullet to Phase 16 (roadmap amendment outside this phase's file scope). Recommendation: **(a)** — the checkbox is claimed by Phase 15 with D6's constraint. | Confirmed (a) 2026-10-06 |
| D7 | Scope of `docs/openapi.yaml` edits in this phase | **(a) Permit non-breaking documentation refinements** (descriptions, examples, summaries/tags) required for a good reference; lint must stay clean; semantic changes escalate. (b) Freeze the contract entirely this phase — risks a reference that documents gaps the contract already admits. Recommendation: **(a)**. | Confirmed (a) 2026-10-06 |
| D8 | Drift protection between guides and canonical sources | **(a) Automated content-consistency checks** for the shared numeric/behavioral facts (§9.2) **plus** human review for prose. (b) Review-only — rejected: three surfaces (contract, conventions, guides) already repeat the rate-limit and idempotency facts. Recommendation: **(a)**. | Confirmed (a) 2026-10-06 |

## 16. Open questions — answered 2026-10-06

1. **Q1 — Public vs operator-facing content in `docs/api-conventions.md` §10.
   Answered: publish §10.1–10.5 only.** Scopes, class catalog, headers, and `429`
   semantics are developer-facing and rendered publicly; §10.6–10.8 (Redis fail-open/
   fail-closed posture, trusted-proxy configuration, environment-variable table) remain
   repository/operator documentation and are not published. The local development guide
   does not list the rate-limit environment variables. The same client/operator line
   applies to ADR-0019: §5.9 publishes only the developer-facing subset, never the
   allow/deny-list internals.
2. **Q2 — Handover guides missing from the Phase 15 roadmap list. Answered: §5.11 is in
   scope for Phase 15.** The Phase 13 D12, Phase 11, and Phase 12 obligations are
   discharged by this phase despite the missing roadmap bullets; Phase 13's documentation
   checkbox stands as checked.
3. **Q3 — ROADMAP.md bookkeeping. Answered: ROADMAP updates stay outside this phase's
   file scope** (same treatment as Phase 14 F10). The unlinked checkboxes are reported to
   the maintainer; this phase does not edit ROADMAP.md.
4. **Q4 — Interactivity of the API reference. Answered: display-only.** The embedded
   reference presents the contract and sends no requests; no "try it out" console, no
   widened `connect-src`, no CORS expectations. The API's Swagger UI remains the surface
   that can offer interactivity.

## 17. Implementation considerations (not new requirements)

- Keep all guide content inside `apps/web` (D1 confirmed (a)); if content or the
  contract is read from outside `apps/web` at build/dev time, the Docker web mounts
  (`docker/compose.yml`) and `docker/web/Dockerfile` must gain that path — the Phase 14
  mount note is the precedent; keep any such change minimal.
- Rendering `docs/openapi.yaml` in the web build needs a build-time import across the
  monorepo boundary (build context is the repo root, so the file is available); do **not**
  fetch it from the API at runtime (adds a runtime dependency and a CORS surface).
- The contract's `servers: url` is relative — resolve it against the configured API
  origin for display rather than inventing a hostname.
- Update `public-pages.spec.tsx` and `home.smoke.spec.tsx` stub assertions in the same
  change that adds content (F1), citing this specification; do not weaken the D9
  no-authenticated-content assertions.
- Prefer shared presentational components (code block, callout, section nav) inside
  `apps/web`; no new workspace packages (master specification).
- Styling must not change accessible names/roles existing tests assert.
- No API changes: resist "fixing" backend gaps discovered while writing docs — record
  them as findings and escalate (AGENTS.md).
- ADRs for the confirmed D1 and D2 are recorded as ADR-0029 (docs authoring strategy)
  and ADR-0030 (API reference mechanism), in `.ai/decisions/`.
- CONTENT DISCIPLINE: when a fact is uncertain, open a question against the canonical
  artifact instead of phrasing around it (AGENTS.md ambiguity rule).

## 18. Dependencies and handovers discharged

| Source | Obligation | Where |
| --- | --- | --- |
| Phase 1 §11.1 / `docs/web-application-structure.md` | `/docs/**` documentation and integration guides | §4 |
| Phase 1 §7 / `docs/api-conventions.md` | Restate conventions accurately; §10 rendered publicly (Q1: §10.1–10.5) | §5.1, §5.11 |
| Phase 1 §13.2 / ADR-0012 | Contract stays the single source; reference generated from it | §6, D2, D7 |
| Phase 2 D5 | Swagger UI from the canonical contract — keep working; secondary reference path | §6, D2 |
| Phase 8 / ADR-0004 | Explain now-live payment (and refund) idempotency | §5.8 |
| Phase 10 D7/D9 | Signature scheme, retry ladder, retention, destination rules documented publicly | §5.9 |
| Phase 11 D5 / handover | Request-ID guidance + 30-day retention documented for developers | §5.11 (Q2 in scope) |
| Phase 12 §6.4 / handover | Append-only lifecycle + org-cascade documented | §5.11 (Q2 in scope) |
| Phase 13 D12 / handover | Public rate-limit guide from §6.2/§6.3 material | §5.11 (Q1, Q2 in scope) |
| Phase 14 §4.1 / D9 / §7.5 | `/docs` stub replaced; public-area content rule; CSP preserved | §4.2, §11, §13 |
| Phase 14 handover | "Documentation deep-dives are Phase 15" | §4, §5 |
| Master specification MVP #15 | Public API and integration documentation | §4–§8 |
| Master specification | No invented features; sandbox honesty; accessible DX | §5.1, §11, §9 |

**Blocks (as recorded in the metadata):** Phase 16 (sandbox guide extension), Phase 17
(docs flows in e2e), Phase 25 (local-development/README reuse — do not duplicate),
Phase 26 (verify API documentation).

## 19. Definition of done

- Decisions D1–D8 are confirmed and Q1–Q4 answered by the product authority (done
  2026-10-06); the status line reflects confirmation.
- All §12 acceptance criteria satisfied, including the §5 guide inventory and the
  handovers in §18.
- Roadmap Phase 15 checkboxes are demonstrably covered (traceability in §1), including
  the Q2-confirmed handover additions.
- Tests: §13 suites pass — `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:e2e`, `pnpm build` green locally and in CI; no regression in
  the Phases 3–14 web suites.
- Security: §11 satisfied; zero CSP violations on a running build; no working credential
  anywhere in content, examples, or tests; security-sensitive parts flagged for Phase 18.
- ADRs for D1/D2 recorded (ADR-0029, ADR-0030); `docs/openapi.yaml` lints clean
  and any D7 refinements are non-breaking.
- No API/contract-semantic/database change was introduced; no out-of-scope item (§14) was
  implemented.
