# ADR-0028: Web Security Headers — Static `next.config.ts` Header Set, CSP as the XSS Boundary, HSTS Production-Only

- **Status:** Accepted
- **Date:** 2026-10-05
- **Phase:** 14
- **Scope:** How `apps/web` sends its security headers (phase 14 §7.5, D7; Phase 2 §4.2
  handover; `docs/security-baseline.md`).

## Context

Web security headers were deferred twice — Phase 2 §4.2 and the security baseline mapping
("Security headers on web responses → Phase 14"; F11) — and `next.config.ts` sent none.
The remaining questions were *where* the headers are configured and *what* the CSP must
allow for a client-rendered app whose data comes from a separate origin.

1. **Mechanism.** Middleware could attach headers per request, but a header set that is
   identical for every route does not need a request cycle, and middleware adds a moving
   part that must itself be mounted, tested and kept out of the data path (D7).
2. **`connect-src` must be explicit.** The dashboard calls a cross-origin API
   (`NEXT_PUBLIC_API_BASE_URL`, docker default `http://localhost:3000/api/v1`) with
   `credentials: 'include'`; a naive `default-src 'self'` policy would block every call —
   and, per the Phase 13 Q3 handover, the `RateLimit-*`/`Retry-After` headers must stay
   readable to the browser.
3. **Inline script/style is required by the framework**, so `script-src`/`style-src`
   cannot be `'self'`-only, while `'unsafe-eval'` must never be allowed in production.
4. **HSTS must not break plain-HTTP local development** — `docker compose` serves the web
   app over `http://localhost:3001`, and a blindly-sent `Strict-Transport-Security` on a
   non-secure transport is at best ignored and, on a shared/staging host, a source of
   confusion. The API already solves the analogous problem with `COOKIE_SECURE`
   (`parseBoolean`, default `NODE_ENV === 'production'`).

## Decision

**One static header set, exported from `next.config.ts` as a pure function and applied to
every route through the `headers()` config — CSP as the primary XSS boundary, with HSTS
gated on a secure-transport flag.**

- **Mechanism (D7):** `securityHeaders({ secure, development, apiOrigin })` in
  `next.config.ts` returns `{ key, value }[]`, and `headers()` applies it under the
  `/(.*)` source. Configuration — not a request path — makes the set reviewable in a diff
  and testable without booting the app (§11.1 "the web configuration declares the required
  headers").
- **CSP directive set:**
  - `default-src 'self'`; `base-uri 'self'` (no `<base>` hijack); `object-src 'none'`;
    `frame-ancestors 'none'` (clickjacking, mirrored by `X-Frame-Options: DENY` for older
    agents); `form-action 'self'` (posted credentials stay on this origin).
  - `script-src 'self' 'unsafe-inline'` — inline is required by Next.js bootstrap;
    `'unsafe-eval'` is added **only in development** and is **never present in
    production** (§7.5).
  - `style-src 'self' 'unsafe-inline'`; `img-src 'self' data:`; `font-src 'self' data:`.
  - `connect-src 'self'` plus the origin parsed from `NEXT_PUBLIC_API_BASE_URL` (plus
    `ws: wss:` in development for the dev server), so credentialed cross-origin API calls
    and their readable rate-limit headers keep working.
- **Other headers on every response:** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` (hardening;
  `payment=` is deliberate — the sandbox never touches a real payment instrument).
- **HSTS is secure-transport-gated:** `WEB_SECURE` (explicit `true`/`false`) with the same
  default as the API's `COOKIE_SECURE` — `NODE_ENV === 'production'`. Development never
  sends it; a plain-HTTP production-style run opts out with `WEB_SECURE=false`. Value:
  `max-age=31536000; includeSubDomains` (no `preload` — the sandbox does not own its
  hostname's future).
- **`upgrade-insecure-requests` is intentionally omitted:** it would upgrade a local
  `http://localhost:3000` API call to `https://` and break a plain-HTTP development or
  `next start` setup. The requirement list (§7.5) does not include it, and the risk it
  mitigates is covered by HSTS in the secure deployment.
- **Validation:** the directive set is checked against the running app — no CSP console
  violations in normal use, styles/scripts intact, cross-origin API calls with readable
  rate-limit headers succeeding (§7.5) — and picked up by the Phase 18 security review.

## Consequences

- `'unsafe-inline'` in `script-src` remains the largest residual CSP relaxation; it is a
  framework constraint today. Removing it later requires nonce/hash support in the Next.js
  rendering path — recorded as a Phase 18 review item rather than solved speculatively.
- The header set is static per deployment: the API origin in `connect-src` is fixed at
  build time from `NEXT_PUBLIC_API_BASE_URL`. Deployments that change the API origin
  must rebuild — consistent with how `NEXT_PUBLIC_*` already works in this app.
- Because headers are configuration, a test can assert the required directives (including
  HSTS production-only) without network access, and a regression in `next.config.ts` is
  caught by `pnpm test`.
- The Phase 18 security review has a single, explicit artifact (`next.config.ts`) plus
  this ADR to verify against `docs/security-baseline.md`.

## Alternatives rejected

- **Middleware-based headers:** rejected — more moving parts (an extra module on the
  request path, its own mounting and test surface) for no MVP gain when the set is
  identical for every route (D7).
- **A meta-tag CSP in the document head:** rejected — cannot carry `frame-ancestors`,
  does not apply to non-HTML responses, and is weaker than an HTTP header.
- **Sending HSTS unconditionally:** rejected — §7.5 requires it in production/secure
  environments only, never forced on plain-HTTP local development.
- **Defaulting HSTS to "off" in production (opt-in):** rejected — the API's `COOKIE_SECURE`
  precedent is secure-by-default in production with an explicit opt-out; matching it keeps
  one rule for "is this a secure deployment?".
- **`upgrade-insecure-requests`:** rejected — breaks a plain-HTTP local API origin; not
  required by §7.5.
- **A permissive `connect-src` (`*` or inline data):** rejected — it would allow
  exfiltration to arbitrary origins; the configured API origin is sufficient for a single
  API deployment.
