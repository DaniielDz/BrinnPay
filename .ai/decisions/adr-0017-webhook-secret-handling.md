# ADR-0017: Webhook Signing Secret Generation, Storage, and Display

- **Status:** Accepted
- **Date:** 2026-09-28
- **Phase:** 10
- **Scope:** How a webhook endpoint's signing secret is created, stored, shown, and recovered
  (phase 10 D8, F5).

## Context

The contract says a webhook secret is "returned exactly once" but is silent on storage. That
silence is the whole decision, and the two obvious answers both fail:

- **Hash it** (as API keys are, ADR-0014). Impossible: signing requires the plaintext on every
  outbound request, so a hash cannot verify anything.
- **Store it reversibly** (plaintext, or plaintext with a home-grown scramble). A database
  compromise then yields every endpoint's signing secret, from which an attacker can forge
  `BrinnPay-Signature` for any project and any endpoint — strictly worse than the API-key
  posture Phase 5 established.

Unlike an API key, the secret is long-lived: it is chosen once, distributed to the destination's
operators, and used for every future delivery. It also has to survive process restarts and worker
redeploys, and it must be identical in the API process (which never signs) and in the worker
process (which signs every attempt).

## Decision

**32 CSPRNG bytes, base64url, returned once, encrypted at rest with AES-256-GCM under a
boot-validated environment key, with no rotation operation in v1.**

- **Generation:** `crypto.randomBytes(32)` → base64url without padding (43 characters, 256 bits).
  The format carries no environment prefix: unlike an API key, the secret is never sent *to* the
  API, and the project/environment binding is enforced by the endpoint row, not by the string.
- **Display once:** the plaintext exists in the create response and in the request that produced
  it. It is never returned by any other operation — not by retrieve, not by update — and the
  dashboard shows it in component state for exactly one interaction, with an explicit
  "shown once — copy it now" notice and no web storage.
- **Storage:** AES-256-GCM, with the initialization vector and authentication tag stored next to
  the ciphertext. The key comes from `WEBHOOK_ENCRYPTION_KEY`, is validated at boot (32 bytes,
  base64-decoded, matching `openssl rand -base64 32`) with the `JWT_SECRET` fail-fast precedent, and
  is a distinct secret from the JWT signing key so a leak of one does not compromise the other.
- **No rotation in v1.** There is no reveal, no rotate, and no re-encrypt endpoint. Recovery is
  delete and recreate the endpoint, which is a deliberate operational answer (the destination
  operators must roll their own secret anyway) rather than an omission. The key is therefore a
  long-lived secret: it must be shared by the API and every worker replica, and rotating it
  requires re-encrypting or recreating endpoints.
- **Signing uses the decrypted secret in memory only.** It is never logged, never included in an
  error message, never returned by the API, and never written to `last_error`.

## Consequences

- A database compromise yields ciphertext that is useless without the environment key, so the
  worst case is "endpoint URLs and event payloads", not "the ability to forge signatures".
- Compromising one endpoint's secret compromises only that endpoint; there is no shared signing key
  across a project or a tenant.
- There is no recovery path: a destination operator who loses the secret must have the endpoint
  recreated, and a **key rotation of `WEBHOOK_ENCRYPTION_KEY` would break every existing
  endpoint's signatures**. That is a documented operational constraint, to be addressed by a
  re-encryption tool in a later phase.
- Because the worker needs the key, the worker process must receive `WEBHOOK_ENCRYPTION_KEY` in its
  environment; a worker without it cannot start rather than silently signing with a default.
- The 32-byte key requirement means an operator cannot choose a memorable value, which is the point.
