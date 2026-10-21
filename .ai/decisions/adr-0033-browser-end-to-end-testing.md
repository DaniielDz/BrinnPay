# ADR-0033: Browser End-to-End Testing — Playwright, Chromium Only, over the Built Stack

- **Status:** Accepted
- **Date:** 2026-10-09
- **Phase:** 17
- **Scope:** How the web application's critical flows are exercised against the real
  stack — tool choice, browser scope, topology, and the division of labor between the
  browser layer and the existing jsdom/API suites (Phase 17 D1, D7; §12.5).

## Context

Nine phases (2 D2, 3, 4, 5, 6, 7, 14, 15, 16) deferred browser end-to-end coverage to
Phase 17, and Phase 14 §11 states plainly that "real browsers are Phase 17". Until now
the web "e2e" layer is the jsdom stubbed-fetch pattern: fast and useful for per-area
presentation, but it cannot prove cookies round-tripping against a real API, redirect
behavior under a real session, security headers as actually served, CORS, or a real
error envelope. The roadmap checkbox "web application critical flow coverage" is
therefore only partly true today (Phase 17 F2).

Constraints:

1. **Only what needs a browser.** HTTP-level depth already belongs to the supertest
   suites (Phase 17 §6 L3); re-proving it in a browser would be an expensive duplicate
   (rule 3).
2. **Bounded.** Feedback time is a real constraint (§10); the phase defines a fixed
   critical set (§12.5), not an open-ended UI suite.
3. **Deterministic.** No sleeps, per-run unique data built through the UI/API (D4), and
   a run that cannot start must fail loudly (rule 5).
4. **The browser posture is not weakened.** Tests run against the real headers/CSP and
   never disable TLS/cookie/CSP checks to make a flow pass (§9 rule 4).
5. **No external egress.** Every target stays on loopback (§9 rule 5).

## Decision

**Adopt Playwright with a single chromium project, driving the built applications over
`docker/compose`'s topology (D1(a), confirmed 2026-10-09; wired on every PR per D7(a)).**

- **Tool and browser scope:** Playwright (`@playwright/test`), one config, one project
  (`Desktop Chrome`), no Firefox/WebKit matrix (§13 excludes cross-browser matrices).
- **Topology — the built apps, not dev servers.** `playwright.config.ts` starts, as its
  `webServer` list: the API (`node dist/src/main.js`), the webhook worker
  (`node dist/src/worker.js`), and the web app (`next start --port 3001`), against the
  existing PostgreSQL and Redis. Production-shaped artifacts run with production
  configuration — `NODE_ENV=production` and an explicit `COOKIE_SECURE=true` — so the
  refresh cookie this suite exercises (and asserts) carries `Secure`, exactly as it does
  outside the suite; the compose stack is the documented local equivalent.
- **Owns its environment.** The run uses ports 3000/3001 with
  `reuseExistingServer: false` — a reused server could carry a different rate-limit
  posture and silently change what the §12.5 429 case asserts — and a dedicated Redis
  database (15) so leftover limiter counters cannot trip this run's deliberately small
  budgets. `apps/api/scripts/clear-rate-limit-state.mjs` flushes only the limiter
  namespace before boot and exits non-zero on failure, so a failed flush aborts the run
  (`rule 5`).
- **Declared, non-secret configuration.** JWT/webhook keys are generated per run and
  never written to disk or output; every rate-limit and timing override in the config
  is declared next to the reason it differs from the local defaults (§8). No new
  environment variable is introduced — the run reads `REDIS_URL`, `JWT_SECRET`,
  `WEBHOOK_ENCRYPTION_KEY` and `CI`, and pins `NODE_ENV=production` with
  `COOKIE_SECURE=true`, all already documented in `apps/api/.env.example`.
- **Division of labor (stays truthful):** jsdom smokes remain the fast per-area
  feedback (§12.4); API e2e owns HTTP-level depth and both auth modes (§12.3); the
  browser layer proves only what genuinely requires a browser — the refresh cookie's
  flags (`HttpOnly`/`SameSite`/`Secure`), redirects, route protection without a
  session, real error envelopes, the security headers as served on a public and a
  dashboard route, a tenant-isolation negative case (§9 rule 6) and one real 429
  presentation (Phase 14 §7.3/§7.4) — over `api + worker + web + PG + Redis`.
- **Determinism and artifacts:** condition-based waiting with bounded deadlines only;
  serial execution (`workers: 1`, `fullyParallel: false`) because the final test
  deliberately exhausts the shared write budget; traces/screenshots captured on
  failure only, git-ignored and treated as sensitive (§8); `retries: 0` so a flaky test
  is fixed or reported, never retried away (§17).
- **CI:** `pnpm --filter @brinnpay/web test:browser` runs on every pull request after
  the build step, with the chromium download cached on the lockfile hash and a failed
  install failing the job (D7(a), §10).

## Consequences

- The nine explicit "browser e2e is Phase 17" handovers are discharged by one bounded
  suite instead of a growing UI test estate.
- The suite must run after `pnpm build`; it cannot be started against a dev server, so
  the feedback cost is real and measured (§17 records pipeline duration).
- Playwright browsers become a CI dependency with a cache; a browser install failure is
  a red job, never a silent no-op.
- Local runs own ports 3000/3001 — a local dev stack must be stopped first (documented
  in the config header).

## Alternatives rejected

- **Keep jsdom-only web e2e and declare API e2e sufficient (D1(b)):** cheapest, but
  leaves every deferral unfulfilled and would redefine "web application critical flow
  coverage" as stub-based; it would need an explicit discharge, which the product
  authority did not give.
- **HTTP-only checks of the built Next app, no browser (D1(c)):** cheap realism for
  public/SSR pages, but cannot drive client-side flows — it satisfies neither the
  browser requirement nor a clean no.
- **A cross-browser matrix (Firefox/WebKit):** rejected by §13 (cross-browser matrices
  are out of scope) and disproportionate to the bounded critical set.
- **Reusing an already-running stack (`reuseExistingServer: true`):** rejected — it
  couples the run to whatever rate-limit and timing posture the reused servers happen
  to carry, undermining the assertions it exists to make.
