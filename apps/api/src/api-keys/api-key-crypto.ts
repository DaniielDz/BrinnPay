import { createHash, randomBytes } from 'node:crypto';

import type { Environment } from '../projects/environment';

/**
 * API key scheme (phase 5 §4.5, D4 — finalizes ADR-0006).
 *
 * Generation:
 *   - random section: 32 bytes from a CSPRNG (256 bits of entropy);
 *   - serialization: unpadded base64url (43 characters);
 *   - final format: `sk_test_<43 chars>` / `sk_live_<43 chars>` (~51 chars).
 *
 * Hashing:
 *   - one-way SHA-256, single pass, hex digest (64 characters); stored in a
 *     `varchar(64)` column with a unique constraint (D5). The key material has
 *     256 bits of entropy, so a fast hash is appropriate (no slow KDF — that
 *     is reserved for low-entropy secrets such as passwords, ADR-0007).
 *
 * The plaintext never appears in logs, error responses, or any artifact; the
 * hash digest is stored and compared by DB equality (the token is
 * high-entropy — constant-time comparison is not required for the lookup).
 */
export const API_KEY_PREFIX = 'sk_';
export const RANDOM_SECTION_BYTES = 32;
export const RANDOM_SECTION_CHARS = 43; // unpadded base64url of 32 bytes
export const KEY_HASH_CHARS = 64; // sha256 hex

export function generateApiKey(environment: Environment): string {
  const randomSection = randomBytes(RANDOM_SECTION_BYTES).toString('base64url');
  return `${API_KEY_PREFIX}${environment}_${randomSection}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}