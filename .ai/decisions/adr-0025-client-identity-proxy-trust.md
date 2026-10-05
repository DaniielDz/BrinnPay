# ADR-0025: Client Identity and Proxy Trust — Explicit Bounded Trust With Canonicalization

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** 13
- **Scope:** How the API decides which client a request belongs to for rate-limiting purposes, how a
  deployment behind a load balancer configures that decision, and why the same model governs the Phase 3
  auth limits (phase 13 D1).

## Context

The Phase 3 limiter keyed on `request.ip` while Express `trust proxy` was configured nowhere. That is
untenable in both directions, and the two failures are opposite:

- **Always trust the socket peer.** Behind the Phase 22/24 load balancer every internet client shares one
  bucket, so a handful of legitimate users exhaust everyone else's budget. The limits become a self-inflicted
  outage — worse than having no limits.
- **Always trust `X-Forwarded-For`.** The header is client-controlled on a directly exposed deployment, so a
  caller forges a new value per request and holds unlimited budgets. A limit that can be bypassed by changing
  a header is a defect, not a tuning problem (§8).

A third, quieter failure sits on top of both: whatever identity arrives is a *textual* value, so the same
client could hold several budgets by writing its own address differently (`::ffff:1.2.3.4`, `1.2.3.4`,
`[::ffff:1.2.3.4]`, `FE80::1%eth0`).

## Decision

**An explicit, env-driven trust model, and a canonical discriminator form before anything is hashed.**

- **Default: the direct socket peer.** With `TRUST_PROXY_HOPS=0` and no `TRUST_PROXY_CIDRS`, forwarded
  headers are ignored for limit purposes. A caller that reaches the socket directly cannot move its bucket
  by sending a header.
- **Explicit trust behind a proxy.** A deployment sets `TRUST_PROXY_CIDRS` to the addresses of the proxies
  it vouches for, and `TRUST_PROXY_HOPS` to the number of hops between the socket and the client (bounded at
  10 — the chain length is attacker-influenced input). **Boot refuses a hop count with no allowlist**: a hop
  count bounds *how much* of a chain is read, never *who* wrote it, so on its own it indexes entries the
   client chose. The **socket peer itself must fall inside the allowlist** before a forwarded header is read;
   otherwise the peer is the identity. Entries below `/8` (IPv4) or `/32` (IPv6) are refused at boot, and an
   IPv4-mapped IPv6 entry (`::ffff:0:0/96` above all) is held to the IPv4 floor: an entry broad enough to
   cover the routing table is not a list of proxies, and one that covers every IPv4 peer re-opens the forge
   the allowlist exists to close. The chain is then walked right to left and the first entry that is not
   a trusted proxy is the client — a client can only add entries to the *left* of its real address, so padding
   cannot steer the walk, and `hops` merely caps how far left it may look.
- **Canonicalization before hashing (D1).** The identity is lowercased, brackets and IPv6 zone identifiers
  are removed, an IPv4-mapped IPv6 address is collapsed to the IPv4 it embeds, and an IPv6 address is
  re-serialized in RFC 5952 form so every legal spelling of one address is one string. The account
  discriminator is trimmed and lowercased, matching how the auth module normalizes an email. One client
  therefore holds exactly one budget per class.
- **Fail safe.** The rightmost forwarded entry must parse as an address or the chain is not read at all —
  it is the entry the trusted proxy appended, and a client can write it when nothing appends after it, so
  dropping it would shift the walk onto an entry the caller chose. A non-address *inside* the window is
  skipped, never returned as an identity. A hop count larger than the chain still answers with the
  rightmost *untrusted* entry — the leftmost inspected entry is used only when every entry inside the
  window is a trusted proxy. The malformed-CIDR case is rejected
  at boot: an
  allowlist entry that can never match is a proxy whose headers are silently ignored while the deployment
  believes they are trusted.
