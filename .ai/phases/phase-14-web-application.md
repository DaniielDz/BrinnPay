# Phase 14 — Web Application

| | |
| --- | --- |
| Phase | 14 — Web Application |
| Status | **Confirmed (2026-10-05) — D1–D9 and Q1–Q6 answered by the product authority; implementation-ready.** |
| Depends on | Phase 1 (§11 route boundaries, session model, public/authenticated split), Phase 2 (routing skeleton, error envelope, CORS, request IDs), Phase 3 (authentication UI, session handling, `AuthGuard`/`GuestGuard`), Phase 4 (organizations/members/invitations UI), Phase 5 (projects, API keys, project shell), Phase 6 (customers), Phase 7 (payments), Phase 8 (idempotent writes the UI relies on), Phase 9 (refunds), Phase 10 (webhooks), Phase 11 (request-log viewer), Phase 12 (audit-log viewer, D12), Phase 13 (429 semantics, browser-visible rate-limit headers) |
| Blocks | Phase 15 (public shell and `/docs` navigation integrate into the finished public area), Phase 16 (sandbox scenario triggers gain a UI hook in the payments view), Phase 17 (browser e2e targets the finished UI), Phase 18 (web security review covers the headers added here), Phase 26 (verify public web experience and dashboard critical flows) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 14 |

## 1. Objective

Deliver the **complete BrinnPay web experience** in the single Next.js application
(`apps/web`): a real public site, integrated authentication flows, and a finished,
consistent, responsive, accessible developer dashboard.

Phases 3–13 each delivered their functional UI slice against a skeletal shell. This phase
does not add product features to the API; it **completes and consolidates** the web
application:

1. **Public area** — home, product overview, navigation and footer, with no authenticated
   material (Phase 1 §11.1).
2. **Authentication area** — login/registration flows (Phase 3) presented inside the
   consistent application layout, behavior unchanged.
3. **Authenticated area** — a real dashboard shell and navigation, a dashboard overview,
   an account settings surface, and a consistency pass over every feature view.
4. **Cross-cutting** — responsive layout, authentication-aware route protection,
   consistent error/empty/loading states, `429` presented as retryable with a
   rate-limit budget indicator, and security headers on web responses.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| Public home page | §4.1 |
| Product overview pages | §4.1 |
| Public navigation and footer | §4.2 |
| Login flow | §5 (integration only; behavior is Phase 3) |
| Registration flow | §5 (integration only; behavior is Phase 3) |
| Authenticated dashboard shell | §6.1 |
| Dashboard overview | §6.2 |
| Payments view | §6.4 (completeness/polish only; Phase 7 delivered it) |
| Customers view | §6.4 (completeness/polish only; Phase 6 delivered it) |
| Refunds view | §6.4 (completeness/polish only; Phase 9 delivered it) |
| Webhooks management | §6.4 (completeness/polish only; Phase 10 delivered it) |
| API keys management | §6.4 (completeness/polish only; Phase 5 delivered it) |
| Projects management | §6.4 (completeness/polish only; Phase 5 delivered it) |
| Organizations and settings | §6.3 (settings), §6.4 (organizations polish; Phase 4 delivered them) |
| Request logs viewer | §6.4 (completeness/polish only; Phase 11 delivered it) |
| Audit logs viewer | §6.4 (completeness/polish only; Phase 12 delivered it; Q1 resolved — route kept) |
| Responsive layout | §7.1 |
| Authentication-aware route protection | §7.2 |
| Consistent application layout and navigation | §6.1, §7.1 |
| (handover) Web security headers | §7.5 (Phase 2 handover, security baseline mapping) |
| (handover) `429` retryable presentation + budget indicator | §7.3, §7.4 (Phase 13 §7) |

## 2. Scope

In scope:

- **Public pages:** `/` (home), `/product` (product overview), and the public
  navigation/footer. `/docs` stays a clearly marked entry point — its content is
  Phase 15.
- **Auth area:** layout consistency for `/login` and `/register`; no behavioral change to
  the Phase 3 flows, session handling, or guards.
- **Dashboard shell:** consistent layout and navigation for `/dashboard/**`, including
  the signed-in identity and sign-out controls.
- **Dashboard overview** at `/dashboard` (§6.2, D2 confirmed).
- **Settings** at `/dashboard/settings` (§6.3, D3 confirmed).
- **Interactive TEST/LIVE environment selector** in the project shell (§6.5, D4).
- **Completeness/consistency pass** over the feature views delivered by Phases 4–12:
  shared states (loading, empty, error, not-found), navigation, and presentation
  consistency — **no domain or API behavior changes** (§6.4).
