import { ApiError } from '../common/errors/api-error';

/**
 * `Idempotency-Key` header rules (phase 8 §4.2.2, §6.5; contract bounds from
 * phase 7 D6).
 *
 * The header is optional: an absent key means "execute normally, store
 * nothing". When present the value must be non-empty after trimming and at most
 * 255 characters (the storage bound of `idempotency_records.idempotency_key`);
 * anything else is a 400 `VALIDATION_ERROR` field error, exactly as in Phase 7.
 *
 * The accepted value is **trimmed** before it is stored and used for
 * uniqueness (§4.1.2 "validate and normalize"), so `' order_1 '` and
 * `'order_1'` are the same key. The raw length is what the bound is checked
 * against, which keeps the Phase 7 outcome for a 255-character padded key.
 *
 * Keys are credential-free but client-identifying data: they are never logged
 * (phase 8 §6.6) and never echoed in error messages.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Validates and normalizes the optional header. Returns `undefined` when the
 * caller sent no key, the trimmed key when it is usable, and throws
 * `ApiError` 400 `VALIDATION_ERROR` when it is not.
 */
export function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw ApiError.validation({
      fields: [
        {
          field: 'idempotency-key',
          errors: [`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`],
        },
      ],
    });
  }
  return value.trim();
}
