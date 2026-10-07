# Phase 16 — Sandbox

| | |
| --- | --- |
| Phase | 16 — Sandbox |
| Status | **Approved — D1–D10 confirmed and Q1–Q2 answered by the product authority on 2026-10-07, exactly as recommended (D1–D10 = option (a) each; Q1 forced-`429` scenarios excluded; Q2 ROADMAP bookkeeping deferred to a separate `chore/*` change). This specification is ready for implementation.** |
| Depends on | Phase 1 (API conventions, event envelope §9.5, error format), Phase 2 (env-driven configuration pattern, migration workflow), Phase 7 (payment state machine, default-success simulation, `failure_code` column, event catalog, capability matrix), Phase 8 (idempotency on `payments.create`), Phase 9 (refund eligibility rules — unchanged consumer), Phase 10 (event persistence/delivery, retry ladder, replay, advancement sweep), Phase 12 (audit entries for `payment.failed` including `failure_code`), Phase 13 (rate-limit class catalog and its Phase 16 obligations), Phase 14 (payments view and create form — the UI hook this phase extends), Phase 15 (sandbox guide, content tests, D6 handover), ADR-0001…ADR-0030 |
| Blocks | Phase 17 (scenario flows and the updated docs become e2e targets), Phase 18 (security review covers the new contract field and the outbound delivery path change), Phase 25 (local-development/sandbox content reused from the extended guide), Phase 26 (verify sandbox scenarios before release) |
| Roadmap | [ROADMAP.md](../../ROADMAP.md), Phase 16 |
| Branch | `chore/phase-16-sandbox` |

## 1. Objective

Extend the BrinnPay sandbox from the single default-success simulation (Phase 7) into a
**scenario-capable simulation sandbox**: developers must be able to produce payment
**declines**, payment **timeouts**, and **webhook delivery failures** deterministically —
without real money, without real card data, and without changing the legal payment
lifecycle.

This phase adds the failure-injection surface that Phases 7, 10, 13, 14 and 15 explicitly
deferred to it, and it updates the published documentation that currently (correctly)
states these behaviors do not exist.

### Roadmap traceability

| Roadmap checkbox | Where |
| --- | --- |
| Success simulation | §4.4 — behavior delivered by Phase 7; this phase verifies it, keeps it the default, and claims the checkbox with regression evidence (§10 AC1) |
| Decline simulation | §4.5 (D1, D3, D4) |
| Timeout simulation | §4.6 (D3) |
| Webhook failure simulation | §5 (D5) |

## 2. Scope

In scope:

- **Scenario selection on `payments.create`** — an optional, additive request field that
  fixes a payment's simulated outcome at creation (D1, D2).
- **Decline semantics** — a payment that reaches `failed` on the normal schedule with a
  `failure_code` from a **defined catalog** (D3, D4); the catalog discharges Phase 7's
  OQ-3.
- **Timeout semantics** — a payment whose simulation does not complete (D3).
- **Simulation-engine extension** that preserves every Phase 7 lifecycle rule (state
  machine edges, CAS advancement, determinism from `created_at`, restart safety).
- **`failure_code` becomes a written value**: the failed edge writes it atomically with
  the status change, and it appears in the API response, the `payment.failed` webhook
  payload, and the audit entry (§4.7, F2).
- **Webhook delivery failure simulation** — a documented, deterministic way to make
  deliveries to a registered endpoint fail without running a failing receiver (§5, D5).
- **Dashboard hook** — scenario selection in the existing payments create form and
  `failure_code` visible on failed payments (Phase 14 handover, D9).
- **Documentation extension** — `/docs/sandbox` gains the scenario content Phase 15 D6
  reserved for this phase; the payments/quickstart guides and their tests stop claiming
  the absence of triggers (Phase 15 handover, D10).
- **Contract refinement in place** — `docs/openapi.yaml` (ADR-0012): new optional field(s)
  and refreshed `Payment.status`/`Payment.failure_code` descriptions; `pnpm lint:openapi`
  stays at zero errors.
- **Rate-limit interaction** — scenario flows stay inside the documented Phase 13 classes
  (§9, AC8); no accidental throttling and no bypass.
- **Tests** for all of the above (§11), including flipped documentation assertions.

Explicitly **not** in scope (§12): real money or card data, test-card numbers,
chargebacks/disputes, refund scenarios, mid-flight forcing on existing payments,
project-level default scenarios, forced-`429` throttling scenarios (Q1), new webhook event
types (D7), scenario exposure in the `Payment` response (D6), metrics/analytics, SDKs/CLI,
ROADMAP checkbox bookkeeping (Q2).

## 3. Context and current-state findings

**What exists today** (Phases 1–15 merged; branch state = `main`):

- **Simulation engine** (`payments/payment-simulation.ts`): `scheduledTransition()` is a
  pure function over `(status, createdAt, delays, outcome?)` with `outcome: 'succeeded' |
  'failed'`; the **caller never passes it** — `advance()` uses the default `'succeeded'`,
  so no public path can produce `failed`. The schedule is deterministic from `created_at`
  plus `PAYMENT_PENDING_DELAY_MS`/`PAYMENT_SETTLEMENT_DELAY_MS` (defaults 1000/2000).
- **Advancement drivers** (Phase 10 §5.3/D3): a queue-driven sweep applies due edges
  without any read; read-time catch-up is the backstop; both go through the same
  compare-and-set, so an edge fires exactly once.