- **Cross-cutting web requirements:** styling foundation and responsive layout (§7.1),
  route protection verification (§7.2), error/`429` presentation (§7.3), rate-limit
  budget surfacing (§7.4), web security headers (§7.5), accessibility baseline (§7.6).
- **Tests:** update and extend the established `apps/web` unit and smoke suites (§11).

Explicitly not in scope (§12): any API/contract/DB change, documentation content
(Phase 15), sandbox scenario selection (Phase 16), browser e2e tooling (Phase 17),
the security-hardening review (Phase 18), performance work (Phase 19), new shared
packages, and account-management features that have no API (profile edit, password
change).

## 3. Context and current-state findings

**What exists today** (branch `chore/phase-14-web-app`, Phases 1–13 merged):

- Route groups `(public)`, `(auth)`, `(dashboard)` exist with the Phase 1 route list;
  `AuthProvider` (in-memory access token, refresh restore), `AuthGuard`, `GuestGuard`
  and `SignOutButton` implement the Phase 3 session model.
- Feature pages are implemented and tested: organizations + detail + invitations,
  projects + shell + API keys, customers, payments, refunds, webhooks, request logs,
  audit logs. `lib/brinnpay/client.ts` covers the whole contracted surface with
  `ApiClientError { status, code, message, requestId }`.
- **Placeholders remain:** public home (two sentences), `/product`, dashboard overview,
  `/dashboard/settings`; `/docs` is an intentional Phase 15 stub.
- **No stylesheet exists anywhere in `apps/web`.** Semantic class names
  (`dashboard-shell`, `env-badge`, `payment-status`, `environment-selector`, …) are
  already used by pages, but nothing styles them; "responsive layout" and "consistent
  layout" are entirely undelivered.