- **One model for both surfaces.** The Phase 3 auth limits go through the same resolver, so a deployment
  configures trust once and the `auth.*` limits are not a second, weaker mechanism.

The resolved identity is used for exactly one thing — being hashed into a bucket key. It is never logged, never
persisted, never returned in a header, and never enters a request-log or audit record (Phase 11's record
allowlist has no column for it).

## Consequences

- The trust configuration is a deployment fact, not a code change, and each environment states its own:
  the local Compose stack and CI run with `0` (no proxy), while Phases 22/24 must set the real values behind
  their load balancer.
- Phase 18 must re-review this posture, and the security review must confirm the values of **each**
  environment: trusting forwarded headers without a proxy in front is the failure this ADR exists to prevent.
- Normalization is deliberately scoped to what the specification requires: RFC 5952 IPv6 serialization and
  the IPv4-mapped collapse. It is *not* a general address parser — an entry in a form this module does not
  read (`1.2.3.4:8080`, an unbracketed IPv6 with a port) is treated as unparseable at the boundary and the
  chain is not read, which degrades to the shared peer bucket rather than to a forged identity.
- Three deployment facts decide whether this model delivers a client identity at all, and none of them is
  enforceable in code:
  - **the proxy must append to `X-Forwarded-For`.** A proxy that forwards the caller's header unchanged is
    indistinguishable from the caller, so every entry — rightmost included — is the client's own claim. The
    resolver then has nothing to recover and returns whatever the caller wrote.
  - **`TRUST_PROXY_HOPS` must equal the real proxy depth.** Set too small, the window stops before the
    client's entry and every client behind that chain shares the leftmost inspected entry — one bucket, which
    one caller can exhaust for everyone. Set too large, the walk simply inspects more of the chain and still
    answers with the rightmost untrusted entry, so an over-large value is safe; only an under-sized one costs
    availability.
  - **allowlist entries should name the proxy addresses only** (a `/32` or `/128` each, or the smallest
    range that holds them). A wide range does not let an *external* client forge an identity — the peer gate
    refuses a peer outside the allowlist before any walk runs — but every host *inside* the range passes that
    gate and can then speak for any client it names, so a wide range hands that power to every machine in it.
    Keep the allowlist to the proxy addresses only.
- The account-lockout property of the `account` scope is not addressed here: an unauthenticated caller can
  spend a known address's login budget and keep it spent, so throttling is per-account rather than per-attacker.
  Recorded in ADR-0024; an auth-UX phase owns the remedy.
- `TRUST_PROXY_CIDRS` is evaluated with Node's `BlockList`, so no hand-rolled CIDR arithmetic — and therefore
  no hand-rolled prefix-matching bug — sits on a security boundary.

## Alternatives rejected

- **Always trust `X-Forwarded-For`:** rejected — trivially forgeable, so IP limits bound nothing.
- **Always use the socket peer:** rejected — one shared bucket behind the load balancer.
- **Leave it implicit, as before:** rejected — the same failure as the socket peer, discovered in production.
- **Trust on hop count alone, with no peer allowlist:** rejected, and refused at boot. A hop count bounds
  *how much* of a chain is read, not *who* wrote it; the CIDR allowlist is what decides whether the peer may
  speak for a client at all, and the two compose.
- **Normalize the identity into a single IP object and key on a canonical form of the parsed address:**
  viable and stricter, at the cost of an IP parser in the request path for no gain over the four
  normalizations above.
- **Read `X-Real-IP` as well as `X-Forwarded-For`:** rejected — a second header a client can also forge,
  widening the surface for no requirement.
- **Reject `X-Forwarded-For` entries that do not parse, failing the request:** rejected — a proxy
  misconfiguration would then break the API rather than degrade the limit. **Silently dropping them** is
  rejected too: dropping shifts every position in the chain, so the walk's answer becomes an entry the
  caller chose. They are inspected instead — skipped inside the window, and fatal to the chain when they
  are the rightmost entry.