- **`payments.failure_code`** exists (`varchar(50)`, nullable, app-validated, "null unless
  `status = failed`") but is **never written** — no trigger has ever existed.
- **Contract**: `PaymentCreate` = `environment`, `customer_id`, `amount`, `currency`,
  optional `description`. `Payment` exposes `failure_code` with a description that says the
  catalog "is defined by the sandbox controls of a later phase — always `null` in this
  phase". `Payment.status` says "The `failed` status is defined … with no public trigger in
  this phase — the sandbox controls of a later phase enable it."
- **Webhook delivery** (`webhook-delivery.service.ts`): one attempt = one HTTP request
  recorded on the row; a destination-policy denial short-circuits **without** performing or
  counting an attempt (terminal, fixed sanitized reason, `response_status: null`);
  classification of network/timeout/408/429/5xx → retry ladder (5 attempts default,
  env-driven), other 4xx/3xx → terminal failure.
- **Dashboard**: the payments view already has a capability-gated create form
  (customer, amount, description) for owner/admin, payment lifecycle polling, and delivery
  inspection in the webhooks view (attempts, next retry).
- **Docs**: `/docs/sandbox` (Phase 15 §5.12, D6) publishes an explicit "What is not
  simulated today" section — "No declines or failures", "No timeouts or slow paths", "No
  webhook failure scenarios", "No scenario triggers". `/docs/payments` states "no public
  trigger for failure is exposed in this version". `/docs/quickstart` repeats the
  default-success-only claim. `docs-guides.spec.tsx` asserts all of these absences
  (including `not.toMatch(/\bdeclin|\bfailure scenario/)` for the quickstart/index).

**Findings this phase must resolve (not silently inherit)**

| # | Finding | Resolution |
| --- | --- | --- |
| F1 | The engine already models a `failed` outcome but nothing persists a per-payment intent: the deterministic schedule means the outcome **must be stored on the payment row** (it is consumed minutes later by a sweep with no request context). | §7 — one nullable column + committed migration (ADR-0011). |
| F2 | `applyEdge()` writes only `status`; the audit entry and the event payload are built from the **pre-edge** row, where `failure_code` is `null`. If Phase 16 only adds a trigger, a `failed` payment would ship with `failure_code: null` in the API response, the webhook payload and the audit entry — violating Phase 7 §4.6 ("`failure_code` is stored when a payment fails"). | §4.7 — the failed edge must write `failure_code` **in the same CAS update**, and the event payload and audit entry must use the post-edge value. Tested by AC2/AC3. |
| F3 | Published docs and their tests assert the **absence** of every behavior this phase adds (F-batch: sandbox guide, payments guide, quickstart, `docs-guides.spec.tsx`). | §6.2/D10 — content and assertions flip in the same change (Phase 15 F1 precedent). |
| F4 | Phase 7 OQ-3 deferred both the `failure_code` **catalog** and the **trigger mechanism** to this phase; Phase 7 §15 assigns "add decline/timeout/failure simulation triggers and the `failure_code` catalog; extend §4.6 without breaking the legal transitions". | D1–D4. |
| F5 | Phase 10 §11 delegates "sandbox failure/timeout simulation for webhook delivery, including forcing a destination to fail on demand" to this phase; a policy-denial short-circuit already exists but counts **no** attempt (it stands for "no request was made"), which differs from the semantics a simulated *attempt* needs. | §5/D5 — simulated attempts count and advance the retry ladder; documented difference from the policy-denial path. |
| F6 | Phase 13 §11 excludes "sandbox-specific throttling scenarios such as deliberately forcing a `429`" because "Phase 16 owns simulation scenarios", and Phase 13 §16 requires scenarios not be throttled by accident. The roadmap does not list a throttling scenario among Phase 16's four bullets. | Q1 — surfaced as an explicit question, not silently dropped or silently added; answered 2026-10-07 (excluded). |
| F7 | Phase 7 D10 and Phase 10 §4.2 leave the `payment.processing` event question to Phase 16. | D7 — answered here and confirmed (a) 2026-10-07: keep the catalog unchanged. |
| F8 | A never-settling payment (D3 option (a)) keeps matching the sweep's due-filter (`status ∈ pending/processing`, `createdAt ≤ cutoff`) forever, occupying bounded batch slots on every pass — the class of global-scan pressure Phase 10 already flagged. | §16 — implementation consideration: make the sweep's filter scenario-aware. |
| F9 | ROADMAP.md checkbox bookkeeping is stale (Phases 4–12 unchecked though merged; Phase 13/15 checkbox claims made early). Same class as Phase 14 F10 and Phase 15 F11. | Q2 — reported, not fixed inside this phase's file scope (Phase 15 Q3 precedent); answered 2026-10-07 (separate `chore/*` change). |
| F10 | `Payment.status` and `Payment.failure_code` contract descriptions ("a later phase … always `null` in this phase") become false the moment a trigger exists. | §4.8 — in-place refinement (ADR-0012), same change. |
| F11 | There is still no `payments.e2e-spec.ts` (Phase 7 OQ-2). Phase 16's e2e obligations are the natural first content of a payments HTTP-level suite. | §11 — scenario e2e coverage lands in a payments e2e suite; the standalone OQ-2 question itself stays open (Phase 17 territory). |

## 4. API application — payment scenarios (`apps/api`, payments)

### 4.1 Module purpose and boundaries

The payments module owns scenario selection, the failure-code catalog, and the extended
simulation semantics. No new module, no new service, no microservice. The webhooks module
is touched only for §5. Cross-module behavior reuses existing seams
(`WEBHOOK_EVENT_PORT`, `AUDIT_LOG_PORT`, idempotency capability) unchanged.

### 4.2 Scenario selection (D1)

- `POST /projects/{project_id}/payments` accepts **new optional request fields** (additive,
  ADR-0005; no version bump). Shape (D1 confirmed (a) 2026-10-07):
  - `scenario` — closed enum: `succeed` (default) | `decline` | `timeout`. Absent ⇒
    `succeed`, i.e. **exactly today's behavior**.
  - `failure_code` — optional; a value from the §4.5 catalog; **only valid together with
    `scenario: "decline"`**; absent ⇒ the catalog default (`card_declined`). Explicit
    `null` is rejected (400), consistent with the existing boundary rules for optional
    fields.
- Scenario intent is **fixed at creation and immutable**: no update/patch endpoint for
  scenarios, no per-project or per-organization defaults (D1 (a) confirmed), no post-hoc
  forcing on existing payments (D2).
- Both auth modes behave identically for the new fields: session mode requires the
  existing `payments.create` capability; API-key mode pins the environment as today. No
  new capability, no new route, no new rate-limit class (§9/D8).
- Validation happens at the DTO boundary (closed enums — never free strings), before the
  idempotency claim, so an invalid scenario leaves the `Idempotency-Key` reusable
  (existing Phase 8 rule, re-tested for the new fields).

#### Error table (additions)

| Case | Status | Code |
| --- | --- | --- |
| Unknown `scenario` value; `failure_code` outside the catalog; `failure_code` with a non-`decline` scenario; explicit `null` for `scenario`/`failure_code` | 400 | `VALIDATION_ERROR` (field-level errors, house envelope) |

All other statuses/codes are exactly Phase 7's table (§4.10) — authorization, isolation
and rate-limit behavior are unchanged.

### 4.3 Domain rules (normative)

1. **The Phase 7 state machine is unchanged.** Only `pending → processing`,
   `processing → succeeded`, `processing → failed` exist; terminal states are absorbing;
   there are still **no user-initiated transitions** — a scenario *configures* the
   simulation; the simulation remains the only driver (Phase 7 §15 obligation: extend
   §4.6 "without breaking the legal transitions").
2. **Determinism and restart safety are preserved**: the outcome is a pure function of
   `(persisted scenario, created_at, configured delays)` — no in-memory scenario state, no
   transition-time columns, a restart cannot change or strand a payment's outcome.
3. **Default = today's behavior.** A payment created without the new fields, and every
   pre-existing payment row (`scenario` null), advances `pending → processing →
   succeeded`. Backwards compatibility is absolute (AGENTS.md; ADR-0005).
4. **Decline** (§4.5) fails on the **normal schedule** (the settlement edge) — no timing
   special case; the only difference from success is the edge chosen at settlement time.
5. **Timeout** (§4.6) never reaches a terminal edge.
6. **`failure_code` invariant (post-Phase 16 writes):** `status = failed` ⇒
   `failure_code` ∈ catalog; `status ≠ failed` ⇒ `failure_code IS NULL`. No pre-existing
   `failed` rows exist (no trigger has ever fired), so no backfill is required.
7. **Idempotency (Phase 8, unchanged mechanics):** scenario fields ride the
   `payments.create` operation scope. A replay returns the stored `201` body verbatim
   (including whatever scenario outcome it recorded), creates no second payment, and emits
   no second `payment.created` and no second audit entry. Same key + different body keeps
   existing Phase 8 replay semantics.
8. **Events (Phase 7 catalog):** `payment.created` at creation; `payment.succeeded` /
   `payment.failed` at the terminal edge — a declined payment produces `payment.failed`
   whose `data` payload carries the **non-null** `failure_code`. A timed-out payment
   produces `payment.created` and nothing else, ever (realistic: no terminal result).
9. **Audit (Phase 12):** the `payment.failed` entry records the catalog `failure_code`
   (the Phase 12 capture already has the field); attribution rules unchanged (original
   creator, `request_id` null for sweep/read edges). No new audit action, no scenario
   value added to the audit payload (§12).
10. **Rate limiting:** scenario-flagged creates consume the same classes as any create
    (§9/D8) — no bypass, no exemption.

### 4.4 Success simulation (roadmap checkbox — verification only)

No behavior change. Phase 7's default-success simulation remains the default path and
keeps its guarantees (schedule from `created_at`, CAS-guarded, sweep + read catch-up,
env-configurable delays). AC1 is the regression gate for this checkbox.

### 4.5 Decline simulation (D3, D4)

- `scenario: "decline"` ⇒ at the settlement edge the payment transitions
  `processing → failed` instead of `processing → succeeded`, through the same CAS path,
  with `failure_code` written in the same update (F2).
- The `failure_code` is the requested catalog value, or the catalog default when omitted.
- Exactly one `payment.failed` event fires (CAS winner), persisted in the same
  transaction as the edge (Phase 10 D2 semantics — unchanged), and exactly one
  `payment.failed` audit entry joins that transaction.
- The failed edge's `updated_at`, absorbing-terminal rules, and "no transition out of
  `failed`" all hold identically to the success edge.

**Failure-code catalog (D4 — confirmed 2026-10-07)** — discharged from Phase 7 OQ-3 (its
stated examples):

| Code | Meaning (developer-facing) |
| --- | --- |
| `card_declined` | The simulated authorization was declined (catalog default) |
| `insufficient_funds` | The simulated funding source had insufficient funds |
| `processing_timeout` | The simulated authorization attempt timed out and the payment failed |

- Stored in the existing `failure_code` column (`varchar(50)` — all values fit);
  app-validated like every other enum column (Phase 4 D10 pattern).
- The catalog is a **single shared constant** in the API, surfaced to the contract and
  (via §6.2's consistency mechanism) to the docs, so the three surfaces cannot drift.
- Exact values are D4; extending the catalog later is an additive contract change.

### 4.6 Timeout simulation (D3)

Semantics (D3 confirmed (a) 2026-10-07):

- `scenario: "timeout"` ⇒ the payment advances `pending → processing` on the normal
  pending delay, then **never settles**: no settlement edge ever becomes due, so the
  payment remains `processing` indefinitely.
- Consequences that must hold and be tested: survives restarts (derived, not stored as a
  timer); the sweep and read catch-up never advance it; no terminal event is ever
  emitted; `retrieve`/`list` keep returning `processing`; refunds stay unavailable (Phase 9
  refundability rule untouched); `failure_code` stays `null` (not failed).
- Documentation must state plainly that a timed-out payment never completes and that
  integrations should treat prolonged non-terminal states as "not yet resolved".

Alternative meanings (terminal failure with `processing_timeout`, or both) were recorded in
D3 — the ambiguity Phase 7/15 left open — and the product authority confirmed option (a)
on 2026-10-07; `processing_timeout` remains in the catalog as a *decline* code (D4).

### 4.7 Atomicity of the failed edge (F2 — correctness requirement)

The failed edge must be written as one transaction that contains, together:

1. the CAS `status = failed` **and** `failure_code = <catalog value>`;
2. the `payment.failed` event row whose payload already reflects the new
   `failure_code` and `status`;
3. the `payment.failed` audit entry carrying that same `failure_code`.

A rollback leaves none of the three behind (existing `applyEdge` contract). A concurrent
sweep/read contention still yields exactly one writer and one emission. The success edge
keeps writing `failure_code = null` (it is already null).

### 4.8 Contract requirements (`docs/openapi.yaml`, ADR-0012 in place)

- `PaymentCreate`: document the optional scenario field(s), their catalog, the default,
  the validity rule (`failure_code` ⇒ `decline`), and a per-field example.
- `Payment.status`: replace the "no public trigger in this phase — the sandbox controls of
  a later phase enable it" wording with the effective behavior (scenario-driven; default
  remains success; terminal states absorbing).
- `Payment.failure_code`: replace "always `null` in this phase" with the catalog, the
  non-null-when-failed invariant, and `null` for pending/processing/succeeded.
- No path, status-code, required-field, or schema-name change; no new operation under the
  confirmed decisions (D1 option (a), D5 option (a)); `pnpm lint:openapi` at zero
  errors.
- If D1 or D5 alternatives introduce **new operations**, they additionally require:
  an operation id, a Phase 13 rate-limit class declaration (every contracted route must
  have one), an audit review (Phase 12 allowlist), and the §11 test matrix — recorded here
  so an alternative choice cannot skip them.

## 5. Webhook delivery failure simulation (D5)

### 5.1 Required behavior

- A developer must be able to register a webhook endpoint whose deliveries **fail
  deterministically without any receiver running**, exercising the full Phase 10 machinery:
  attempt bookkeeping, retry classification, backoff ladder, eventual `failed`, dashboard
  visibility, and replay.
- Mechanism (D5 confirmed (a) 2026-10-07): a **documented marker in the registered URL** —
  exact path-segment match on `/sandbox/<action>` where `<action>` is a fixed token set:
  - `fail` — simulated network error (retryable class),
  - `timeout` — simulated request timeout (retryable class),
  - `reject` — simulated non-retryable rejection (terminal `4xx` class, fails immediately).

  (The exact marker shape and the accepted token subset are confirmed inside D5:
  `/sandbox/fail|timeout|reject`.)

### 5.2 Rules

1. **No outbound HTTP request is made** for a marked delivery — the platform simulates
   the outcome instead of calling out (this is the point: no broken receiver required).
2. A simulated failure **counts as an attempt** (`attempts` increments, ladder advances,
   `next_attempt_at` scheduled by the unchanged env-driven backoff), because it stands in
   for a request. This differs deliberately from the destination-policy denial path, which
   counts no attempt (F5) — both behaviors must coexist and be tested.
3. The recorded outcome is a **fixed, sanitized summary** (e.g. "simulated network error
   (sandbox)") with `response_status = null`; no response bodies, no secrets — Phase 10
   §5.4 storage rules hold unchanged.
4. Classification: `fail`/`timeout` are retryable until `WEBHOOK_MAX_ATTEMPTS` is
   exhausted ⇒ delivery `failed`; `reject` is terminal on attempt 1 ⇒ `failed`.
5. **Applies to every delivery to that endpoint**, including replays (Phase 13 §16
   "replay-failure scenarios") and events of all catalog types; unmarked endpoints are
   completely unaffected (the real-HTTP path keeps its existing integration tests).
6. **Precedence:** URL validation, then destination policy (existing, terminal), then the
   simulation marker — evaluated per attempt, like the policy check.
7. Detection is an **exact segment match**, never a substring match: a URL such as
   `https://example.com/failure-handler` or `.../sandbox/webhook` must never be simulated.
8. The marker never bypasses endpoint `enabled` gating, subscription filtering,
   retention, or rate limits — it only replaces the HTTP attempt.

### 5.3 Contract and documentation touchpoints

- Endpoint create/update descriptions note that marked URLs produce simulated failures
  (in-place refinement; the URL schema itself is unchanged).
- `/docs/webhooks` and `/docs/sandbox` document the markers, the classification each one
  produces, and the attempt/ladder behavior; the Phase 15 consistency mechanism (D8)
  guards any fact shared with the contract.

## 6. Web application — `apps/web`

### 6.1 Payments view — scenario hook (Phase 14 handover, D9)

- The existing create form gains **scenario selection** (D1): default = current behavior;
  choosing `decline` optionally exposes a `failure_code` select populated from the catalog;
  `timeout` needs no extra input.
- **Presentation gating only:** the control appears exactly where the create form appears
  (owner/admin per the capability matrix). Viewer/member never see it; the API remains the
  enforcement point (an API call without the capability is 403 regardless of the field).
- A **failed** payment row shows its `failure_code` (existing API field — presentation
  only, no contract addition).
- No new routes, no new pages, no changes to polling/pagination/environment scoping
  behavior; a timed-out payment simply keeps displaying `processing`.

### 6.2 Documentation extension (Phase 15 D6 handover, D10)

- `/docs/sandbox` replaces the "What is not simulated today" section with the scenario
  catalog: success (default), decline (+ failure-code table), timeout (never settles),
  webhook failure markers — each with a minimal correct example; the "no real money/no
  card data" callout and "both environments simulated" content stay.
- `/docs/payments`: the "no public trigger for failure is exposed in this version"
  claim is replaced by the scenario field documentation (request example included).
- `/docs/quickstart`: its default-success-only statement is corrected.
- `/docs/webhooks`: receives §5.3 content.
- Every assertion that encodes the old absences flips in the same change:
  `docs-guides.spec.tsx` ("No declines or failures", "No scenario triggers", "no public
  trigger for failure is exposed", the quickstart/index `not.toMatch(/\bdeclin|…/)`
  guard), plus any `docs-pages`/`docs-examples` expectations touched.
- **Consistency (Phase 15 D8):** the failure-code catalog and the marker tokens are
  published facts shared by contract and guides — they enter `lib/docs/facts.ts` and the
  `docs-consistency.spec.ts` check set, so a future contract edit cannot silently diverge
  from the guide.
- Examples use placeholders only (`sk_test_…`, obvious IDs); no working credentials
  (Phase 15 §11.4).
- The docs area stays static, public, API-free, CSP-clean (Phase 14/15 rules unchanged).

## 7. Data requirements

| Requirement | Statement |
| --- | --- |
| Scenario persistence | One new **nullable** column on `payments`: `simulation_scenario varchar(50)` (name fixed with D1 (a)), app-validated closed enum, `null` ⇒ default success. Nullable-not-defaulted so existing rows need no backfill and "absent" and "succeed" are the same state. |
| Migration | Committed with the phase (ADR-0011 workflow); additive column, no rewrite, no lock concern at this scale; Prisma schema + migration in the same change. |
| `failure_code` | Existing column, unchanged shape; **starts being written** per §4.5/§4.7. |
| Rejected storage alternatives | Separate scenario table (1:1 row — overkill); encoding intent in `description` (corrupts user data); reusing `failure_code` pre-failure (violates the null-unless-failed invariant); Redis/in-memory intent (not restart-safe). |
| Webhook simulation | **No schema change** under D5 option (a) — the marker lives in the already-stored `url`. |
| Unchanged tables | `webhook_events`, `webhook_deliveries`, `webhook_endpoints`, idempotency, request logs, audit logs — no columns, no indexes, no retention changes. |
| Configuration | **No new environment variables** under the confirmed options (markers are fixed documented tokens; catalog is a code constant; delays/retry ladders are already env-driven). An implementation that makes markers or limits configurable must declare its env names explicitly and escalate as a spec deviation. |
| New domain entity | None — no `docs/domain-model.md` §2/§5 row is added; the Payment row gains an attribute of an existing entity. |

## 8. Security requirements

1. **Authorization:** the scenario fields are processed only inside the existing
   `payments.create` path (session capability or API key); no new capability, no
   privilege escalation, no path that skips the project guard. Dashboard gating is
   presentation only (§6.1).
2. **Tenant isolation:** scenario data lives on the payment row and inherits its
   project/environment scoping; markers affect only the endpoint the tenant itself
   registered; cross-project/cross-environment behavior (404 non-disclosure) is unchanged
   and re-tested with the new fields present.
3. **Input validation / injection:** scenario and `failure_code` are closed enums checked
   at the boundary — never free strings, never interpolated into SQL (Prisma), never
   rendered as HTML (React escaping). Marker detection is exact-segment matching, not
   regex-on-user-input in a way that could misfire (§5.2 rule 7).
4. **Idempotency integrity:** validation precedes the idempotency claim; a scenario
   cannot double-create, poison a key, or diverge a replayed body from the stored one.
5. **Rate limiting:** no bypass and no new failure-injection into the limiter itself
   (Q1 answered 2026-10-07: forced-`429` scenarios are excluded); scenario creates count
   against the documented `write` class (AC8); if an
   alternative adds operations, their classes are declared per Phase 13 §4.2.
6. **Webhook simulation safety:** a marked attempt performs **no outbound request**, so
   the feature cannot be used to probe or amplify traffic; unmarked destinations keep the
   Phase 10/ADR-0019 controls (no redirects, bounded timeouts, sanitized logs). Simulated
   records store only fixed summary strings — no bodies, no secrets. No signature is ever
   emitted for bytes that were not sent (signing remains "HMAC over exactly the bytes
   sent").
7. **Secret handling:** none added; scenario configuration contains no secrets; webhook
   secret generation/display/encryption untouched.
8. **Secure logging:** scenario and failure-code values in logs are whitelisted enum
   values; no new PII (no IPs/emails beyond existing structures); no passwords, API keys
   or webhook secrets logged (AGENTS.md).
9. **Contract/auth parity:** additive optional fields change no security semantics; the
   docs must not document authorization the API does not enforce (Phase 15 rule).
10. **Review:** the contract addition plus the outbound delivery-path change are flagged
    for the Phase 18 security review; this phase must introduce no known critical issue.

## 9. Rate-limiting interaction (Phase 13 obligation)

- Under the confirmed decisions there are **no new routes**, so no new classes are
  required; every touched route keeps its existing declared class (`write` for
  `payments.create`).
- Requirement (Phase 13 §16): scenario flows must not be throttled *by accident* — i.e.
  nothing about a scenario request may consume budget twice, nor hit a class the
  developer was not documented to hit; and **no scenario request may bypass the
  limiter**. Both directions are tested (AC8) and stated in `/docs/rate-limits` or
  `/docs/sandbox` in one sentence (whichever the D10 consistency set covers).
- The Phase 13 numbers stay as confirmed (D6 there); raising them for scenario loops is
  an environment change, not a code change.

## 10. Acceptance criteria

Each roadmap checkbox maps to at least one AC; all must hold on the merged branch.

1. **AC1 — success simulation intact (roadmap: success simulation).** A payment created
   without scenario fields advances `pending → processing → succeeded` on schedule,
   emits `payment.succeeded`, writes the audit entry, and never reaches `failed` —
   identical to pre-phase behavior (existing tests keep passing).
2. **AC2 — decline produces a failed payment with a code (roadmap: decline).** Creating
   with `scenario: "decline"` (default code) yields, after the normal schedule: status
   `failed`, `failure_code = card_declined` in the API response, in the
   `payment.failed` webhook payload, and in the `payment.failed` audit entry — all three
   committed together (rollback test: none appears without the others).
3. **AC3 — catalog selection.** Declining with each catalog code (D4) stores exactly that
   code; the invariant "failed ⇔ code ∈ catalog, non-failed ⇒ null" holds in every test.
4. **AC4 — boundary validation.** Unknown `scenario`; `failure_code` outside the catalog;
   `failure_code` with `succeed`/`timeout`; explicit `null` — each returns 400
   `VALIDATION_ERROR` with field-level detail, creates no payment, no event, no audit
   entry, and leaves the `Idempotency-Key` reusable.
5. **AC5 — timeout never settles (roadmap: timeout).** A `scenario: "timeout"` payment
   reaches `processing`, then across sweep passes, reads, and a service restart remains
   `processing` forever with `failure_code = null`, and emits no terminal event.
6. **AC6 — idempotency.** Same key + same body replays the stored `201` verbatim (scenario
   included) with no second payment/event/audit row; the concurrency behavior of Phase 8
   is unchanged for scenario creates.
7. **AC7 — webhook failure simulation (roadmap: webhook failure).** An endpoint whose URL
   carries a documented marker receives **zero** HTTP requests (verified by an
   instrumented receiver/test double), while its deliveries advance `attempts` through the
   unchanged ladder to terminal `failed` with the fixed sanitized reason and
   `response_status: null`; `reject` fails on the first attempt; replay to a marked
   endpoint behaves identically; an unmarked endpoint still receives real signed
   deliveries (existing delivery tests pass untouched).
8. **AC8 — rate limiting.** Scenario-flagged creates consume the `write` class exactly
   once per request (headers observable), and no scenario path returns 429 differently
   from an identical unflagged request; documented in the guides.
9. **AC9 — contract.** `pnpm lint:openapi` at zero errors; `PaymentCreate` documents the
   new fields; `Payment.status`/`Payment.failure_code` descriptions reflect effective
   behavior (F10 gone); no version bump, no breaking change (ADR-0005).
10. **AC10 — dashboard.** Owner/admin can select a scenario (and decline code) in the
    existing create form and sees `failure_code` on failed payments; member/viewer see no
    control and get 403 from the API if they call it directly; environment scoping,
    polling, and pagination behavior unchanged.
11. **AC11 — documentation truthful.** `/docs/sandbox`, `/docs/payments`,
    `/docs/quickstart`, and `/docs/webhooks` describe the implemented scenarios; no page
    anywhere claims the absence of failure triggers; the flipped
    `docs-guides`/`docs-pages` assertions pass; the catalog and marker tokens are guarded
    by `docs-consistency` checks against the contract; no links to nonexistent features;
    examples remain placeholder-only.
12. **AC12 — lifecycle invariants.** The state machine admits no new edge
    (no `pending → failed`, no leaving terminal states); exactly one `payment.failed`
    event and one audit entry per declined payment under sweep-vs-read contention; no
    `payment.processing` event exists (D7).
13. **AC13 — logs.** Request logs and audit logs for scenario flows follow existing
    semantics (no new actions, no scenario in audit payloads, no secrets, sanitized
    reasons only).
14. **AC14 — required checks.** `pnpm lint`, `pnpm lint:openapi`, `pnpm typecheck`,
    `pnpm test`, `pnpm test:e2e`, `pnpm build` pass; CI green.

## 11. Testing requirements

### 11.1 API unit (`apps/api`)

- Simulation engine: `scheduledTransition` (or its scenario-aware equivalent) for every
  scenario × state × elapsed-time combination — decline edge at settlement, timeout never
  settles, default success, terminal absorbing, invalid/unpersisted scenario treated as
  default.
- Catalog: membership, default code, column-length fit, invariant helpers.
- DTO boundary: every AC4 case plus whitespace/unknown-key noise.
- Webhook marker detection: exact-segment positive/negative table (`/sandbox/fail` yes;
  `/failure-handler`, `/sandbox/webhook`, query-string lookalikes no); classification of
  each action into retryable/terminal; policy-vs-marker precedence.
- Existing suites (`payments.service.spec.ts`, `payment-simulation.spec.ts`,
  `idempotency`, `audit-logging`, `webhook-delivery`, route-rate-limit-class) extended —
  the "no public failure trigger" expectations invert rather than disappear.

### 11.2 Integration (real PostgreSQL + real Redis + real worker)

- Migration: column exists, nullable, existing rows read as default success.
- Decline end-to-end through the **sweep driver** (no reads): create → sweep →
  `failed` + code + event row + delivery rows + audit entry, all consistent (F2).
- Read-catch-up and sweep contending on the same declined payment ⇒ exactly one event,
  one audit entry, one code write.
- Rollback of the edge transaction ⇒ none of {status, code, event, audit} persists; the
  next pass retries cleanly.
- Timeout: multiple sweep passes + a fresh service instance ⇒ still `processing`, zero
  terminal events.
- Idempotent replay of a scenario create (AC6).
- Webhook markers: no outbound call (receiver spy), attempt/ladder progression with
  near-zero env-driven backoff, terminal states for both classes, replay parity,
  unmarked-endpoint regression (signed delivery verified end-to-end).
- Rate-limit observation for scenario creates (AC8).

### 11.3 E2E (API)

- Scenario fields under **both auth modes**: happy paths for all three scenarios; every
  AC4 error status; viewer/member 403; cross-project/cross-environment IDs still 404 with
  the new fields present; API-key environment mismatch still 422.
- These land in a payments HTTP-level suite (F11) so Phase 16 does not deepen the
  Phase 7 OQ-2 gap.

### 11.4 Web (`apps/web`)

- Create-form scenario control: appears for owner/admin, absent for viewer/member,
  default selection = today's behavior, decline-code sub-control only for `decline`,
  values sent match the contract, API 400s surface as form errors.
- Failed-row `failure_code` rendering (and absent when null).
- Docs: flipped `docs-guides` assertions (sandbox, payments, quickstart, index guard),
  new consistency facts vs contract, examples contain only placeholders.

### 11.5 Shared

- Repository checks (AC14) plus CI; no real credentials anywhere; tests deterministic
  (env-driven near-zero delays — no wall-clock sleeps beyond existing patterns); no
  secrets in fixtures or logs.

## 12. Out of scope

- Real payment processing, real card data, **test-card numbers** (BrinnPay collects no
  card data — the scenario model is field-based by design), chargebacks, disputes,
  reversals, partial capture, multi-currency (ADR-0003).
- **Refund scenarios** — refunds remain synchronous successes (Phase 9); the roadmap does
  not assign refund simulation to this phase.
- **Mid-flight forcing** — no force-fail/force-succeed action on existing payments, no
  scenario mutation endpoint (D2 recommendation; would also reopen Phase 7's
  "simulation is the only driver" rule).
- **Project/organization-level default scenarios** (D1 (a) confirmed — request-time only).
- **Forced-`429` throttling scenarios** (Q1) and any change to limiter internals or
  confirmed Phase 13 numbers.
- **New webhook event types or payloads** — in particular no `payment.processing` event
  (D7), no event-ordering/exactly-once/batching guarantees (Phase 10 §11).
- Scenario exposure in the `Payment` response (D6 option (b)), scenario values in audit
  payloads or request logs beyond current fields.
- Metrics/analytics/observability UI (Phase 20), load testing (Phase 19), security
  review sign-off (Phase 18), browser e2e tooling (Phase 17), README/CONTRIBUTING
  (Phase 25), release QA (Phase 26).
- SDKs, CLI, docs search, new shared packages, i18n, dashboard design changes beyond
  §6.1.
- ROADMAP.md checkbox bookkeeping (Q2).

## 13. Decisions (D1–D10 — confirmed 2026-10-07)

Each decision listed options and a recommendation. **The product authority confirmed all
ten decisions on 2026-10-07, choosing the recommended option (a) in every case. The
choices below are binding for implementation; D1/D2/D6 are recorded as ADR-0031 and D5 as
ADR-0032 (§15).**

| # | Decision | Options → recommendation | Status |
| --- | --- | --- | --- |
| D1 | Scenario selection mechanism (Phase 7 OQ-3) | **(a) Optional fields on `payments.create`** (`scenario` enum + optional `failure_code`) — request-time, per-payment, testable straight from an integration, additive (ADR-0005), no new routes/classes, persists naturally for the deterministic schedule, and the dashboard hook just fills the same field. (b) Project-level default scenario setting — invisible to API-only users, needs new storage + endpoints + UI surface, worse fit for "test this one payment". (c) Magic triggers (special amounts/descriptions) — hidden behavior, brittle, hard to document honestly. (d) Dashboard-only control — excludes the primary audience (API integrators). Naming/shape confirmable within (a). | Confirmed (a) 2026-10-07 |
| D2 | Timing of triggers | **(a) Create-time only** — the scenario is fixed when the payment is created; no mid-flight forcing. Keeps "the simulation is the only driver" (Phase 7 §4.3/§4.6) intact and adds no operations. (b) Force-fail endpoint on existing payments — a user-initiated transition: new operation + rate class + audit questions, and it re-reads Phase 7's rule as violated; rejected. | Confirmed (a) 2026-10-07 |
| D3 | Timeout semantics (ambiguous — Phase 7/15 deferred it) | **(a) Timeout = never settles:** reaches `processing`, no terminal edge ever; and `processing_timeout` still exists as a *decline* failure code (D4), so both real-world cases (gateway hangs vs gateway fails) are covered distinctly. (b) Timeout = terminal failure with `processing_timeout` only — collapses the roadmap's separate bullet into a decline variant; nothing exercises "never completes". (c) Timeout = never settles, and omit `processing_timeout` from the catalog. | Confirmed (a) 2026-10-07 |
| D4 | `failure_code` catalog | **`card_declined` (default), `insufficient_funds`, `processing_timeout`** — exactly the values Phase 7 OQ-3 named as examples; minimal but enough for integrations that branch on codes. (b) Single code (`declined`) — too thin to exercise code-driven handling. (c) A larger card-style catalog — invented beyond any requirement. Extending later is additive. | Confirmed (a) 2026-10-07 |
| D5 | Webhook failure mechanism (Phase 10 §11) | **(a) Documented URL marker** — exact path segments `/sandbox/<action>` with `fail` \| `timeout` \| `reject`; no schema change, no new endpoints, per-endpoint opt-in (the developer registers the marker), deterministic, works for replays, and reuses the existing delivery bookkeeping (with the attempt-counting difference of §5.2). (b) Per-endpoint `simulation` setting — explicit, but expands the endpoint contract, its UI, and its schema for the same effect. (c) Control endpoint ("fail next delivery") — a new operation, stateful, race-prone with the async worker. Marker shape/token subset confirmable within (a). | Confirmed (a) 2026-10-07 |
| D6 | Scenario visibility on the `Payment` response | **(a) No new response field** — smallest contract change; terminal outcomes are already visible via `status`/`failure_code`, and the creator knows what it requested. (b) Expose e.g. `scenario` — helps third-party viewers diagnose a stuck payment, at the cost of a new public field, mapper, and docs surface. | Confirmed (a) 2026-10-07 |
| D7 | `payment.processing` event (Phase 7 D10 / Phase 10 §4.2 deferred question) | **(a) Keep the catalog unchanged** — the convention is `<resource>.<past-tense-verb>`; `payment.created` + terminal events already bracket the lifecycle; a stuck payment emitting nothing further is realistic and is exactly what D3(a) simulates. (b) Add `payment.processing` — breaks the naming convention, adds noise for every payment, only to serve demos. | Confirmed (a) 2026-10-07 |
| D8 | Rate-limit treatment of scenarios (Phase 13 §16) | **(a) No new classes, no limit changes** — scenario requests ride existing classes (`write`), counted exactly once, documented and tested; Phase 13's confirmed numbers stand. (b) Raise `write` — a deployment knob, not a code change; not justified now. (c) Dedicated scenario class — new class + config + docs for no demonstrated need. | Confirmed (a) 2026-10-07 |
| D9 | Dashboard surface (Phase 14 handover) | **(a) Extend the existing create form** with scenario selection + show `failure_code` on failed rows. (b) A dedicated "Simulate" panel/page — new surface, more navigation, not required by the handover wording ("a UI hook in the payments view"). | Confirmed (a) 2026-10-07 |
| D10 | Documentation scope | **(a) Sandbox + payments + quickstart + webhooks guides, all flipped tests, and consistency facts** — required so no published surface contradicts the implementation (Phase 15 accuracy rule). (b) Sandbox guide only — leaves the payments guide's "no public trigger" claim false; rejected. | Confirmed (a) 2026-10-07 |

## 14. Open questions — answered 2026-10-07

1. **Q1 — Forced-`429` throttling scenarios. Answered: excluded.** Phase 13 §11 excludes
   them because "Phase 16 owns simulation scenarios", but the roadmap's four bullets do not
   list them. They are **out of scope for Phase 16** and recorded as a deferred idea
   (§12): a developer reaches `429` naturally by looping requests, and limits are
   env-configurable. Commissioning one later would need its own ACs, a limiter-adjacent
   surface, and a Phase 13 class review.
2. **Q2 — ROADMAP.md checkbox bookkeeping. Answered: separate `chore/*` change.** Phases
   4–12 are implemented but unchecked, and Phase 13/15 claims were made early (F9; the
   same class Phase 15 Q3 answered as "report, not fix"). The drift is reported in the
   Phase 16 hand-off notes; ROADMAP.md bookkeeping is fixed in a **separate `chore/*`
   change outside this phase's scope** — no ROADMAP.md edit accompanies this phase.

## 15. Architectural decisions recorded

Recorded as ADRs (following the existing numbering):

- **ADR-0031 — Scenario model and persistence** (D1, D2, D6): create-time immutable
  scenario on the payment row, nullable column ⇒ default success, catalog as a single
  shared constant, atomic failed-edge write (F2 rationale), rejected alternatives from
  D1/D2/D6.
- **ADR-0032 — Webhook destination simulation** (D5): URL-marker mechanism,
  attempt-counting semantics (and why it differs from destination-policy denial),
  precedence order, rejected alternatives from D5.

## 16. Implementation considerations (not requirements)

- Keep `scheduledTransition` **pure**: pass the persisted scenario in as data (like the
  current `outcome` parameter) rather than letting the engine touch the DB; the caller
  (`advance`) supplies it from the row it already holds.
- The failed edge's `updateMany` data becomes `{ status, failureCode, updatedAt }`;
  build the event payload and audit capture from the **post-edge** values (F2). Watch the
  existing audit line that reads `current.failureCode` — it is the pre-edge value today.
- Sweep due-filter (F8): a never-settling payment matches `createdAt ≤ cutoff` forever.
  Make the filter scenario-aware (exclude timeout-scenario rows from the settlement scan)
  or bound the pressure deliberately; read-time catch-up may keep loading non-terminal
  rows since `advance()` simply computes no edge (no write).
- DTO: extend `PaymentCreateDto` with the closed enums; validation order already runs
  pipes before the idempotency claim — keep it that way.
- Contract edits are in-place (ADR-0012); update `Payment.status`/`failure_code`
  descriptions in the same PR as the trigger, never before it merges.
- Web client (`lib/brinnpay/client.ts`): extend the `PaymentCreate` payload type and keep
  `Payment.failure_code` (`string | null`) as-is; the dashboard form mirrors the DTO's
  validity rule (`failure_code` only with `decline`) for a good UX — the API still
  enforces.
- Webhook marker check: implement as a classification step beside (not inside) the
  policy-denial short-circuit so the two attempt-counting semantics stay legible;
  fixed reason strings are constants, never formatted from the URL.
- Docs facts: add the catalog and marker tokens to `lib/docs/facts.ts` and assert them
  against `docs/openapi.yaml` in `docs-consistency.spec.ts` (mirror the existing
  `RATE_LIMIT_CLASSES` pattern).
- Tests should reuse the existing near-zero delay overrides
  (`PAYMENT_*_DELAY_MS`, webhook retry env values); no new sleep-based helpers.
- No new environment variables under the confirmed options — if an implementation finds
  itself adding one, treat it as a spec deviation and escalate.

## 17. Dependencies and handovers discharged

**Inputs:** Phases 1, 2, 7 (engine, column, catalog, capability matrix), 8 (idempotency),
9 (refundability rule), 10 (events, delivery, retry, replay, sweep), 12 (audit capture
fields), 13 (classes, obligations), 14 (payments view, create form, security headers),
15 (guides, facts mechanism, D6 reservation); ADR-0001…ADR-0030.

**Discharged by this phase:**

- Phase 7 §15: "add decline/timeout/failure simulation triggers and the `failure_code`
  catalog; extend §4.6 without breaking the legal transitions" — state machine edges
  unchanged (§4.3 rule 1).
- Phase 7 OQ-3: catalog + trigger mechanism decided (D4, D1).
- Phase 10 §11: webhook failure/timeout simulation delivered (§5).
- Phase 7 D10 / Phase 10 §4.2: `payment.processing` question answered (D7).
- Phase 13 §16: scenarios stay inside documented limits, not throttled by accident (§9).
- Phase 14 §6.4 handover: "sandbox-scenario triggers gain a UI hook in the payments view"
  (§6.1).
- Phase 15 D6: "Phase 16 extends the guide" (§6.2).

**Blocks:** Phase 17 (scenario flows + updated docs join the e2e target set), Phase 18
(review of the contract addition and the outbound delivery change), Phase 25 (sandbox
content reuse), Phase 26 (verify sandbox scenarios before v0.1.0).

## 18. Definition of done

The phase is complete only when:

1. D1–D10 are confirmed and Q1–Q2 answered, and the Status row records it (done
   2026-10-07 — Status is Approved).
2. All four roadmap checkboxes are satisfied and traced to §10's acceptance criteria
   (success = AC1; decline = AC2–AC4; timeout = AC5; webhook failure = AC7), with AC6,
   AC8–AC14 holding as cross-cutting gates.
3. Phase 7's lifecycle, isolation, idempotency and money rules are demonstrably unchanged
   (existing suites pass; AC12 extends them).
4. The contract is lint-clean, in-place refined, and no surface still claims these
   features do not exist (AC9, AC11).
5. §11 test suites pass (unit, integration with real PostgreSQL/Redis, API e2e, web,
   docs-consistency) and the required checks pass: `pnpm lint`, `pnpm lint:openapi`,
   `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` (AC14).
6. §8 security requirements are verified, the migration is committed per ADR-0011, and no
   known critical security issue remains.
7. The §15 ADRs are written and merged alongside the implementation (written 2026-10-07:
   ADR-0031, ADR-0032).
