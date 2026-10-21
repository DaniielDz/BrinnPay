# ADR-0032: Webhook Destination Simulation — Documented URL Marker with Attempt-Counting Semantics

- **Status:** Accepted
- **Date:** 2026-10-07
- **Phase:** 16
- **Scope:** How a registered webhook endpoint's deliveries are made to fail on demand
  without a broken receiver — the URL-marker mechanism, its attempt-counting semantics,
  classification, and precedence (Phase 16 D5; §5).

## Context

Phase 10 §11 delegated to this phase "sandbox failure/timeout simulation for webhook
delivery, including forcing a destination to fail on demand". The delivery machinery
already exists: one attempt = one HTTP request recorded on the `webhook_deliveries` row,
a destination-policy denial short-circuit that performs and counts **no** attempt, a
classification table (network/timeout/408/429/5xx → retry ladder; other 4xx/3xx →
terminal), 5 attempts with exponential backoff + jitter (Phase 10 D5/D6), replay
(Phase 10 D12), and the Phase 13 §16 "replay-failure scenarios" obligation.

Constraints:

1. **No broken receiver required.** The point of the feature is that a developer can watch
   attempt bookkeeping, backoff, eventual `failed`, dashboard visibility, and replay
   *without* running a failing server.
2. **The difference from policy denial must stay legible.** A destination-policy denial
   counts no attempt (it stands for "no request was made"); a simulated failure stands in
   *for* a request and must behave like one — the two semantics coexist in the same
   service and must not blur.
3. **No schema change, no new operation, no new rate-limit class** if avoidable: every
   contracted route must declare a Phase 13 class, and a new operation drags in an
   operation id, an audit review (Phase 12 allowlist), and a test matrix.
4. **Deterministic and replay-safe.** The behavior must be reproducible for replays and
   independent of any runtime state that a worker restart could lose.
5. **Must not weaken existing outbound controls.** Unmarked destinations keep the
   Phase 10/ADR-0019 posture: no redirects, bounded timeouts, sanitized logs, no secrets
   in stored outcomes.

## Decision

**A documented marker in the endpoint's registered URL: exact path segments
`/sandbox/<action>` where `<action>` ∈ `fail` | `timeout` | `reject` (D5 (a), confirmed
2026-10-07), evaluated per attempt.**

- **Mechanism:** the marker lives in the already-stored `url` — no schema change, no new
  endpoint, no control-plane state. The developer opts in per endpoint by registering a
  marked URL, which makes the intent visible in the endpoint list and survives restarts.
- **No outbound HTTP** is made for a marked delivery; the platform records the simulated
  outcome instead of calling out (§5.2 rule 1). The feature therefore cannot be used to
  probe or amplify traffic.
- **Attempt counting:** a simulated failure **counts as an attempt** — `attempts`
  increments, the ladder advances, `next_attempt_at` is scheduled by the unchanged
  env-driven backoff. This differs deliberately from the destination-policy denial path,
  which counts no attempt; both behaviors coexist and are individually tested (F5).
- **Classification:** `fail` → simulated network error (retryable class); `timeout` →
  simulated request timeout (retryable class); both retry until `WEBHOOK_MAX_ATTEMPTS` is
  exhausted ⇒ delivery `failed`. `reject` → terminal non-retryable rejection, fails on
  attempt 1 ⇒ `failed`.
- **Recorded outcome:** a fixed, sanitized summary string (e.g. "simulated network error
  (sandbox)") with `response_status = null`; no response bodies, no secrets — Phase 10
  §5.4 storage rules hold unchanged. Fixed strings are constants, never formatted from
  the URL. No signature is ever emitted for bytes that were not sent (signing remains
  "HMAC over exactly the bytes sent").
- **Precedence:** URL validation → destination policy (existing, terminal) → simulation
  marker, evaluated per attempt like the policy check. Implemented as a classification step
  *beside* (not inside) the policy-denial short-circuit so the two attempt-counting
  semantics stay legible.
- **Exact-segment matching, never substring:** `/sandbox/fail` matches;
  `https://example.com/failure-handler` and `.../sandbox/webhook` never do; query-string
  lookalikes never do.
- **Scope:** applies to every delivery to that endpoint — all event types and replays —
  and to nothing else. Unmarked endpoints are completely unaffected (the real-HTTP path
  keeps its existing integration tests). The marker never bypasses endpoint `enabled`
  gating, subscription filtering, retention, or rate limits — it only replaces the HTTP
  attempt.
- **Documentation:** endpoint create/update descriptions note that marked URLs produce
  simulated failures (in-place refinement, ADR-0012); `/docs/webhooks` and `/docs/sandbox`
  document the markers, their classification, and the attempt/ladder behavior, with the
  shared facts guarded by the Phase 15 D8 consistency mechanism.

## Consequences

- Zero schema, contract-operation, rate-limit, and environment-variable impact under the
  confirmed option; the existing delivery bookkeeping, retry ladder, dashboard inspection,
  and replay all work unchanged around the marker.
- Because the marker is part of the URL, it is per-endpoint only (not per-event,
  per-attempt, or per-project) and cannot be toggled after registration without an
  endpoint update — acceptable for a deterministic sandbox and it keeps state out of the
  worker.
- The attempt-counting difference from policy denial is now a permanent, tested property
  of the delivery service; any refactor that merges the two short-circuits silently
  changes retry behavior and must be caught by AC7.
- Phase 13 §16's "replay-failure scenarios" obligation is discharged: replaying to a
  marked endpoint produces the same zero-HTTP, ladder-advancing behavior.
- The Phase 18 security review covers this outbound delivery-path change (§8 rule 10);
  the feature adds no outbound request, no new data at rest, and no new secret handling.

## Alternatives rejected

- **Per-endpoint `simulation` setting** (D5 (b)) — explicit, but expands the endpoint
  contract, its UI, and its schema for the same effect.
- **Control endpoint ("fail next delivery")** (D5 (c)) — a new operation (operation id,
  Phase 13 class, audit review, test matrix), stateful, and race-prone with the async
  worker that performs the delivery.
- **Simulating by not counting attempts** — would blur the feature with the destination-
  policy denial path and hide real retry behavior from the developer.
- **Substring/regex matching on the URL** — risks simulating legitimate endpoints such as
  `/failure-handler` or `/sandbox/webhook`.
- **Blocking private/loopback destinations to make failures easier** — rejected upstream by
  ADR-0019 (a sandbox must deliver to local and tunnel URLs); unrelated to this mechanism.
