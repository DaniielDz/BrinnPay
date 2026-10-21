import { randomBytes } from 'node:crypto';

/**
 * Per-run, per-suite password for e2e fixtures.
 *
 * Phase 17 §8 requires "random passwords meeting the Phase 3 policy … no
 * reused credentials across suites", so a suite never registers accounts with
 * a fixed committed literal. Each call generates a fresh value: a suite calls
 * it once at module load, which gives that suite (and that run) its own
 * password.
 *
 * The Phase 3 D6 bounds hold by construction: `minLength 8`, `maxLength 128`,
 * NIST-style (no composition rules) — `<prefix>-` plus 16 random bytes in
 * `base64url` (22 characters) lands between them with entropy to spare.
 */
export function runPassword(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('base64url')}`;
}