- Rate limiting (Phase 13) now returns `RateLimit-*`/`Retry-After` headers on every
  contracted route and exposes them to browser JavaScript via CORS, but the web client
  neither reads them nor distinguishes `429` from other failures.

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | Public pages are placeholders; the public nav has **no login/registration CTA** (only Home/Product/Docs), and the footer is one line. | §4.1/§4.2 — real home + product copy, complete navigation and footer. |
| F2 | Dashboard overview and settings are placeholders. Settings has **no backing API** (no profile-update or password endpoint exists; Phase 3 explicitly deferred them), so "account settings" cannot mean editing. | D3 (confirmed) — read-only account surface; adding API scope would be a contract change, not a UI task. |
| F3 | There is no styling at all: no CSS file, no design tokens, no responsive behavior. The styling approach is undecided (plain CSS vs Tailwind vs CSS Modules vs component library). | D1 (confirmed) — plain CSS, chosen before implementation; no new dependency. |
| F4 | The TEST/LIVE "environment selector" renders **display-only `<span>`s**: state comes from the `environment` query parameter, but the user cannot switch environments from the UI (deep-linking only). Phase 5 §5.3 delivered it as "query parameter or client state"; the roadmap checkbox implies an operable control. | §6.5 (D4) — make it an operable control that updates the query parameter; deep-link and default (`test`) semantics unchanged. |
| F5 | The web client presents every API failure identically (`err.message`): a `429 RATE_LIMITED` reads like a generic failure, violating the Phase 13 handover ("treat a 429 as retryable, never as an authorization or data problem"), and the exposed budget headers are unused. | §7.3/§7.4 (D6, D8 confirmed). |
| F6 | Route protection is client-side only, and **cannot** be moved to server middleware as-is: the refresh cookie is path-scoped to `/api/v1/auth`, so it is never sent to web-app routes and middleware cannot observe a session. Server-side gating would require an API cookie change or a new client-readable session cookie — both contradict Phase 1 §11.5. | D5 — client-side guards remain the routing gate; verification/completeness is the requirement (§7.2). The API remains the enforcement point. |
| F7 | The public smoke tests ban words like "log in", "payments", "api keys" on the home page (Phase 2/3 assertions). A real marketing home page must mention the product and offer a login CTA, so the literal word-bans encode "no authenticated content" incorrectly. | D9 — re-scope the assertions to "no session material, tokens, keys, or authenticated/dashboard content", not to marketing vocabulary. |
| F8 | Every feature view already exists, but states, headings, back-navigation, and error presentation were built phase-by-phase and are not uniform; Phases 4/5/6/7 each recorded "full dashboard polish is Phase 14". | §6.4 — a bounded consistency pass; no functional regression. |
| F9 | Phase 12 D12 left the audit viewer's **project-scoped route** (organization-wide data) open, naming Phase 14 as the point where a route restructure could happen. | Q1 (resolved) — keep the current route; no Phase 1/`docs/web-application-structure.md` amendment. |
| F10 | Roadmap checkboxes for Phases 4–12 are still unchecked although those phases are merged (Phase 13 is checked). Documentation inconsistency only. | Reported, not fixed here (ROADMAP.md is outside this phase's file scope); see §16. |
| F11 | Web security headers were explicitly deferred twice (Phase 2 §4.2 and the security baseline mapping: "Security headers on web responses → Phase 14"). `next.config.ts` sets none. | §7.5 (D7). |
| F12 | No custom not-found/error page exists (Next.js defaults render for unknown routes inside the app shell areas). | Q6 (resolved) — leave defaults; out of scope this phase. |

## 4. Public area — `apps/web`

### 4.1 Public pages

- **Home `/`** must present BrinnPay to a developer evaluating it: what it is (payment
  infrastructure **sandbox**, no real money — master specification), the core capabilities
  (payments, refunds, idempotency, webhooks/retries, API keys, request/audit logs, rate
  limiting, sandbox scenarios), how integration works at a glance (API key → call →
  webhook), and clear calls to action: **get started (register)** and **read the docs**.
- **Product `/product`** must give the product overview: the feature areas above as
  described by the master specification, TEST/LIVE simulated environments, and the
  developer-facing surfaces (REST API, OpenAPI, webhooks, dashboard). Sub-pages under
  `/product` are not required in this phase (the roadmap item is satisfied by the
  overview page).
- Content must be accurate to the specification — no invented features, no pricing, no
  guarantees the product does not make (pricing/plans only "when applicable" per master
  specification; none is applicable now).
- **`/docs`** remains an entry point that states documentation arrives with the developer
  experience area (Phase 15); it must not grow guide content in this phase.
- Public pages remain **static server-rendered** (no session, no access token, no
  client-side API calls, no dashboard data). Per-page metadata (title/description) is set
  for home and product; the root layout keeps the BrinnPay identity.
- Public routes must never expose authenticated data, internal architecture specifics,
  environment URLs, or any sensitive material (Phase 1 §11.1, Phase 2 §9.8).

### 4.2 Public navigation and footer

- Navigation: Home, Product, Docs, plus authentication CTAs **Log in** and **Get
  started** (→ `/login`, `/register`). Semantic `<nav>` with an accessible name, as the
  route-group tests already assert for area separation.
- Footer: product identity line, links to Product, Docs, Login, and a plain statement
  that BrinnPay is a sandbox that processes no real money.
- The public shell is shared by `/` and `/product` (and the `/docs` stub); no
  authenticated material appears in it regardless of session state (see D9 for the test
  assertion scope). Session-aware public navigation (e.g., a "Dashboard" link when
  signed in) is **not** required.

## 5. Authentication area

- `/login` and `/register` keep their Phase 3 behavior exactly: same fields, same API
  calls, `GuestGuard` redirect of authenticated visitors to `/dashboard`, errors
  surfaced from the API (including rate-limit errors).
- The only change is presentation: the auth pages render inside the consistent
  application layout (branding, navigation consistent with §4.2/§6.1, responsive).
- No session material, cookie names, or tokens may appear in the auth pages' rendered
  output (existing tests already assert this and must keep passing).

## 6. Authenticated area — `apps/web`

### 6.1 Dashboard shell and navigation

The authenticated area must have one consistent shell used by every `/dashboard/**`
route:

- **Navigation:** Overview, Organizations, Projects, Settings (existing set), with a
  visible current-location (active) state. Project-scoped child navigation stays in the
  project shell (Phase 5 §5.3 workspace links); the shell must not duplicate or hide it.
- **Header:** the signed-in identity (user name/email from the session) and the
  **Sign out** control (existing `SignOutButton`); plus the rate-limit budget indicator
  when enabled (§7.4, D8 confirmed).
- The shell renders only inside `AuthGuard`: no shell flash for unauthenticated visitors,
  no shell content before the session state resolves (existing behavior — regression
  guarded by the route-group tests).
- The shell is the single place where global navigation, identity, and sign-out live;
  feature pages must not re-implement them.

### 6.2 Dashboard overview (`/dashboard`)

The overview replaces the placeholder and must answer "where do I go next?" using
**existing read endpoints only** (D2 confirmed):

- The caller's organizations (with the caller's role) and projects (with owning
  organization and TEST/LIVE context), each linking to its detail page — first page
  only, cursor contract respected, no client-side accumulation.
- Quick links: create organization, create project, docs entry point, settings.
- Empty state: because registration transactionally creates a default personal
  organization (Phase 3 D4, ADR-0010), a new account always has at least one
  organization — the primary empty state is therefore **"no projects yet"** with a
  guided first step (create a project in the default organization). A "no
  organizations" state may still be rendered defensively (e.g., the list resolves
  empty) and must then guide creating one.
- Loading and error states follow §7.3. No metrics, counts, charts, or aggregates —
  those would require new API surface (Q3 resolved: metrics stay out).

