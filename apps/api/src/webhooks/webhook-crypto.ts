import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing-secret cryptography (phase 10 §5.2, D7/D8).
 *
 * **Generation.** The secret is 32 bytes from a CSPRNG — 256 bits of entropy,
 * the same bar as an API key (ADR-0006) — serialized as unpadded base64url. It
 * is shown to the developer exactly once, in the 201 create response, and is
 * never recoverable through any v1 operation (D8: recovery = delete and
 * recreate the endpoint).
 *
 * **Storage at rest (D8).** Unlike an API key, a signing secret cannot be
 * hashed: signing needs the plaintext back. It is therefore encrypted with
 * AES-256-GCM under a key injected through the environment and validated at
 * boot (mirroring the phase 3 `JWT_SECRET` fail-fast precedent), so a database
 * compromise alone does not yield every endpoint's secret. GCM is used over CBC
 * because it authenticates the ciphertext as well as encrypting it, and the
 * node `crypto` primitives are used directly — no custom primitives.
 *
 * **Signing (D7).** Every outbound request carries
 * `BrinnPay-Signature: t=<unix-seconds>,v1=<lowercase-hex HMAC-SHA256>` where
 * the signed material is the exact string `` `${t}.${rawBody}` ``. The HMAC
 * covers the **exact bytes sent**, so it can never disagree with the body it
 * travels with. The timestamp is regenerated per attempt; the body is not.
 */

/** Raw secret material: 32 bytes = 256 bits of entropy (D8). */
export const WEBHOOK_SECRET_BYTES = 32;

/** AES-256-GCM key length in bytes. */
export const WEBHOOK_ENCRYPTION_KEY_BYTES = 32;

/** Header carrying the signature: `t=<unix-seconds>,v1=<hex>` (D7). */
export const SIGNATURE_HEADER = 'brinnpay-signature';

/** Nest DI token for the AES-256-GCM key protecting endpoint secrets (D8). */
export const WEBHOOK_SECRET_KEY = 'WEBHOOK_SECRET_KEY';

export interface EncryptedSecret {
  /** base64 AES-256-GCM ciphertext. */
  ciphertext: string;
  /** base64 12-byte GCM IV (unique per encryption by construction). */
  iv: string;
  /** base64 16-byte GCM authentication tag. */
  authTag: string;
}

export interface SignatureInput {
  /** The endpoint's plaintext signing secret. */
  secret: string;
  /** Signing timestamp, Unix **seconds**. */
  timestamp: number;
  /** The exact bytes that will be transmitted. */
  body: string;
}

/**
 * Generates a new endpoint signing secret. The value is CSPRNG-derived and
 * carries no project or environment information, so an endpoint secret leaked
 * from one project reveals nothing about the platform.
 */
export function generateWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
}

/**
 * Validates the AES-256-GCM key at boot (D8). Returns the decoded 32-byte key
 * or throws with actionable guidance. Called from configuration loading, so a
 * missing/short key fails fast exactly like `JWT_SECRET` (phase 3 §7.7).
 *
 * The test fallback is opt-in behind an **explicit** environment variable rather
 * than inferred. The fallback key is a constant in this repository, so anything
 * that guesses wrong about whether it is safe stores every endpoint signing
 * secret under a key any reader of the repository can recover, with no warning.
 * Inference is unreliable in both directions: keying on `NODE_ENV=test` alone
 * breaks any CI profile that sets it, and keying on "no `DATABASE_URL` in the
 * environment" is not the same as "no database" — the runtime URL falls back to
 * a hardcoded `localhost:5432` default, so a process with no `DATABASE_URL`
 * exported still reaches a real database and would store real secrets. Only the
 * unit suites set the flag, they know they store nothing, and a developer must
 * type it deliberately to get a key that protects nothing.
 */
export function resolveWebhookEncryptionKey(
  raw: string | undefined,
  allowInsecureTestKey: boolean,
): Buffer {
  if (raw !== undefined && raw !== '') {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== WEBHOOK_ENCRYPTION_KEY_BYTES) {
      throw new Error(
        `WEBHOOK_ENCRYPTION_KEY must be base64 of exactly ${WEBHOOK_ENCRYPTION_KEY_BYTES} bytes ` +
          `(generate one with \`openssl rand -base64 32\`).`,
      );
    }
    return key;
  }

  if (allowInsecureTestKey) {
    return Buffer.from(TEST_WEBHOOK_ENCRYPTION_KEY, 'base64');
  }

  throw new Error(
    'WEBHOOK_ENCRYPTION_KEY is required. Generate one with `openssl rand -base64 32` and set it in the environment.',
  );
}

/** Non-secret fallback used ONLY under test (see `resolveWebhookEncryptionKey`). */
const TEST_WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(WEBHOOK_ENCRYPTION_KEY_BYTES, 7).toString('base64');

/** Encrypts a plaintext secret for storage (D8). */
export function encryptWebhookSecret(secret: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a stored secret. A truncated or tampered record fails the GCM tag
 * check and throws, which surfaces as a delivery failure rather than a
 * signature computed over a wrong key.
 */
export function decryptWebhookSecret(stored: EncryptedSecret, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The signed material: `` `${t}.${rawBody}` `` (D7). Exposed so a consumer (or
 * a test) can reproduce the exact string BrinnPay signed.
 */
export function signatureMaterial(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/** Lowercase-hex HMAC-SHA256 over `` `${t}.${rawBody}` `` (D7). */
export function computeSignature({ secret, timestamp, body }: SignatureInput): string {
  return createHmac('sha256', secret).update(signatureMaterial(timestamp, body), 'utf8').digest('hex');
}

/** The `BrinnPay-Signature` header value for one attempt (D7). */
export function buildSignatureHeader(input: SignatureInput): string {
  return `t=${input.timestamp},v1=${computeSignature(input)}`;
}

/**
 * Constant-time signature comparison, as a consumer must perform it (D7). Two
 * different-length hex digests cannot be compared meaningfully, so a length
 * mismatch fails the check without leaking the expected length through an early
 * return on content.
 */
export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(providedHex, 'utf8');
  if (expected.length !== provided.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
