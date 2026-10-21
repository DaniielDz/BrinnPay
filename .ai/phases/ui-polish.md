# UI & Portfolio Polish

| | |
| --- | --- |
| Phase | UI & Portfolio Polish (out-of-roadmap portfolio phase) |
| Status | **Confirmed (2026-10-21).** D1–D9 and Q1–Q4 answered by the product authority; the recommended option was adopted in every case (recorded in §12/§13). The specification is ready for implementation on `feature/ui-polish`. |
| Depends on | Phase 14 (web application structure, styling foundation — ADR-0026 plain CSS, tokens, semantic class vocabulary, accessibility baseline §7.6), Phase 15 (public documentation area in `apps/web`), Phase 3 (auth flows, `AuthGuard`/`GuestGuard` — presentation-only touch), Phases 4–12 (feature views that receive the consistency pass), Phase 17 (test harness: vitest unit/smoke, Playwright browser suite — ADR-0033, coverage ratchet — ADR-0034), Phase 18 (security posture the polish must not weaken — ADR-0028 CSP), Phase 21 (production images; v0.1.0 portfolio baseline) |
| Blocks | The **v0.2.0 portfolio release** (this phase's output is its content); no numbered roadmap phase is blocked — Phases 22+ remain deferred and unaffected; if resumed later, they inherit the polished UI |
| Roadmap | **Not listed in [ROADMAP.md](../../ROADMAP.md).** Out-of-roadmap portfolio phase executed after Phase 21 (v0.1.0 tagged) while Phases 22–26 are deferred (see header note below) |
| Branch | `feature/ui-polish` (branched from `develop`) |

> **Roadmap position (decided by the product authority, 2026-10-21).** Development is
> paused at Phase 21 for a portfolio release (`v0.1.0` tagged; default branch `main`).
> Production/operations phases (22 staging, 24 AWS) and the rest of 22–26 are
> **deferred**. The product goal for the current stage is a **portfolio showcase**: the
> web application works but looks "de desarrollador" — functional, not visually
> appealing or professional enough for the showcase. This phase is a deliberate,
> explicitly commissioned departure from the numbered roadmap and reserves **no roadmap
> number** (22–26 stay reserved for the deferred ops work). The successor release after
> this phase is **v0.2.0** (v0.1.0 is the current baseline). When the production track
> resumes, ROADMAP.md bookkeeping for this phase is a separate maintainer task (Phase 16
> Q2 / Phase 14 F10 precedent — report-only).

## 1. Objective

**Raise the visual quality of the BrinnPay web application from "functional MVP" to
"professional, polished product" — a visual-quality pass with zero functional or API
changes — so the first impression for recruiters, hiring managers, and developers
evaluating the portfolio is strong.**

This phase changes **how the application looks**, never **what it does**:

1. **Public site** (`/`, `/product`, `/docs`) — a strong first impression: a
   deliberate hero, clear visual hierarchy, consistent typography and spacing.
2. **Auth pages** (`/login`, `/register`) — a clean, focused, professional
   authentication presentation.
3. **Dashboard** (`/dashboard/**`) — a professional product feel: polished empty
   states, tables, cards, spacing, and hierarchy across the shell and feature views.
4. **Design-system refinement** — evolve the existing tokens
   (`apps/web/styles/tokens.css`: color, typography, spacing, radius, shadows) and the
   shared component vocabulary (`apps/web/styles/base.css`) so every area is styled
   consistently from one source of truth.
5. **Responsive/visual QA** of key pages, with **every existing test suite green** —
   vitest unit and jsdom smoke suites, the Playwright browser suite, the coverage
   ratchet, lint, typecheck, and build. **No test may be weakened to make the phase
   pass**; test edits are allowed only where markup deliberately changes and the
   assertion is updated in the same change with this spec cited.

The phase works **within the existing styling architecture** (ADR-0026: plain CSS, one
stylesheet per area, tokens in `:root`, zero styling dependencies) unless the product
authority explicitly reopens that decision (D2 — reopening requires a recorded ADR,
not a silent choice).

### Non-goals of the objective

- No new product features, routes, API consumption patterns, or business behavior.
- No functional redesign (flows, guards, session handling, pagination, filters,
  once-only key display, rate-limit behavior stay exactly as specified).
- No theming system (dark mode is D6 — recommended out, per ADR-0026's recorded
  single-theme scope).

## 2. Scope

In scope:

- **Token and base-vocabulary refinement** (`apps/web/styles/tokens.css`,
  `apps/web/styles/base.css`): color palette depth, typography scale, spacing, radius,
  shadow/elevation, focus treatment — consumed by every area stylesheet.
- **Public area restyle** (`apps/web/styles/public.css`, `app/(public)/page.tsx`,
  `app/(public)/product/page.tsx`, `app/(public)/layout.tsx`, docs entry presentation):
  hero, capability cards, steps, CTA sections, navigation, footer.
- **Auth area restyle** (`apps/web/styles/auth.css`, `app/(auth)/layout.tsx`, login
  and register pages' presentation): consistent brand header, focused form card,
  consistent primary-action styling.
- **Dashboard restyle** (`apps/web/styles/dashboard.css`, `components/dashboard/
  dashboard-shell.tsx` presentation, dashboard pages' presentation): topbar, sidebar,
  active states, environment selector, item lists/rows, tables, empty/loading/error
  state blocks, definition lists, quick links.
- **Docs area consistency pass** (`apps/web/styles/docs.css`): inherit and apply the
  refined tokens; scope decided by Q1 (recommended: light consistency pass, no
  structural redesign).
- **Brand/asset decisions as resolved by D4/D5** (logo mark, favicon, social preview).
- **Responsive and visual QA** of the public, auth, and dashboard areas at small
  mobile and desktop widths (manual QA; test additions only if D7 decides otherwise).
- **Test maintenance**: update assertions whose markup deliberately changes, in the
  same change, citing this spec; keep every suite green with equal or stronger
  assertions.

Explicitly **not** in scope (§12): any API/contract/DB/migration/worker change; new
routes or pages (escalate if one appears necessary); dark mode (D6); new styling
frameworks or component libraries (D2); new runtime dependencies unless D8 resolves
otherwise; visual-regression screenshot infrastructure (D7); documentation content
rewrites; ROADMAP.md edits; release tagging and version bookkeeping (v0.2.0 is a
maintainer act at merge/release time, Phase 16 Q2 precedent).

## 3. Context and current-state findings

**What exists today** (branch `feature/ui-polish`, based on `develop`; Phases 0–21
merged; `v0.1.0` tagged):

- The complete web application is implemented and tested: public site
  (`app/(public)/page.tsx`, `product/page.tsx`, `docs/**` — 15 docs routes), auth
  (`app/(auth)/login/page.tsx`, `register/page.tsx` behind `GuestGuard`), dashboard
  (`app/(dashboard)/dashboard/**` — overview, organizations, projects + project shell
  with customers/payments/api-keys/webhooks/refunds/logs, settings) behind `AuthGuard`.
- A working styling foundation per ADR-0026 exists: `styles/tokens.css` (70 lines —
  neutral scale, brand/status colors, env badges, spacing, typography, radius,
  shadows, layout constants), `styles/base.css` (413 lines — reset, buttons, forms,
  status vocabulary, tables, item lists/rows, cards, focus visibility,
  `prefers-reduced-motion`), and one stylesheet per area: `public.css` (195),
  `auth.css` (84), `dashboard.css` (242), `docs.css` (446) — ~1,450 lines total,
  imported once from `app/layout.tsx`.
- The design is **correct and accessible but minimal** — the "de desarrollador"
  assessment is grounded in: a flat `#f6f7f9` page background with white cards
  (`--color-bg`/`--color-surface`), a single-hue blue brand (`--color-primary:
  #2f5bd7`), a hero that is a plain white card with a heading and two buttons
  (`public.css` `.hero`), empty states that are dashed-border boxes
  (`base.css` `.state`/`.state-empty`), bare tables (`base.css` `table`/`th`/`td`),
  and a text-only brand (`.brand` / `.dashboard-brand` — no logo mark anywhere).

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | **No brand asset exists.** The brand is plain text: `.brand` in `app/(public)/layout.tsx` L16 and `app/(auth)/layout.tsx` L13, `.dashboard-brand` in `components/dashboard/dashboard-shell.tsx` L53. There is no logo, icon, or wordmark asset anywhere in `apps/web`. | D4 (logo), D5 (favicon/OG) — escalate; do not invent a brand mark without a decision. |
| F2 | **No favicon, icon, or social preview.** `apps/web` has no `public/` asset directory at all, and the root `app/layout.tsx` metadata (L12–15) declares only `title`/`description` — no `icons`, no `openGraph`. Browser tabs and shared links render with defaults. | D5 — recommended in (favicon + basic OG metadata); asset format decided there. |
| F3 | **Typography is system-default.** `tokens.css` L49–51 uses a system font stack; the scale tops out at `--font-size-3xl: 2.25rem`; there is no display treatment, letter-spacing, or weight hierarchy beyond `strong`/headings. This is a large part of the "developer" feel. | D3 (webfont vs system fonts), §4 typography requirements. |
| F4 | **Test contracts constrain markup and copy.** The Playwright suite (`test/browser/critical-flows.spec.ts`) asserts by role and accessible name: h1 `BrinnPay` (L75), h1 `Product` (L79), h1 `Documentation` (L83), navigation names `Public` (L77), `Dashboard` (L34), `Documentation` (L87), link/button names (`Product`, `Docs`, `Quickstart`, `Sign out`, `Create`, `Create key`, form `Create payment`, region `New API key`, comboboxes `Scenario`/`Customer`, label-based email/password). The jsdom smokes assert the same heading names plus CTA link names `Get started` and `Log in` (`test/e2e/home.smoke.spec.tsx` L36–37) and no `/dashboard` links on public pages (L24). Unit specs assert class names inside components: `.docs-op-path`/`.docs-method`/`.docs-op-summary`/`.docs-op-id`/`nav.docs-reference-toc`/`.docs-base-url` (`test/unit/api-reference.spec.tsx` L94–97, L123, L173), `.docs-nav-current`/`.docs-source` (`test/unit/docs-pages.spec.tsx` L267, L310), `.event-type` (`test/unit/webhooks-pages.spec.tsx` L208); `route-group-layouts.spec.tsx` asserts `[aria-current="page"]` (L66) and `aria-expanded`/`aria-controls` on `.nav-toggle` (L70–71); `projects-pages.spec.tsx` asserts `aria-pressed` on the env selector buttons (L179–201). | §4 rules, §7.4, §11.2 — accessible names and these class hooks are preserved or the test updates in the same change citing this spec; behavior attributes (`aria-*`) are never removed. |
| F5 | **The CSP forbids external asset CDNs.** ADR-0028 / `next.config.ts` sends `img-src 'self' data:` and `font-src 'self' data:`; `security-headers.spec.ts` asserts the header set (L30–42). Any webfont, image, favicon, or OG asset must be served from the app itself (or inlined as `data:`); Google Fonts/CDN images would break the running app and contradict the recorded header posture. | §8 rule 3, D3/D5 — all assets self-hosted in-repo; CSP untouched. |
| F6 | **Action styling is inconsistent between areas.** Public CTAs are `<Link className="button button-primary">` (`app/(public)/page.tsx` L63), but the login/register submit controls are bare `<button type="submit">` (`app/(auth)/login/page.tsx` L66, `register/page.tsx` L78), which `base.css` L110–122 renders as the secondary look — the primary action of the auth flow visually underweights against the public "Get started" button. | §5 — consistent primary-action treatment; presentation-only (no behavior/name change). |
| F7 | **The shared state/table/list vocabulary is visually weak.** `.state` is a dashed-border box (`base.css` L217–223), tables are unstyled beyond borders (`base.css` L305–329), `.item-row` is a flat bordered row (L360–369), `.card` has one shadow level (L392–398). These classes are used by every dashboard view, so improving them lifts the whole dashboard — but they are also asserted structurally in tests (e.g., empty states, item links). | §6, §7.1 — refine within the existing class vocabulary; never rename asserted hooks (F4). |
| F8 | **ADR-0026 fixes the styling architecture**: plain CSS, per-area stylesheets, tokens once, no theming layer, **no dark mode** (single theme recorded as out of scope), zero styling dependencies. Reopening it is a decision, not an implementation choice. | D2 (recommended: reaffirm), D6 (dark mode — recommended out). |
| F9 | **The coverage ratchet applies.** ADR-0034: web thresholds statements ≥ 95 %, branches ≥ 80 % over `app/**`, `components/**`, `lib/**`. Stylesheets are not counted, but any new component logic/branching (e.g., conditional asset rendering) must be covered; the ratchet may not be lowered. | §11.1, AC — coverage gate stays green at current thresholds. |
| F10 | **The docs area is large** (15 routes plus `components/docs/api-reference.tsx` and a 446-line `docs.css`) and mostly reads like engineering documentation, not a polished docs product. Whether it gets a full restyle or a consistency pass is ambiguous. | Q1 (recommended: light consistency pass). |
| F11 | **No visual-regression or screenshot baseline infrastructure exists**; Playwright captures traces/screenshots on failure only (ADR-0033). Adding screenshot baselines is a new testing posture, not maintenance. | D7 (recommended: out). |
| F12 | **Route protection, session handling, and security headers are settled** (ADR-0027, ADR-0028) and are *not* to be touched; the polish is presentation on top of the existing guards and headers. | §8 rules 1–2, §10. |

## 4. Public area — first impression

The public site is the portfolio's front door; it must look like a deliberate product
page, not a test app:

- **Hero** (`app/(public)/page.tsx` `.hero`): a strong visual anchor for the home
  page — refined display typography (D3), a clear value statement, and the existing
  CTAs (`Get started` → `/register`, `Read the docs` → `/docs`) with a visually
  dominant primary action. The h1 remains `BrinnPay` unless D9 resolves a deliberate,
  test-updated copy change (F4). Decorative treatment must stay CSP-clean (CSS or
  self-hosted assets per D5 — no external images).
- **Capability grid and steps** (`.capability-grid`, `.capability-card`, `.steps`):
  consistent card elevation, spacing, and typographic hierarchy; scannable at a
  glance.
- **Navigation and footer** (`.public-header`, `.public-footer` in
  `app/(public)/layout.tsx`): the brand presentation per D4; the existing link set
  (Home, Product, Docs, Log in, Get started) and footer links stay exactly as
  asserted (F4); polish is visual only.
- **Product page** (`product/page.tsx`): inherits the same hero/card/section
  vocabulary; no content changes beyond what D9 permits.
- **Docs entry** (`docs/page.tsx` + `docs/layout.tsx`): presentation per Q1; the docs
  navigation and heading names (`Documentation`, `Quickstart`, …) are test contracts
  (F4).
- Public pages remain **static server-rendered**, perform no API calls, and expose no
  authenticated material (Phase 1 §11.1; the smoke suite's negative assertions in
  `home.smoke.spec.tsx` L17–25 must keep passing unchanged).
- Per-page metadata stays accurate; D5 may extend it (icons/openGraph) without
  changing titles/descriptions that describe the product.

## 5. Authentication area

- `/login` and `/register` keep their Phase 3 behavior exactly: same fields, names,
  labels, API calls, `GuestGuard` redirect, and error surfaces. The auth unit suites
  (`test/unit/auth-pages.spec.tsx`) must pass unchanged in behavior.
- Presentation: the existing `auth-layout` shell (brand header, centered card
  `.auth-main section`, footer sandbox line) is refined — better card treatment,
  spacing, and a **consistent primary submit button** resolving F6 (the submit
  control gets the primary-action styling without changing its accessible name —
  `Log in` / `Register` — which Playwright asserts, F4).
- No session material, cookie names, or tokens in rendered output (existing
  assertions preserved).

## 6. Authenticated area — dashboard

The dashboard must read as one professional product:

- **Shell** (`components/dashboard/dashboard-shell.tsx`, `dashboard.css`): topbar,
  brand, identity block, sign-out, rate-limit pill (`.rate-limit-indicator`), sidebar
  with `aria-current='page'` active state, and the mobile `nav-toggle` disclosure —
  all presentation-refined; the `aria-*` behaviors and ids
  (`dashboard-navigation`, F4) are untouched.
- **Overview** (`app/(dashboard)/dashboard/page.tsx`): organizations/projects lists,
  quick links, and empty states (`state-empty` — "no projects yet" guided first step)
  get the polished card/empty-state treatment (§7.1). Content and fetch behavior
  unchanged (Phase 14 §6.2 — existing read endpoints only).
- **Feature views** (organizations, project shell, customers, payments, refunds,
  webhooks, api-keys, request/audit logs, settings): benefit automatically from the
  shared vocabulary refinements (§7.1); no page-by-page redesign, no behavior change.
  Where a specific view's presentation is clearly below the bar after the shared pass,
  a targeted presentation fix is allowed — markup changes must keep that view's unit
  suite green (update in the same change if a deliberate hook/name changes, F4).
- **States**: loading, empty (with next action), error (`role="alert"`, request ID),
  not-found — all keep their semantics and improve visually (never lose
  `role="alert"`, which error suites assert).
- **Tables and forms**: consistent header treatment, row density, zebra/striping if
  chosen, focus visibility (`:focus-visible` in `base.css` L67–71 — preserve or
  improve), disabled states.

## 7. Design-system refinement (cross-cutting)

### 7.1 Tokens and shared vocabulary

- `tokens.css` remains the single source of truth for color, typography, spacing,
  radius, shadow, and layout values; area stylesheets keep consuming tokens — raw
  values stay in `tokens.css` (ADR-0026). Refinement may deepen the scales (e.g.,
  more neutral steps, an elevation scale, additional type steps) but must keep one
  coherent system.
- `base.css` keeps the shared class vocabulary (`button`, `button-primary`,
  `button-secondary`, `danger`, `state`, `state-empty`, `state-loading`, `warning`,
  `env-badge`/`env-test`/`env-live`, `payment-status-*`, `item-list`, `item-row`,
  `card`, `table-scroll`, `definition-list`, `visually-hidden`, `mono`, `hint`,
  `page`, `page-subtitle`, `page-section-header`). These names are used by pages and
  some are asserted in tests (F4) — refine their styling, do not rename them.
- **Contrast**: text, muted text, brand-on-surface, badge/status text/background
  pairs, and focus outline must meet **WCAG AA** (4.5:1 body text, 3:1 large text
  and non-text UI indicators) in the default (light) theme. The security/a11y test
  posture does not currently assert contrast ratios, so this phase establishes the
  bar and must not contradict `security-headers.spec.ts` (which asserts headers only,
  not colors).
- **Focus and motion**: keyboard focus stays clearly visible on every interactive
  element; `prefers-reduced-motion` handling (`base.css` L404–413) is preserved; any
  new motion is subtle, functional (hover/press feedback), and honors that media
  query.

### 7.2 Consistency rules

- One visual language across public, auth, docs, and dashboard: the same type scale,
  spacing rhythm, radius family, elevation usage, and status-color semantics.
- Buttons: a consistent primary/secondary/danger hierarchy everywhere (resolves F6).
- Status vocabulary (env badges, payment statuses, warnings, alerts) keeps its color
  semantics — `env-test` stays visually distinct from `env-live`, danger stays
  danger, success stays success.

### 7.3 Architecture guardrails

- **Stay within ADR-0026** (D2): plain CSS, per-area stylesheets, tokens; new
  sub-stylesheets or additional organization within `apps/web/styles/` is acceptable
  if it keeps the one-file-per-area principle legible; a framework/CSS-in-JS/component
  library requires an explicit D2 reversal plus a new ADR — not assumed here.
- **No build/config changes** for styling; no new runtime dependencies unless D8
  resolves otherwise (icons/assets handled per D4/D5/D8, self-hosted only per F5).

### 7.4 Test-contract preservation

- Accessible names, roles, and `aria-*` attributes asserted by the vitest and
  Playwright suites (F4) are **behavioral contracts**: never remove or rename them
  for styling reasons.
- Class-name assertions exist in a small, enumerated set (docs components,
  `.event-type` — F4). Those hooks stay, or the assertion updates in the same change
  citing this spec, with equal strength.
- Copy asserted by tests (`BrinnPay`, `Product`, `Documentation`, `Get started`,
  `Log in`, `Sign out`, form labels, …) stays unless D9 permits a change and the
  test updates alongside.

## 8. Data, behavior and security invariants

1. **Zero functional change**: no route, endpoint, fetch, guard, session, pagination,
   filter, polling, or state-machine behavior changes. `lib/brinnpay/client.ts`,
   auth components, and page logic are untouched except where a presentation change
   requires a pure markup refactor with identical behavior.
2. **Route protection unchanged** (ADR-0027): `AuthGuard`/`GuestGuard` wiring, no
   shell flash, no API call without a token — the existing guard suites
   (`auth-guard.spec.tsx`, route-group suites) stay green.
3. **Security headers unchanged** (ADR-0028): `next.config.ts` header set and
   `security-headers.spec.ts` untouched; any asset added (D5) must be served by the
   app under the existing CSP (`img-src 'self' data:`, `font-src 'self' data:`) —
   **no external CDNs, ever** (F5).
4. **No new secrets, env vars, or client-side storage**; no tokens/keys in markup,
   URLs, or styles; no `dangerouslySetInnerHTML` for any new content (decorative
   SVGs are authored as JSX/components, not injected HTML strings).
5. **Public-area hygiene** preserved: no authenticated material on public routes
   (the smoke negative assertions keep passing).
6. **Accessibility preserved or improved**: landmarks (`header`/`nav`/`main`/
   `footer`/`aside`), heading order, labels, keyboard operation, focus visibility,
   `prefers-reduced-motion`, status announcements (`role="alert"`) — no WCAG AA
   regressions introduced (AC-bound).

## 9. Acceptance criteria

1. The public home page presents a deliberate hero and section hierarchy that reads
   as a professional product page; CTAs, navigation, and footer names/targets are
   unchanged (or updated with tests per D9); no authenticated material renders.
2. `/product` and the `/docs` entry are visually consistent with the home page
   (per Q1 scope); docs headings/navigation names keep their asserted values.
3. `/login` and `/register` render a polished, consistent authentication card with a
   visually primary submit action; Phase 3 behavior and auth suite assertions are
   unchanged.
4. The dashboard shell (topbar, sidebar active states, identity, sign-out,
   rate-limit pill, env selector) is visually polished with all `aria-*` behaviors
   and ids intact; the route-group, projects, and rate-limit suites pass unchanged.
5. Dashboard empty/loading/error/not-found states and tables/item lists/cards across
   the overview and feature views are visually consistent and polished; `role="alert"`
   error presentation and all feature-view unit suites remain green.
6. Tokens remain the single source of truth; area stylesheets consume tokens; no
   styling framework, no new runtime dependency (unless D8 resolves otherwise), no
   build-config change for styling.
7. WCAG AA contrast is met for text, muted text, badges/statuses, and focus
   indicators in the default theme; focus visibility and `prefers-reduced-motion`
   are preserved or improved.
8. Small-mobile and desktop widths have no horizontal page scrolling, clipped
   controls, or unreachable navigation in public, auth, docs, and dashboard areas
   (manual QA per §11.3).
9. Favicon/social-preview behavior matches D5 (assets present and served from the
   app, or explicitly deferred with a recorded reason); no CSP violations in the
   browser console during normal use of any area.
10. All existing checks pass locally and in CI with **no assertion weakened**:
    `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`,
    `pnpm --filter @brinnpay/web test:browser`, `pnpm test:coverage` (web ratchet
    ≥ 95 % statements / ≥ 80 % branches), `pnpm build`.
11. Any test assertion that changed is updated in the same commit/PR with this spec
    cited, and the change is enumerated in the PR description.
12. No API, contract, database, migration, worker, guard, or header change was
    introduced; no out-of-scope item (§12) was implemented.

## 10. Testing requirements

### 10.1 Existing suites (must stay green — the primary gate)

- **Unit/smoke (vitest, `test/unit/**`, `test/e2e/**`)**: public/auth/dashboard/docs
  suites pass; class-name hooks (F4) preserved or deliberately updated with this
  spec cited; coverage ratchet (ADR-0034) holds at current thresholds.
- **Browser (Playwright, `test/browser/critical-flows.spec.ts`)**: every critical
  flow (public journey, register → project → customer → payment → api key → sign
  out, login, route protection, headers-on-routes, tenant isolation, 429) passes
  against the built stack with the real CSP — proving the polish introduced no
  CSP-relevant regression (external-asset mistakes fail here loudly).
- **Security-headers unit spec**: untouched and green.

### 10.2 New/changed tests

- New unit tests are only needed for new component logic introduced by the polish
  (e.g., a conditional brand-mark renderer); pure-CSS changes need none (F9 — CSS is
  outside coverage include, component logic is not).
- If D7 resolves visual regression **in**, the baseline procedure and maintenance
  cost must be specified in an amended version of this document before
  implementation; the default (recommended) resolution is **out** — no screenshot
  baselines.

### 10.3 Manual visual QA (required regardless of D7)

A short QA pass over `/`, `/product`, `/docs` (one guide + api reference), `/login`,
`/register`, `/dashboard` (overview), one project shell with payments + api-keys
tables, and `/dashboard/settings` at **≈ 360 px** and **desktop** widths, checking:
no horizontal scroll, no clipped/overlapping controls, readable contrast, visible
focus on keyboard navigation, consistent spacing/type, and no browser console CSP
errors. Findings are fixed before merge; the QA note lives in the PR description.

## 11. Out of scope

- Any API, OpenAPI contract, database, migration, or worker change (escalate per
  AGENTS.md).
- New routes, pages, or product features; content/copy rewrites beyond D9.
- Dark mode / theming (D6 — recommended out per ADR-0026).
- Styling frameworks, CSS-in-JS, component libraries, or new runtime dependencies
  (D2/D8 — recommended out).
- Visual-regression screenshot infrastructure (D7 — recommended out).
- Documentation content authoring, guide rewrites, OpenAPI changes (Phase 15 owns
  content; Q1 limits this phase's docs work to presentation).
- i18n/localization; marketing/legal/pricing pages; session-aware public nav.
- ROADMAP.md edits, v0.2.0 tagging, version bumps, README/badge refresh — release
  bookkeeping, separate maintainer task (Q4).
- Route protection, security headers, session model, API client behavior
  (ADR-0027/0028 settled).

## 12. Decisions (D1–D9 — confirmed 2026-10-21)

Each decision shows the option first as it was **confirmed by the product authority
on 2026-10-21, adopting the recommendation in every case**.

| # | Decision | Recommendation and alternatives |
| --- | --- | --- |
| D1 | **Degree of redesign vs incremental polish** | **Substantial visual refresh within the existing architecture and markup vocabulary**: deepen tokens, rework the shared component styling (buttons, cards, states, tables, nav), redesign the hero treatment, and allow targeted markup changes on the home/auth/overview surfaces — while keeping routes, behavior, and asserted names intact. Alternatives: (a) *conservative polish only* (safe but likely still reads "developer" — fails the portfolio bar), (b) *ground-up redesign with new markup/component architecture* (high regression risk against 9 phases of tests, contradicts the smallest-correct-solution rule). |
| D2 | **Styling architecture** | **Reaffirm ADR-0026** (plain CSS, per-area stylesheets, tokens once, zero styling dependencies). Reopening (Tailwind/CSS Modules/component library) would require a new ADR and is not recommended for a polish phase whose main risk is test regression. |
| D3 | **Typography: custom webfont vs system fonts** | **Keep the system font stack** (`tokens.css` L49–51): zero dependency, zero CSP/asset work, instant render — and polish hierarchy via scale/weight/spacing instead. Alternative: one **self-hosted** variable font file (e.g., a single `.woff2` committed under `apps/web` and served by the app — CSP-compliant per F5) if the product authority wants a more distinctive brand voice; that adds an asset and a licensing check but no npm dependency. External font CDNs are not an option (F5). |
| D4 | **Brand/logo refresh** | **Typographic wordmark polish only** (the "BrinnPay" text `.brand`/`.dashboard-brand` gets refined type treatment); **no invented graphic logo** without product-authority art direction. If the authority supplies or approves a simple mark, an in-repo SVG used in the public/auth/dashboard headers is compatible with the architecture (F1). |
| D5 | **Favicon and social preview (OG image)** | **In scope, minimal**: add an app-served favicon (SVG or ICO, consistent with D4) plus `icons`/`openGraph` metadata in `app/layout.tsx` using title/description that already exist; an OG *image* only if it can be a small committed asset without new tooling (otherwise metadata-only). All assets self-hosted under the existing CSP (F2/F5). Alternative: defer entirely (records a known gap in the portfolio). |
| D6 | **Dark mode** | **Out** for this phase — ADR-0026 recorded single-theme scope; the token structure keeps a future dark theme cheap, and adding a theme system now doubles the contrast/QA surface (§10.3) for a polish release. Revisit after v0.2.0 if desired. |
| D7 | **Visual regression testing** | **Out**: no `toHaveScreenshot` baselines. Screenshot baselines are platform/font-rendering sensitive, add ongoing maintenance, and the bounded Playwright suite (role/name flows + real CSP) plus manual QA (§10.3) already catches functional and CSP regressions. Alternative (in) only if the authority accepts the maintenance cost — then this spec must be amended with the procedure before implementation. |
| D8 | **New dependencies (icon set, utilities)** | **No new runtime dependencies.** Icons, if used for scannability (empty states, nav, status), are a **small set of hand-authored inline SVGs** in `apps/web/components` (CSP-clean, tree-shaken by construction). Alternative: an icon package (lucide etc.) rejected for dependency weight and review surface on a polish-only phase. |
| D9 | **Public-site copy: rewrite vs style-only** | **Style-first, English copy preserved**, with **minor copy edits allowed only where hierarchy demands** (e.g., hero subheadline tightening) — and only with test updates in the same change for any asserted string (F4: `BrinnPay`, `Product`, `Documentation`, `Get started`, `Log in`). A full marketing rewrite is out (risk of invented claims; Phase 14 §4.1 accuracy rules stand). Alternative: *strict style-only* (zero test risk, but the hero may stay wordy). |

## 13. Questions (Q1–Q4 — answered 2026-10-21)

Each question carries the answer **confirmed by the product authority on 2026-10-21,
adopting the recommendation in every case**.

1. **Q1 — Docs section scope.** Does the docs area receive a full presentation
   redesign or a light consistency pass? **Recommendation: light consistency pass** —
   apply refined tokens/typography/spacing and component polish to `docs.css` and the
   docs components without restructuring navigation, content, or the API-reference
   layout; this keeps 15 routes × their unit suites out of regression risk while the
   public/auth/dashboard surfaces carry the visual upgrade (F10).
2. **Q2 — Decorative assets beyond favicon/OG.** Are self-hosted decorative assets
   (e.g., an abstract hero background SVG, dashboard empty-state illustrations)
   desired, or CSS-only decoration? **Recommendation: CSS-only decoration** (gradients,
   borders, type) plus the D4/D5 mark/favicon — smallest asset footprint, no licensing
   questions; escalate if richer illustration is wanted.
3. **Q3 — Dashboard depth.** Should the polish touch every dashboard feature view
   with targeted markup work, or rely on the shared vocabulary (§7.1) plus the
   overview/shell as the showcase pages? **Recommendation: shared vocabulary for all
   views + targeted markup polish only on shell, overview, settings, and one
   representative data-heavy view (e.g., payments)** — portfolio reviewers see the
   shell/overview first; per-view markup churn across 14 views multiplies F4 test
   risk for low showcase value.
4. **Q4 — Release bookkeeping.** Does this phase include version bump to 0.2.0,
   README screenshot/badge refresh, and the v0.2.0 tag? **Recommendation: no** —
   those are release-time maintainer tasks outside this phase's file scope
   (Phase 16 Q2 / Phase 14 F10 precedent); this phase delivers the merged UI, and the
   maintainer tags v0.2.0 after merge.

## 14. Implementation considerations (not requirements)

- Work area-by-area (tokens/base → public → auth → dashboard → docs pass), keeping
  the tree shippable after each area; run the full suite per area, not only at the
  end — F4 surprises are cheapest when caught early.
- Prefer styling-only changes; when markup changes are needed (hero structure, button
  classes on auth submit), keep them minimal and behavior-neutral, and update the
  specific failing assertion in the same change citing this spec.
- Do not touch `next.config.ts`, `lib/brinnpay/*`, auth guard/provider components,
  or Playwright webServer configuration — they are settled (ADR-0027/0028/0033).
- New assets (D4/D5) live under `apps/web` and are served by Next.js (the app's
  `public/` directory convention or equivalent app-served route); verify with the
  browser suite that CSP stays clean (F5).
- Keep stylesheets readable and token-driven; resist one-off magic values — the next
  phase (22+, when resumed) inherits this CSS as its baseline.
- Docker dev mounts already cover `apps/web/styles` (ADR-0026 consequence) — no
  infrastructure change expected; if a new directory (e.g., `apps/web/public`) needs
  a mount for hot reload, that is a minimal `docker/compose.yml` tweak to flag in the
  PR, not a redesign.
- The PR description carries the §10.3 manual QA note and the F4 assertion-change
  enumeration.

## 15. Definition of done

- D1–D9 confirmed and Q1–Q4 answered by the product authority; status line updated
  from DRAFT accordingly.
- All §9 acceptance criteria satisfied, including WCAG AA contrast and the §10.3
  manual QA pass.
- All existing suites green with no weakened assertions: lint, typecheck, unit,
  jsdom e2e, Playwright browser (against the built stack with real CSP), coverage
  ratchet at current thresholds, build — locally and in CI.
- No API/contract/database/guard/header change; no out-of-scope item (§11)
  implemented; ADR-0026 reaffirmed (or a new ADR recorded if D2 was reversed).
- The result is a web application that visibly reads as a professional, polished
  product suitable for the v0.2.0 portfolio showcase.
