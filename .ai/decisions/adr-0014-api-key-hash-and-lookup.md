# ADR-0014: API Key Hashing and Lookup Scheme

- **Status:** Accepted
- **Date:** 2026-09-23
- **Phase:** 5
- **Scope:** API key plaintext format, hashing, storage, lookup, and rotation (finalizes the Phase 1 binding strategy of ADR-0006).

## Context

ADR-0006 fixed the prefixed, environment-scoped API key format (`sk_test_...` / `sk_live_...`), the display-once rule, and the hashed-at-rest storage requirement. It deferred the definitive scheme — length, charset, hash algorithm, and lookup strategy — to Phase 5. The Phase 5 implementation must choose concrete values and reason about the threat model:

- keys are credentials enabling API access scoped to one project + environment;
- the plaintext **must** be recoverable only at creation (rotation is the only recovery path);
- a database compromise must not enable forging keys or deriving plaintexts;
- lookup happens on **every** Programmatic gateway request, so `hash → key` resolution must be cheap (no bcrypt/argon2-style cost on the hot path);
- events/timeseries, payment objects, and audit entries reference keys by id, never by plaintext (D5/D7).

## Decision

**Plaintext scheme (finalizes ADR-0006):**

```text
sk_test_<43 lowercase,no-padding base64url chars>   # 32 random bytes
sk_live_<43 ...>
```

- Exactly **32 bytes** (`crypto.randomBytes(32)`, CSPRNG) are drawn per key, base64url-encoded **without padding** → 43 characters (128 random bits of security; the risk of two keys colliding is negligible).
- The environment prefix is part of the key: `sk_test_` / `sk_live_`; the prefix is **rejected** as a lookup input and stripped before hashing.
- `key` in storage is **never** the plaintext; the plaintext exists only in the create response.

**Hashing and uniqueness:**

- The suffix (plaintext after the prefix) is hashed with **SHA-256** in a single pass; the digest is stored hex-encoded (64 chars).
- `key_hash` is **unique** (`UNIQUE` index) and scoped per project and environment via the row's `project_id` + `environment` columns.
- The API key id (`id`, UUID) is the stable reference used by the dashboard, webhooks, audit, and future consumers.

**Lookup strategy (Programmatic API key authentication, consumed in Phase 6):**

- Extract the `Authorization: Bearer sk_...` credential; require the recognized prefix (`sk_test_` / `sk_live_`), reject anything else with `UNAUTHENTICATED` (no existence/scheme disclosure).
- Hash the suffix, then `SELECT` the key row by `key_hash` (+ environment); a miss resolves to the same 401.
- Authentication is a single indexed equality lookup — no iteration over stored hashes and no comparators over stored material.

**Revocation and rotation:**

- Revoking sets `revoked_at` in place; authenticated lookup rejects revoked keys. Revoked rows remain listed (metadata only) so operators can see key history.
- Rotation (D1) creates a replacement then revokes the old key; multiple active keys per (project, environment) are permitted, so a rotation gap never occurs.

## Consequences

- **No slow KDF** (bcrypt/scrypt/argon2): the 256-bit key space does not require stretching. Hash-checking stays on the request hot path at negligible cost (single SHA-256 pass over 43 bytes).
- A database compromise exposes only key hashes; with 32 random bytes per key, offline brute force is infeasible and no key-prefix structure leaks usable material.
- Uniqueness of `key_hash` prevents two keys from ever sharing a hash, keeping the lookup deterministic.
- Prefix separation (`sk_test_` vs `sk_live_`) keeps the TEST/LIVE guarantee from ADR-0006: credentials carry their environment and cannot be replayed against the wrong environment gate.
- Lookup by hash means the gateway never needs the plaintext from storage — consistent with the "displayed only once" rule.