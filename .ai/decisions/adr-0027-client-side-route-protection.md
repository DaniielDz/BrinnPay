# ADR-0027: Client-Side-Only Route Protection — Guards Are the Routing Gate, the API Is the Enforcement Point

- **Status:** Accepted
- **Date:** 2026-10-05
- **Phase:** 14
- **Scope:** Why `/dashboard/**` is gated by client-side `AuthGuard`/`GuestGuard` and not
  by Next.js middleware, and why the API remains the sole authorization enforcement
  point (phase 14 §7.2, D5/F6).

## Context

Phase 14 F6 recorded a structural limit rather than a missing feature: route protection in
`apps/web` is **client-side only**, and it cannot be moved to server middleware as the code
stands today.

1. **The refresh cookie is path-scoped to `/api/v1/auth`** (Phase 3 session design; Phase 1
   §11.5: access token in memory only, refresh token only via an `HttpOnly` cookie owned by
   the API). A request made by middleware to a web route such as `/dashboard` therefore
   carries **no refresh cookie at all** — middleware cannot observe, let alone validate, a
   session for the page it is about to serve.
2. **Probing for a session from the server would require an API change.** Either widening
   the cookie path (so a web route receives the API's credential) or minting a second
   client-readable session cookie — both contradict Phase 1 §11.5, and both are API contract
   changes, explicitly out of scope for Phase 14 (§12: "Any API, OpenAPI contract, database,
   migration, or worker change … stop and escalate").
3. **Server-side gating would not add enforcement.** The API is where every request is
   authenticated and authorized (§9.3); a gate that only chooses which page HTML to send is
   presentation. The security-relevant decision is made server-side regardless of how the
   router behaves.

Alternatives considered: keeping the current behavior silently (violates §7.2's
"verification + completion" requirement), moving gating to middleware (structurally
impossible without the API change above), or inventing a session endpoint for the web app
(a contract change).

## Decision

**Client-side `AuthGuard`/`GuestGuard` remain the routing gate; verification and
completeness are the requirement; the API remains the sole enforcement point.**

- **`AuthGuard` wraps the entire dashboard route group** (`app/(dashboard)/layout.tsx` →
  `DashboardShell`): unauthenticated visitors are redirected to `/login`, and **no shell
  content, navigation, or data request renders while session state is resolving** — no
  shell flash for unauthenticated visitors (§7.2, §6.1).
- **`GuestGuard` continues to wrap `/login` and `/register`**, redirecting authenticated
  visitors to `/dashboard` (Phase 3 behavior preserved exactly).
- **No dashboard route performs an API call without a session token**; pages return `null`
  before a token exists, and the client clears the session and redirects on unrecoverable
  `401` (refresh attempt first, per §7.3).
- **No bypass surface:** `403`/`404` from the API render as the corresponding state without
  leaking data, so a crafted URL or stale state cannot reveal cross-tenant content — the
  response the API refuses is the response the UI shows (§9.3).
- **This is recorded deliberately** so a later phase does not "fix" it by introducing
  middleware: doing so requires an API cookie-path or session-cookie change, which is an
  escalation, not a refactor (AGENTS.md).

## Consequences

- Protected HTML is assembled on the client; a determined client can always request the
  route — which is why the *content* of that HTML is presentation-only and the *data*
  comes solely from authorized API responses. The threat model does not change with the
  gate's location.
- The public area stays static and session-free (§4.1): because the guard lives inside the
  dashboard route group, public pages make no authenticated requests and render no
  session-aware navigation.
- Tests must cover completeness rather than mechanism: shell absent without a session, no
  fetch without a token, redirect behavior, and 401/403/404 presentation (§11.1).
- Any future work that wants server-rendered protected pages must first decide where the
  web app's session credential lives (API cookie scope or a dedicated session cookie) —
  that decision belongs to the API owners, not to a web phase.

## Alternatives rejected

- **Next.js middleware gating:** rejected — structurally unavailable without changing the
  API cookie path (F6); middleware would see an unauthenticated request for every visitor
  and would have to redirect everyone.
- **A server-side session probe endpoint for the web app:** rejected — new API contract
  surface, contradicts Phase 1 §11.5 as-is, and adds no enforcement the API lacks.
- **Storing the access token where the server can read it (`localStorage` or a web-readable
  cookie):** rejected — directly violates the Phase 1/3 session rules (in-memory access
  token, `HttpOnly` refresh cookie) and widens the XSS blast radius.
- **Trusting client-side gating as enforcement:** rejected — UI hiding is presentation
  only (§9.3); the API authenticates and authorizes every request regardless of route.
- **Leaving the gap undocumented:** rejected — §7.2 requires verification, and an
  undocumented "fix" by a future phase is exactly the risk this ADR exists to prevent.
