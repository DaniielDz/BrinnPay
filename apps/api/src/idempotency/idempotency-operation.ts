/**
 * Idempotent operation-scope catalog (phase 8 §4.2.1, ADR-0004).
 *
 * The scope is a string, not an enum in the database, so a later phase can add
 * an operation without a schema migration: Phase 8 activates
 * `payments.create` (§4.3.1) and reserves `refunds.create` for Phase 9
 * (§4.3.3, §14 coordination obligation). The persisted value is the key of the
 * compound uniqueness tuple
 * (project, operation_scope, idempotency_key) — the same key in another scope
 * is an independent operation (ADR-0004).
 */
export const IDEMPOTENCY_OPERATION_SCOPES = ['payments.create', 'refunds.create'] as const;

export type IdempotencyOperationScope = (typeof IDEMPOTENCY_OPERATION_SCOPES)[number];

export function isIdempotencyOperationScope(value: string): value is IdempotencyOperationScope {
  return (IDEMPOTENCY_OPERATION_SCOPES as readonly string[]).includes(value);
}

/** The first live idempotent operation (Phase 8, `payments.create`). */
export const PAYMENTS_CREATE_SCOPE = 'payments.create' satisfies IdempotencyOperationScope;

/** Reserved for Phase 9 — the capability already accepts it by configuration. */
export const REFUNDS_CREATE_SCOPE = 'refunds.create' satisfies IdempotencyOperationScope;
