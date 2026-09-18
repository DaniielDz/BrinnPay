# ADR-0006: API Key Format and Handling

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** API key generation, storage, and exposure (detailed scheme in Phase 5).

## Context

API keys are credentials for programmatic access scoped to a project environment. In a sandbox with both TEST and LIVE environments, accidentally using a LIVE key against TEST infrastructure (or vice versa) is a common developer error, so environments must be visually distinguishable. Credentials must never be recoverable after creation.

## Decision

API keys follow a prefixed format that identifies the environment:

```text
sk_test_...   # TEST environment
sk_live_...   # LIVE environment
```

Handling rules:

- The full key is **displayed only once**, at creation time.
- Only a **hash** of the key is stored (hashing scheme defined in Phase 5; uniqueness per project environment required).
- Keys **never appear in full** in logs, error responses, or any artifact.
- A key identifies exactly one project + environment.
- The definitive key scheme (length, charset, hashing algorithm, lookup strategy) is detailed in Phase 5; the strategy defined here is binding.

## Consequences

- TEST/LIVE confusion is reduced through visible prefixes.
- Key loss requires rotation (Phase 5 feature), since the plaintext is shown once.
- Hashed-at-rest storage limits the impact of database compromise; hash verification cost is a Phase 5 implementation concern.