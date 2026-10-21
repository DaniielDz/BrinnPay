# ADR-0007: Password Hashing — Argon2id

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 1
- **Scope:** User password hashing, implemented in Phase 3 (Authentication).

## Context

The roadmap (Phase 3) lists "bcrypt/argon2" as the password hashing option. Passwords must be stored using a modern, non-reversible, memory-hard algorithm to resist offline attacks. Each algorithm has library and runtime implications on the execution environment.

## Decision

- **Argon2id is the required/default password hashing algorithm for the MVP.**
- **bcrypt** is not a second equivalent option. It may be documented only as a permitted exception if a concrete implementation constraint prevents Argon2id (e.g., runtime/library limitations in the target environment). Such an exception requires an **explicit decision recorded in the Phase 3 specification** with the constraint that triggered it.
- Passwords are never stored in plaintext, never logged, and never transmitted back to the client.
- Implementation details (parameters, salt handling, migration path) belong to Phase 3.

## Consequences

- Modern, memory-hard, OWASP-aligned password storage is the default, not an option among equals.
- A native/binding dependency for Argon2id is introduced in Phase 3.
- If bcrypt is ever used, it remains a documented exception requiring an explicit Phase 3 decision, not the default.