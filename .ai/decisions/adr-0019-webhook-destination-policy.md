# ADR-0019: Webhook Outbound Destination Policy (SSRF Posture)

- **Status:** Accepted
- **Date:** 2026-09-28
- **Phase:** 10
- **Scope:** Which destinations a webhook endpoint may name and what compensates for the permissive
  default (phase 10 D13, §5.7).

## Context

A registered webhook destination is turned into an **outbound** HTTP request made by BrinnPay to a
URL that a project member chooses. That is a server-side request forgery surface: the caller picks
the host, and the request originates from inside the deployment's network, where it can reach the
database, Redis, the admin surfaces, or a cloud metadata endpoint.

The two obvious defaults both fail this phase's purpose:

- **Block private, loopback, and link-local ranges by default** is the standard hardened posture,
  but it breaks the sandbox's primary use case: a developer building an integration must be able to
  receive webhooks on `localhost`, a container name, or a tunnel URL. Blocking those makes the
  feature untestable exactly where it matters most.
- **Allow only a configured allowlist** is safe but operationally heavy before staging exists: every
  developer who wants to receive on a new tunnel host would need a deployment change.

The decision was therefore not "is SSRF real" but "which posture the sandbox ships, and what makes
it defensible".

## Decision

**Allow private, loopback, and link-local destinations by default, bounded by strict URL
validation, no redirect following, bounded timeouts, no credential forwarding, sanitized logs,
tenant isolation, and an optional allow/deny list that a deployment can configure.**

- **Boundary validation** (`webhook-url.ts`): only absolute `http`/`https` URLs with a host, at most
  2048 characters, no embedded credentials and no fragment. Normalization is minimal — scheme and
  host lowercased, a lone trailing `/` collapsed — so the stored URL is what the developer
  registered and what is delivered to.
- **No redirect following.** A `3xx` is a terminal `failed` and the `Location` is never fetched.
  Following redirects would let a benign-looking registration redirect an internal request, and it
  would also break the signature contract, since the signature would be computed for a body the
  first hop never sent.
- **Bounded timeouts.** Separate connect and request timeouts cap how long a chosen destination can
  hold the worker, and the response body is never read or stored, so a slow or hostile destination
  cannot exhaust the delivery process.
- **No credential forwarding.** The inbound `Authorization` header and the endpoint's signing
  secret are never forwarded to the destination, and neither is ever logged or written to
  `last_error`; only a bounded, sanitized summary of the outcome is stored.
- **Tenant isolation.** The endpoint (and therefore the destination) belongs to exactly one project
  and environment, and every lookup scopes by both, so a destination registered in one tenant is
  unreachable for another.
- **Optional allow/deny list.** `WEBHOOK_DESTINATION_ALLOWLIST` and `WEBHOOK_DESTINATION_DENYLIST`
  are exact, case-insensitive host matches, both empty by default. The allowlist, when non-empty,
  wins over the denylist, so a deployment can open one known host inside a broader denial. This is
  the control a staging or production deployment is expected to set.
- **The list is enforced at delivery time, not only at registration.** A denied or non-allowed host
  is a terminal `failed` with a generic reason that does not name the URL, and **no outbound request
  is made**. This is the difference between a control and a validation rule: an operator adding a
  host to the denylist during an incident has to stop the traffic that is already registered and in
  flight, not merely prevent the next registration. A denial is terminal rather than retryable,
  because retrying would keep contacting the host the operator just removed. The policy is provided
  by `WebhooksCoreModule` so the API and the worker read one source, and `enabled` is deliberately
  **not** re-checked at attempt time — D11 makes that a switch on enqueueing new deliveries.

## Consequences

- The permissive default is a **deliberate, accepted risk** for a sandbox that processes no real
  money and no production secrets. It is not a safe default outside that context: a deployment that
  is not a sandbox must set the allow/deny list, and this ADR must be revisited before any such
  deployment rather than left as an inherited assumption.
- Validation happens when the endpoint is registered, and the delivery re-checks the allow/deny list
  before making the request, but both compare the **host name** rather than the resolved address, so
  the host is still resolved at attempt time. A DNS name that resolves differently later — a
  rebinding or time-of-check/time-of-use attack — is **not** mitigated in v1; the allow/deny list is
  host-based and shares the same limitation. This is accepted for the sandbox and is the main item a
  hardened mode would need to address: pinning the resolved IP and re-validating it against the
  policy would close both at once.
- Matching is an **exact host match**, not a suffix or pattern match. Denying `internal.example.com`
  does not deny `evil.internal.example.com`. A list that is not a pattern language cannot express "no
  `*.internal.example.com`", which is a real operational limit rather than a defect; suffix and CIDR
  matching belong to a hardened mode.
- Both sides of the comparison are **canonicalized** before matching (IPv6 brackets stripped, one
  trailing FQDN root dot removed). Without that, an operator writing `::1` or `localhost.` would
  configure an entry that could never match the URL spellings `[::1]` and `localhost.`, so a denylist
  would silently fail to deny the hosts it names — fail-open, and in the direction that matters. A
  control that matches only the exact literal string the operator happened to type is documentation
  that looks like a control.
- `WEBHOOK_CONNECT_TIMEOUT_MS` is **not** a connect-phase budget. `fetch` exposes no separate connect
  phase, so it aborts the whole request and the effective bound is
  `min(connectTimeoutMs, requestTimeoutMs)` — 5 s with the shipped defaults, not 10 s. The bound is
  real and is what D13 relies on; the two knobs are simply not independent. A true connect-phase
  budget needs an undici dispatcher hook and is a hardened-mode item.
- Because redirects are never followed, a destination that answers behind a redirect must expose the
  direct URL; this is a documented destination requirement, not a defect.
- The compensating controls live in code paths that later phases may touch (the delivery request
  builder, the retry classification, the structured logger). Removing any of them — for example
  starting to follow redirects or to log response bodies — reopens this decision and requires a new
  ADR.