### 6.3 Settings (`/dashboard/settings`)

Per D3 (confirmed — read-only):

- Display the account identity from the session/`GET /auth/me`: email, name, user ID,
  created timestamp.
- Session controls: **Sign out**. Display of public configuration (e.g., the API base
  URL used by the dashboard) is allowed — it is not sensitive — but never secrets,
  tokens, or cookie material.
- Link out to Docs and Product pages.
- **No profile editing, password change, or account deletion** — no API exists for them
  (Phase 3 out-of-scope; would be a contract + API change — Q2 resolved: out of
  scope for this phase).
- The page renders behind `AuthGuard` like every dashboard route.

### 6.4 Feature views — completeness and consistency pass

The views delivered by Phases 4–12 (organizations, organization detail, invitations,
projects, project shell, API keys, customers, payments, refunds, webhooks, request logs,
audit logs) are **functionally complete**. This phase performs a bounded presentation
pass so the dashboard behaves as one product:

- Every view handles and presents the four states uniformly: **loading**, **empty**
  (with a next action where one exists), **error** (message + request ID where
  available, per §7.3), **not-found** (non-member/inaccessible resource, mirroring the
  API's 404 as the existing pages already do).
- Uniform heading levels, back-navigation pattern, and placement of page titles/badges
  (environment badges remain the existing `env-badge` semantics).
- Role-based presentation rules stay exactly as specified by the capability matrix:
  hiding controls is presentation only; the API remains the enforcement point; no page
  may fetch without a session, cross scopes via direct URLs, or display data the API
  would refuse.
- Behavior preserved: cursor pagination ("Load more"), debounced customer search,
  payment lifecycle polling, once-only API-key plaintext display, webhook replay
  confirmations, log filters (environment, request-ID lookup), audit entry rendering.
- Feature pages gain no new product features; sandbox-scenario triggers (Phase 16) and
  documentation deep-dives (Phase 15) are added later, on top of this pass.
- **Audit-log viewer location (Q1 resolved):** the viewer stays at
  `/dashboard/projects/[projectId]/logs/audit` (labeled organization-wide, Phase 12
  D12); no route relocation, no Phase 1 §11.3 or `docs/web-application-structure.md`
  route amendment. Its content rules are unchanged.

### 6.5 Environment selector (project shell)

- The TEST/LIVE selector becomes an **operable control** (D4): choosing an environment
  updates the `environment` query parameter, which the shell already propagates to every
  environment-scoped child link, and the child views reload for the selected
  environment.
- Semantics unchanged: default `test`; deep links (`?environment=live`) keep working;
  invalid values fall back to `test`; TEST/LIVE data is never mixed; the API-keys page
  remains project-wide (Phase 5 D5) regardless of the selection.
- The control must be keyboard-operable and expose the selected value to assistive
  technology (a group of buttons/tabs with a clear selected state — not inert spans).

## 7. Cross-cutting web requirements

### 7.1 Styling foundation and responsive layout

- The application must ship an actual visual design: a styling foundation (D1 confirmed
  — plain CSS),
  applied to public, auth, and dashboard areas alike, built on the semantic class names
  already present so page behavior and tests are not rewritten for styling's sake.
- **Responsive:** all three areas work from small mobile widths to desktop without
  horizontal scrolling or clipped controls. The dashboard navigation must remain
  reachable on small screens via an accessible disclosure (button with `aria-expanded`
  controlling the nav) or an equivalent responsive pattern; tables/lists reflow or
  scroll within their own region rather than breaking the page.
- One consistent visual language: typography scale, spacing, color tokens, focus
  visibility, status colors (payment status, environment badges, danger actions).
- Styling must not change accessible names/roles that tests and assistive technology
  rely on (headings, nav labels, button names).

### 7.2 Route protection (authentication-aware)

Requirements (verification + completion; D5):

- Every route under `/dashboard/**` renders behind `AuthGuard`: unauthenticated visitors
  are redirected to `/login` and see no shell or data; while the session state is
  resolving, no protected content is shown.
- `/login` and `/register` render behind `GuestGuard`: authenticated visitors are
  redirected to `/dashboard`.
- No dashboard route performs an API call without a session token; no page bypasses
  API-level authorization; 401 from the API means re-authenticate (existing behavior),
  403/404 render the appropriate state without leaking data (§7.3).
- Server-side (middleware) gating is **not** required and is structurally unavailable
  without an API cookie change (F6/D5). The API remains the sole enforcement point.

### 7.3 Error presentation (including `429`)

A single, consistent error presentation rule across the app (D6):

| Condition | Required presentation |
| --- | --- |
| Validation (400) | Field/message error from the API envelope; form stays filled. |
| Unauthenticated (401) | Re-authenticate: attempt refresh via existing session flow; if it fails, redirect to `/login`. Never shown as a generic failure. |
| Forbidden (403) | Permission state ("your role cannot perform this"), not an error crash; controls hidden per role. |
| Not found (404) | Existing not-found state (mirrors API 404 semantics), no data leak. |
| Conflict/unprocessable (409/422) | The API's message (e.g., last-owner invariant), displayed as the reason the action was refused. |
| Rate limited (429, `RATE_LIMITED`) | **Retryable, transient** condition: say so, include the retry delay from `Retry-After` when present (D6). Never presented as an authorization, session, or data problem (Phase 13 handover). |
| Server/network (5xx, fetch failure) | Generic retryable failure with the request ID when available; no stack traces, no internals. |

- Errors surface with `role="alert"` (existing pattern) and include the API's
  `request_id` where the envelope provides it (issue-reporting flow,
  `docs/api-conventions.md` §7).
- The API client must capture `Retry-After` (and, for §7.4, the `RateLimit-*` values)
  from responses so pages can present them; header values are presentation data only.

### 7.4 Rate-limit budget surfacing (Phase 13 handover)

Per D8 (confirmed — both):

- **Budget indicator:** after successful API responses, the dashboard shell shows the
  remaining budget of the reported bucket (`RateLimit-Remaining`/`RateLimit-Limit`, and
  reset when meaningful) in a compact, non-intrusive form. When headers are absent
  (older proxy, failed preflight, excluded route), the indicator is silent — an absent
  indicator is never an error.
- **429 handling** as per §7.3, including a retry affordance (disable/retry after the
  indicated delay) on the action that was throttled.
- Only budget numbers may be displayed: never the internal class name, scope
  discriminator, key, or Redis key (Phase 13 §4.4 point 5).

### 7.5 Web security headers

Fulfilling the Phase 2 handover and `docs/security-baseline.md` ("Security headers on
web responses → Phase 14"; CSP, HSTS in production, etc.):

- The web application must send, on its responses: a **Content-Security-Policy**
  sufficient for the app to function (self sources; `connect-src` covering the
  configured API origin; no `unsafe-eval` in production), **X-Content-Type-Options:
  nosniff**, a **frame-ancestors** restriction (clickjacking), **Referrer-Policy**, and
  **Strict-Transport-Security in production/secure environments only** (never forced on
  plain-HTTP local development). Additional hardening directives (e.g.,
  `Permissions-Policy`) may be included.
- The exact directive set must be validated against the running app: no console CSP
  violations in normal use, no broken styles/scripts, and the API calls (cross-origin,
  credentialed) still succeed with the rate-limit headers readable (Phase 13 Q3).
- Headers are configuration (D7), covered by tests (§11), and picked up by the Phase 18
  security review.

### 7.6 Accessibility baseline

The master specification requires an accessible developer experience. Baseline for this
phase: semantic landmarks and heading order; labels and accessible names on all
controls; keyboard operation of navigation, the environment selector, dialogs/
confirmations, and disclosures; visible focus; status messages announced (`role="alert"`
/ live regions for async results); contrast sufficient for text and status colors;
`prefers-reduced-motion` respected if any motion is introduced. Full audit is Phase 18.

## 8. Data requirements

- **No new persistence, no migrations, no schema or contract changes.** This phase only
  consumes existing endpoints through the existing API client.
- Browser state only: the in-memory access token (Phase 1/3 rules — never
  `localStorage`/`sessionStorage`), the `HttpOnly` refresh cookie owned by the API, and
  URL state (`environment` query parameter). No tokens, API keys, or secrets in URLs,
  rendered output, or client storage beyond the documented once-only key display.
- Configuration consumed: `NEXT_PUBLIC_API_BASE_URL` (already wired, docker default
  `http://localhost:3000/api/v1`). No new secrets; nothing sensitive may be introduced
  into `NEXT_PUBLIC_*` variables.

## 9. Security requirements

1. **Public area hygiene:** no authenticated data, session material, internal
   architecture details, or environment/infrastructure specifics on public routes;
   public pages perform no authenticated requests.
2. **Session rules preserved:** access token in memory only; refresh token only via the
   `HttpOnly` cookie; logout revokes server-side and clears state; tokens and cookie
   names never rendered or logged (console or otherwise).
3. **Authorization:** the API is the enforcement point on every request; UI hiding is
   presentation only; direct URLs, stale state, and crafted queries must not reveal
   cross-tenant data (the API's 404/403 renders as the corresponding state).
4. **Route protection** per §7.2; no protected content before session resolution.
5. **Secrets:** no secrets in the client bundle, config, or repository; API keys remain
   display-once; webhook secrets never displayed after creation; rate-limit internals
   never displayed (§7.4).
6. **Web security headers** per §7.5 (CSP as the primary XSS boundary on the web
   responses; HSTS production-only).
7. **Error safety:** responses rendered to users never contain stack traces, SQL,
   connection strings, or internal hostnames; request IDs are safe to display.
8. **Injection/XSS:** all dynamic content is rendered through React's escaping; no
   `dangerouslySetInnerHTML` for API-sourced content; URLs rendered as links are
   validated (webhook destinations are user input — render as text unless scheme-
   validated).
9. **Rate limiting:** the dashboard behaves as a well-mannered client (§7.3/§7.4) and
   never retries aggressively in a tight loop.
10. **Secure logging:** the web app writes no tokens, keys, or passwords to logs; client
    errors shown to users are the API's sanitized messages.
11. Security-sensitive parts of this phase (headers, error/authorization states) get an
    explicit review as part of Phase 18; this phase must not introduce known critical
    issues.

## 10. Acceptance criteria

1. `/` renders a real home page (product statement, capability overview, CTAs to
   register and docs) with per-page metadata, static, with no session material.
2. `/product` renders the product overview consistent with the master specification; no
   invented features or pricing; `/docs` remains a Phase 15 entry point.
3. Public navigation exposes Home, Product, Docs, Log in, Get started; footer present on
   public pages; both areas responsive (§7.1).
4. `/login` and `/register` behave exactly as Phase 3 specified and render inside the
   consistent layout; existing auth tests pass unchanged in behavior.
5. Every `/dashboard/**` route renders inside one shell with Overview/Organizations/
   Projects/Settings navigation, active-state indication, signed-in identity, and sign
   out; unauthenticated visitors are redirected and never see shell content.
6. `/dashboard` shows the overview per §6.2 (organizations, projects, quick links,
   empty/loading/error states) using only existing read endpoints.
7. `/dashboard/settings` shows the read-only account surface per §6.3
   with no editing capability invented.
8. The environment selector is operable: switching TEST/LIVE updates the query
   parameter, propagates to all environment-scoped child links, reloads the view's data,
   defaults to `test`, and preserves deep links; keyboard-accessible with an exposed
   selected state.
9. All feature views present loading/empty/error/not-found states consistently; all
   previously specified behaviors (pagination, polling, once-only key display, filters,
   role-based controls, not-found for non-members) still pass their existing tests.
10. A `429 RATE_LIMITED` is presented as retryable with the `Retry-After` hint when
    present, and never as an authorization or data error (Phase 13 handover discharged).
11. The budget indicator appears when `RateLimit-*` headers are readable, shows only
    budget numbers, and stays silent (no error) when headers are absent.
12. Web responses carry the §7.5 security headers (HSTS production-only); the app runs
    without CSP violations and API calls incl. readable rate-limit headers still work.
13. Responsive layouts verified at small mobile and desktop widths for public, auth,
    and dashboard areas: no horizontal page scrolling, navigation reachable, controls
    usable.
14. Accessibility baseline (§7.6) met for the shell, public navigation, environment
    selector, and forms; no obvious WCAG A regressions introduced.
15. Existing tests are updated where their assertions were scoped too literally (D9),
    and the full checks pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
    `pnpm test:e2e`, `pnpm build` (root), locally and in CI.
16. `docs/web-application-structure.md` still matches the implementation (Q1 kept the
    routes unchanged, so no amendment is required).

## 11. Testing requirements

### 11.1 Web (`apps/web`)

- **Unit (vitest, existing patterns/stubs):**
  - Public pages: home/product render the required sections and CTAs; **re-scoped**
    negative assertions — no session material, tokens, key material, dashboard content,
    or authenticated data (D9); navigation/footer link targets correct.
  - Shell: nav set + active state, identity + sign-out present, shell absent without a
    session (extend the route-group suite).
  - Overview: renders organizations/projects from stubbed responses; empty state;
    error state; no fetch without a token.
  - Settings: read-only account fields from stubbed session/`me`; sign-out available;
    no editing controls.
  - Environment selector: switch updates the query parameter and child links; default
    and deep-link behavior preserved; accessible selected state.
  - Error presentation: a stubbed `429` renders retryable messaging incl. `Retry-After`
    when supplied, and never authorization wording; 401 → refresh/redirect path; 404 →
    not-found state; budget indicator renders when headers present, absent silently.
  - Security headers: the web configuration declares the required headers (and that
    HSTS is production/secure-only).
  - Regression: the Phases 3–12 page suites keep passing (they are the specification of
    the feature views).
- **E2E smoke (`test:e2e`, established jsdom pattern — real browsers are Phase 17):**
  - Public flow: home → product → docs entry renders with navigation and CTAs, no
    authenticated content.
  - Authenticated flow: stubbed session → dashboard shell → overview fetch → navigate to
    a feature view; sign-out clears and redirects.
  - A smoke for the 429 presentation path (stubbed throttled response → retryable
    message).

### 11.2 Shared

- All checks from the repository root (`pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:e2e`, `pnpm build`) and in CI.
- No secrets in test data; stubs reuse the existing fixture patterns
  (`auth-test-utils`, `projects-test-utils`, …).
- Tests must not depend on styling internals (class names for layout) beyond what is
  already asserted; assert roles, names, and behavior.

## 12. Out of scope

- **Any API, OpenAPI contract, database, migration, or worker change.** If a UI feature
  appears to need one, stop and escalate (this includes profile update, password
  change/reset, account deletion, notifications, global search, metrics/analytics
  endpoints).
- Documentation content and guides (Phase 15); sandbox scenario selection and triggers
  (Phase 16); browser/Playwright e2e tooling (Phase 17); the systematic security review
  (Phase 18); performance/load work (Phase 19); observability UI (Phase 20).
- New shared packages or a component library (master specification: packages only for
  concrete, demonstrated reuse).
- Internationalization, dark mode/theme switching (single theme), marketing/legal pages
  beyond what §4 defines, pricing pages.
- Session-aware public navigation, SSO, MFA, email delivery of any kind.
- Platform-administrator UI (ADR-0009) and any end-user/customer-facing product area
  (ADR-0008).
- Real payment processing, multi-currency, billing, microservices (master
  specification).

## 13. Decisions (D1–D9 — confirmed 2026-10-05)

All nine decisions are confirmed by the product authority; each states the chosen
option, with rejected alternatives recorded for traceability.

| # | Decision | Confirmed option (alternatives rejected) |
| --- | --- | --- |
| D1 | Styling approach | **Plain CSS:** global stylesheets organized per area, built on the existing semantic class names; zero new dependencies; tokens (color/spacing/typography) defined once. (Rejected: Tailwind — new dependency + build config; CSS Modules; component library — heavyweight for MVP.) |
| D2 | Dashboard overview content | **Read-only summary from existing endpoints** (first page of organizations + projects + quick links + empty-state guidance). (Rejected: metrics/counts — needs new API, out of scope; static welcome page — too thin.) |
| D3 | Settings scope | **Read-only account surface** (identity from session/`me`, sign out, doc pointers); no profile/password APIs exist, so no editing. (Rejected: profile-update API scope — contract + API work requiring separate commission.) |
| D4 | Environment selector | **Operable control updating the `environment` query parameter** (source of truth stays in the URL, deep links keep working); default `test`; API-key page stays project-wide. (Rejected: client-state-only selector — loses deep-linkability.) |
| D5 | Route-protection mechanism | **Keep client-side `AuthGuard`/`GuestGuard` as the routing gate;** verify completeness; no middleware (structurally impossible without changing the API cookie path — F6). (Rejected: server-side session probe — requires API cookie change; contradicts Phase 1 §11.5 as-is.) |
| D6 | Error presentation taxonomy | **The §7.3 table:** status/code-driven states, `429` retryable with `Retry-After`, `401` re-authenticate, `403` permission state, `404` not-found, request IDs surfaced. (Rejected: raw message passthrough — current behavior, rejected by the Phase 13 handover.) |
| D7 | Web security header mechanism | **Configure in `next.config.ts` response headers** (static, testable, works for all routes); CSP validated against the running app; HSTS only in secure/production. (Rejected: middleware-based headers — more moving parts for no MVP gain.) |
| D8 | Rate-limit surfacing | **Both:** compact budget indicator in the dashboard shell when headers are readable, **and** retryable 429 presentation. (Rejected: 429-only — leaves the Phase 13 §7 indicator undone; indicator-only — violates the 429 handover.) |
| D9 | Public-page test assertions | **Re-scope the Phase 2/3 negative assertions** to "no session material/tokens/key material/authenticated or dashboard content" instead of banning marketing vocabulary (`log in`, `payments`, `api keys`). (Rejected: keep word bans — would forbid a compliant home page.) |

## 14. Resolved questions (Q1–Q6 — closed 2026-10-05)

Each question was answered by the product authority in the same review that confirmed
D1–D9; the recommended option was confirmed in every case.

1. **Q1 — Audit viewer location (Phase 12 D12), resolved: keep.** The viewer stays at
   `/dashboard/projects/[projectId]/logs/audit` (labeled organization-wide; matches
   Phase 1 §11.3 and current nav, no route churn). No relocation under
   `/dashboard/organizations/[organizationId]`; no amendment to Phase 1 §11.3 or
   `docs/web-application-structure.md` routes. Revisit only if developer feedback shows
   confusion (Phase 15/17).
2. **Q2 — Settings scope, resolved: read-only** (D3). No profile-editing API scope is
   commissioned; such work would be a separate contract + API change.
3. **Q3 — Overview depth, resolved: summary** (D2). No metrics, counts, or activity
   feeds; they would need new endpoints.
4. **Q4 — Styling approach, resolved: plain CSS** (D1) — smallest correct solution, no
   new dependency.
5. **Q5 — Rate-limit indicator form, resolved: both** (D8) — budget indicator plus
   retryable 429 messaging.
6. **Q6 — Not-found/error pages, resolved: leave defaults** — out of scope this phase;
   Next.js defaults remain; revisit in Phase 17/18 polish.

## 15. Architectural decisions to record

Record (next ADR numbers, `.ai/decisions/`) during implementation:

- **Web styling approach** (D1, confirmed) — one paragraph: chosen approach,
  no-new-dependency rationale, token strategy.
- **Client-side-only route protection rationale** (D5/F6) — why middleware cannot gate
  the dashboard (refresh cookie path scope) and why the API remains the enforcement
  point; prevents a future phase from "fixing" this incorrectly.
- **(If D7's header set is non-obvious)** a note on the CSP directive set and the
  production-only HSTS rule.

No route change was decided (Q1), so `docs/web-application-structure.md` needs no
amendment unless navigation/area definitions change during implementation.

## 16. Implementation considerations (not new requirements)

- Keep public pages as static server components; only the areas that need session/data
  stay client components. Do not move session state into public pages for the
  navigation.
- Extend `apiFetch` once (capture `Retry-After` + `RateLimit-*`, preserve `status`,
  `code`, `requestId`) rather than per-page header plumbing; keep `ApiClientError` the
  single error type pages handle.
- Extract shared UI pieces (state blocks, page header, disclosure nav) inside `apps/web`
  only where real duplication exists; no new workspace packages (master specification).
- Styling must not alter accessible names asserted by existing tests (nav labels,
  headings, button names); where a deliberate copy change is needed, update the test in
  the same change and cite this spec.
- The docker `compose.yml` web service currently mounts only `apps/web/app` and
  `apps/web/next.config.ts`; if the implementation adds stylesheets, shared components,
  or middleware outside those mounts, the dev mounts need extending for hot reload
  (infrastructure tweak, keep minimal).
- `useSearchParams` usage already exists; keep Suspense boundaries valid so static
  rendering of public routes does not break the build.
- No API changes: resist "fixing" backend gaps from the UI layer; escalate instead
  (AGENTS.md).
- ROADMAP.md checkbox updates for Phases 4–12 (F10) are a separate bookkeeping task for
  the maintainer — not part of this phase's file scope.
- Reuse the established test utilities and stub fixtures; extend rather than replace.

## 17. Dependencies and handovers discharged

| Source | Obligation | Where |
| --- | --- | --- |
| Phase 1 §11 | Implement the web application structure/route boundaries defined there | §4–§7 |
| Phase 2 §4.2 / security baseline | Web security headers | §7.5 (D7) |
| Phase 3 §5 | Auth flows + session/guard behavior preserved, layout completed | §5, §7.2 |
| Phases 4/5/6/7 handovers | "Dashboard polish and responsive layout are Phase 14" | §6.1, §6.4, §7.1 |
| Phase 5 §5.3 | Environment selection UI completion | §6.5 (D4) |
| Phase 7 handover | Payments UI polish open item | §6.4 |
| Phase 12 D12 | Audit viewer relocation decision belongs to Phase 14 | Q1 (§14 — resolved: keep route) |
| Phase 13 §7 / handover | `429` retryable presentation + budget indicator | §7.3, §7.4 (D6, D8) |
| Master specification | Accessible developer experience; single Next.js app | §7.6, §2 |

Blocks (as recorded in the metadata): Phases 15, 16, 17, 18, 26.

## 18. Definition of done

- Decisions D1–D9 are confirmed and Q1–Q6 resolved (§13, §14 — 2026-10-05); the
  status line reflects this.
- All §10 acceptance criteria are satisfied, including the §4–§7 requirements and the
  discharged handovers in §17.
- Roadmap Phase 14 checkboxes are demonstrably covered (traceability in §1).
- Tests: §11 suites pass — `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`,
  `pnpm build` green locally and in CI; no regression in the Phases 3–12 web suites.
- Security: §9 satisfied; headers verified in a running build; no known critical web
  security issue; security-sensitive changes flagged for Phase 18 review.
- `docs/web-application-structure.md` matches the shipped routes/navigation; ADRs in
  §15 recorded if their decisions were confirmed.
- No API/contract/database change was introduced; no out-of-scope item (§12) was
  implemented.
