# ADR-0016: Webhook Delivery Aggregate, Retry Classification, and Signature

- **Status:** Accepted
- **Date:** 2026-09-28
- **Phase:** 10
- **Scope:** The delivery record's granularity, the retry/outcome policy, redirect handling, and the
  signing scheme (phase 10 D4, D6, D7; F1).

## Context

Phase 1 §6.2 calls a `WebhookDelivery` "one delivery attempt", but the contract's `WebhookDelivery`
has an `attempts` counter and the states `pending`/`delivered`/`failed` — that is an **aggregate
over attempts**, not one attempt. The two readings cannot both be implemented, and the
implementation must also decide:

- how many attempts, with what backoff, and which failures are worth retrying at all;
- what an outbound request may do to a destination it does not control (redirects, credentials,
  reading the body, logging it);
- what material a destination can use to authenticate a request, given the body is signed and the
  timestamp must be verifiable.

Retries amplify permanent misconfiguration (a wrong URL returning 404 retried five times) and
redirect following is both an SSRF and a signature-confusion risk: the signature covers a body the
redirect target never verified.

## Decision

**One `webhook_deliveries` row per `(event, endpoint)` with an attempt counter and the last
attempt's outcome. Retries are bounded, classified, and never follow redirects. The signature is a
timestamped HMAC over the exact transmitted bytes.**

**Record granularity (D4/F1).** The contract's model wins: a single row with `attempts`,
`response_status`, `last_error`, and `next_attempt_at`. A per-attempt history table would make the
delivery list unreadable and is deferred; the envelope `id` and `BrinnPay-Delivery-Id` are what a
destination uses to deduplicate.

**Retry policy (D5).** Five attempts total, exponential backoff with full jitter (≈ 0 s, 30 s,
2 min, 10 min, 1 h), capped, and env-driven. A `Retry-After` that parses is honored and clamped to
the same cap; an HTTP-date is accepted, anything else is ignored.

The nominal ladder in D5 is stated with "≈", and the implementation realizes it with a **factor of
5** on a 30 s base: ceilings of 0 s, 30 s, 150 s, 750 s, and the 1 h cap — so the fourth rung is
12.5 min rather than 10 min, and the cap is the term that binds on the final attempt. The factor
was chosen so the ladder is short enough to finish a delivery inside the 30-day retention window with
room to spare, while still spanning three orders of magnitude. Full jitter is then applied uniformly
across `[0, ceiling]`, which is what spreads a batch that failed together against a shared outage;
the realized delays are therefore already far from the nominal rungs, and matching them exactly would
buy nothing a consumer could observe.

**Classification (D6).**

| Outcome | Result |
| --- | --- |
| 2xx | `delivered` |
| network error, connect/read timeout | retry |
| 408, 425, 429, 5xx | retry |
| other 4xx (e.g. 404) | terminal `failed`, never retried |
| 3xx | terminal `failed`; the `Location` is **never** followed |

**Outbound request rules (security posture).** Only `http`/`https`, validated and normalized at
registration; a per-request timeout; no redirect following; no credential forwarding; the response
body is never read or stored; the destination's error text is never stored verbatim — only a
bounded, sanitized summary. Secrets and the `Authorization` header of inbound API requests are never
logged.

**Signature (D7).** Every request carries:

```text
BrinnPay-Signature: t=<unix-seconds>,v1=<lowercase-hex HMAC-SHA256>
```

over exactly `` `${t}.${rawBody}` ``, keyed by the endpoint's signing secret, plus
`BrinnPay-Event-Id`, `BrinnPay-Event-Type`, `BrinnPay-Delivery-Id`, and a 1-based
`BrinnPay-Attempt`. A fresh timestamp per attempt gives consumers replay protection; the delivery
id plus the envelope id gives them at-least-once deduplication. Repeated attempts of one delivery
are byte-identical apart from the timestamp and the attempt header, so a signature check fails only
when the body or the secret is wrong.

## Consequences

- A permanently broken destination costs a bounded number of requests and ends in a readable
  terminal `failed` row instead of an infinite retry loop; a transient one recovers on its own.
- `last_error` is deliberately poor for debugging (status class only) and excellent for security:
  it cannot leak a destination's response body, a secret, or internal detail into the dashboard.
- A destination that returns 3xx must be fixed; nothing chases the redirect, so a signature is never
  presented to a host the operator did not register.
- The aggregate row means the delivery list shows the current state, not the history; per-attempt
  history is a future additive change, not a redefinition of the entity.
- Because delivery is at-least-once, **every** consumer must deduplicate by envelope `id`; that is
  documented as the consumer contract rather than papered over with exactly-once claims.
