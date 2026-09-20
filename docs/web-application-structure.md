# BrinnPay — Web Application Structure and Route Boundaries

> Architecture artifact of **Phase 1 — Architecture & MVP Spec** (phase 1 specification §11, §13.1).
> This document fixes the route boundaries and protection rules; full dashboard polish is
> Phase 14. The organization management, member/role management, and invitation accept areas
> were implemented in Phase 4 (§5).

## 1. Single application, client of the API

`apps/web` is a single Next.js application containing public and authenticated areas.

`apps/web` is a **client of the API**: it contains no parallel backend and no domain/business logic.
All business rules belong to the backend (`apps/api`); the web application consumes the documented
API contracts (`docs/openapi.yaml`) only. The dashboard is treated as a client of the API rather
than as a second backend.

## 2. Public area (unauthenticated)

- `/` — home / product overview.
- `/product` and product detail pages.
- `/docs/**` — documentation and integration guides (Phase 15).
- Marketing/legal pages as required later.

Public routes must not expose authenticated data, internal architecture specifics, or any sensitive
material.

## 3. Authentication area

- `/login`
- `/register`

Session-related flows as defined in Phase 3. These routes redirect authenticated users away from
the auth pages.

## 4. Authenticated area (requires authentication + authorization)

- `/dashboard` — overview.
- `/dashboard/organizations` — organization management and member/role management
  (list + create; Phase 4).
- `/dashboard/organizations/[organizationId]` — organization detail: rename
  (owner/admin), delete (owner-only), member list with role management, and
  invitations (owner/admin); **non-members see a not-found state** mirroring the
  API's 404 semantics (phase 4 D1).
- `/dashboard/invitations/[invitationId]` — invitation accept flow (phase 4 D6):
  the accept URL is how an invited user reaches the flow in the absence of email
  delivery; success links back to the organization, API errors map to
  not-found / no-longer-pending / already-member states.
- `/dashboard/projects` — project list and management.
- `/dashboard/projects/[projectId]` — project shell with environment selector (`TEST`/`LIVE`).
- `/dashboard/projects/[projectId]/api-keys`
- `/dashboard/projects/[projectId]/customers`
- `/dashboard/projects/[projectId]/payments`
- `/dashboard/projects/[projectId]/refunds`
- `/dashboard/projects/[projectId]/webhooks`
- `/dashboard/projects/[projectId]/logs/requests`
- `/dashboard/projects/[projectId]/logs/audit`
- `/dashboard/settings` — account settings.

## 5. Route protection rules

- Authenticated routes reject unauthenticated visitors (redirect to `/login`).
- **Authenticated routes require authentication + authorization.**
- Organization-scoped pages enforce membership; **project-scoped routes validate project access
  within the organization** before rendering any data. A non-member reaching
  `/dashboard/organizations/[organizationId]` sees a not-found state (phase 4 D1), matching
  the API's 404.
- Role-based UI restrictions match the RBAC model (e.g., viewer sees read-only interfaces;
  admin never sees owner-management controls; members see only self-demotion/leave actions).
  The **API remains the enforcement point**; UI hiding is presentation only (phase 4 §5.3).
- Data displayed is fetched from the API under the user's session; the web application never
  bypasses API-level authorization.

## 6. Route area summary

| Area | Routes | Access |
| --- | --- | --- |
| Public | `/`, `/product*`, `/docs/**`, legal | Unauthenticated |
| Authentication | `/login`, `/register` | Unauthenticated; redirect authenticated users away |
| Authenticated | `/dashboard/**`, `/dashboard/settings` | Authenticated + authorized (membership / project access / role-based UI) |

## 7. Session handling in the web application

Session details confirmed in Phase 3 (phase 1 §11.5, D2/D3/D10): access tokens
live 15 minutes (env-configurable); refresh sessions rotate on every refresh
with reuse detection (D3) and each session lasts 30 days (D10); the cookie is
`brinnpay_refresh`, `Path=/api/v1/auth`, `HttpOnly` always, `SameSite=Lax`,
`Secure` in secure/production environments.

- **Access token:** short-lived JWT used to call the API; **never** stored in `localStorage` or
  `sessionStorage`; held in memory for the active session and re-obtained via refresh.
- **Refresh token:** revocable, persisted server-side (`RefreshSession`); exposed to the browser
  **only** as an `HttpOnly` cookie (`Secure` in secure/production environments; `SameSite`
  configured to minimize CSRF); never readable by browser JavaScript.
- **Logout:** revokes the refresh session server-side and clears the cookie; the dashboard then
  returns to the public area.
- `apps/web` never sees or logs token material; API responses and error payloads never contain
  refresh tokens.