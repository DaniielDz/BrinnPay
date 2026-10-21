# ADR-0026: Web Styling Approach — Plain CSS with Per-Area Stylesheets and Shared Tokens

- **Status:** Accepted
- **Date:** 2026-10-05
- **Phase:** 14
- **Scope:** How the Next.js application is styled — plain CSS (D1), no new dependency,
  tokens defined once, stylesheets organized per area (§7.1).

## Context

Phase 14 F3 recorded that the web application had **no styling at all**: no stylesheet, no
design tokens, no responsive behavior, and no decided styling approach. The choice had to
be made before any visual design could ship, in a workspace whose master specification
forbids new packages "unless concrete, demonstrated reuse" exists. The candidate approaches
differ mostly in tooling cost, not in capability:

1. **Tailwind** — utility classes at call sites, but a new dependency plus build
   configuration, and a second source of truth for spacing/color that competes with the
   semantic class names already asserted by the Phases 3–12 tests.
2. **CSS Modules** — scoped by construction, but introduces a naming/build convention per
   file for a codebase that has none, and scoped names would hide the existing `env-badge`,
   `item-row`, `state`, `button-primary` vocabulary from review.
3. **A component library** (MUI, Chakra, …) — heavyweight for an MVP, and it would replace
   the pages' markup and accessible names rather than present them.
4. **Plain CSS** — zero new dependencies, works with Next.js unchanged, and lets the
   existing semantic class names become real style hooks without touching behavior.

Additional constraints from the phase:

- Styling must **not alter accessible names** asserted by existing tests (nav labels,
  headings, button names); class names must not become test contracts (§16, §11.2).
- Responsive behavior is required from small mobile widths to desktop with **no
  horizontal scrolling** for public, auth, and dashboard areas (§7.1).
- Motion must respect `prefers-reduced-motion` if any motion is introduced (§7.6).

## Decision

**Plain CSS, global stylesheets organized per area, built on the existing semantic class
names, with tokens defined once.**

- **One stylesheet per area, imported from the root layout:** `styles/tokens.css`,
  `styles/base.css`, `styles/public.css`, `styles/auth.css`, `styles/dashboard.css`.
  They are imported in `app/layout.tsx`, so every route — public, auth, and
  authenticated — receives the same foundation without per-page imports.
- **Tokens first (`:root` custom properties):** color (neutral scale, text, brand/status,
  environment badges), spacing scale, typography scale and font stacks, radii/shadows, and
  layout constants (`--sidebar-width`, `--content-max-width`). Area stylesheets consume
  tokens; raw values appear only in `tokens.css`. This is the whole token strategy —
  no theming layer, no dark mode (single theme, out of scope per §12).
- **No new dependency and no build configuration:** nothing is added to `package.json`,
  no compiler plugin, no PostCSS pipeline beyond Next.js defaults.
- **Existing semantic names are the hooks.** `public-layout`, `auth-layout`,
  `dashboard-shell`, `item-row`, `state`, `env-badge`, `button-primary`,
  `environment-selector`, `env-selected`, `rate-limit-indicator` … already exist in the
  markup and in the Phases 3–12 assertions; styling them keeps page behavior and tests
  unchanged. Tests keep asserting roles, names, and behavior — never class names (§11.2).
- **Responsive by disclosure, not by reflow hacks:** the dashboard sidebar collapses
  behind the existing `nav-toggle` button (`aria-expanded`/`aria-controls`) below
  `--sidebar-width`-scale breakpoints; tables scroll inside their own `.table-scroll`
  region rather than stretching the page; public/auth headers wrap.
- **`prefers-reduced-motion: reduce`** collapses animation/transition durations globally
  in `base.css`, so future motion is safe by default.

## Consequences

- No tooling or version-drift risk: the stylesheets are compiled by Next.js exactly like
  the rest of the app, and the Phase 14 requirement "zero new dependencies" holds.
- Global scope means specificity conflicts are possible; the mitigation is organizational
  (one file per area, tokens for shared values) rather than automatic. A later phase that
  wants scoped styles can adopt CSS Modules incrementally — this decision does not
  forbid it, it only fixes what Phase 14 ships.
- The docker dev mounts had to be extended to `components`, `lib`, and `styles`
  (`docker/compose.yml`), because the previous mounts covered only `apps/web/app` and
  `next.config.ts` — without them, edits to shell components or styles would not hot-reload.
- Because styles live outside `app/`, changes to them do not alter rendered text or
  structure, so the accessibility baseline (§7.6) is unaffected by restyling.

## Alternatives rejected

- **Tailwind:** rejected — new dependency plus build configuration for no capability gain,
  and it would fork the styling vocabulary away from the class names the existing tests
  and pages already use (D1).
- **CSS Modules:** rejected — a per-file scoping convention and generated names for a
  codebase with none; it would hide the shared semantic vocabulary from plain-text review.
- **A component library:** rejected — heavyweight for the MVP; it replaces markup and
  accessible names instead of presenting the existing ones.
- **Inline styles or a `<style>` tag per page:** rejected — no tokens, no reuse, and it
  would put presentation decisions inside client components.
