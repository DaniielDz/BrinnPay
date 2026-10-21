import { createHmac, randomBytes } from 'node:crypto';

import {
  buildSignatureHeader,
  computeSignature,
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  resolveWebhookEncryptionKey,
  signatureMaterial,
  signaturesMatch,
  WEBHOOK_ENCRYPTION_KEY_BYTES,
  WEBHOOK_SECRET_BYTES,
} from './webhook-crypto';
import { toEndpointCreatedResponse, toEndpointResponse } from './webhook-types';

const KEY = randomBytes(WEBHOOK_ENCRYPTION_KEY_BYTES);

describe('webhook signing cryptography (phase 10 §5.2, D7/D8)', () => {
  describe('secret generation (D8)', () => {
    it('is 32 CSPRNG bytes (256 bits) as unpadded base64url', () => {
      const secret = generateWebhookSecret();
      // 32 bytes encode to exactly 43 unpadded base64url characters.
      expect(Buffer.from(secret, 'base64url')).toHaveLength(WEBHOOK_SECRET_BYTES);
      expect(secret).toHaveLength(43);
      expect(/^[A-Za-z0-9_-]+$/.test(secret)).toBe(true);
    });

    it('never repeats across a large sample', () => {
      const secrets = new Set<string>();
      for (let i = 0; i < 5000; i += 1) {
        secrets.add(generateWebhookSecret());
      }
      expect(secrets.size).toBe(5000);
    });
  });

  describe('storage at rest (D8)', () => {
    it('round-trips the plaintext through AES-256-GCM', () => {
      const secret = generateWebhookSecret();
      const stored = encryptWebhookSecret(secret, KEY);

      expect(Buffer.from(stored.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(stored.authTag, 'base64')).toHaveLength(16);
      // The ciphertext must not be the plaintext in any recognizable form.
      expect(stored.ciphertext).not.toContain(secret);
      expect(decryptWebhookSecret(stored, KEY)).toBe(secret);
    });

    it('uses a fresh IV per encryption, so the same secret never encrypts twice alike', () => {
      const secret = generateWebhookSecret();
      const first = encryptWebhookSecret(secret, KEY);
      const second = encryptWebhookSecret(secret, KEY);

      expect(first.iv).not.toBe(second.iv);
      expect(first.ciphertext).not.toBe(second.ciphertext);
      expect(decryptWebhookSecret(first, KEY)).toBe(secret);
      expect(decryptWebhookSecret(second, KEY)).toBe(secret);
    });

    it('rejects a tampered ciphertext or auth tag (GCM authenticates the record)', () => {
      const stored = encryptWebhookSecret('whsec_value', KEY);

      const tamperedCiphertext = { ...stored, ciphertext: Buffer.from('tampered').toString('base64') };
      expect(() => decryptWebhookSecret(tamperedCiphertext, KEY)).toThrow();

      const tamperedTag = { ...stored, authTag: Buffer.alloc(16, 0).toString('base64') };
      expect(() => decryptWebhookSecret(tamperedTag, KEY)).toThrow();
    });

    it('cannot be decrypted with a different key', () => {
      const stored = encryptWebhookSecret('whsec_value', KEY);
      const other = randomBytes(WEBHOOK_ENCRYPTION_KEY_BYTES);
      expect(() => decryptWebhookSecret(stored, other)).toThrow();
    });
  });

  describe('signature scheme (D7)', () => {
    it('signs exactly `${t}.${rawBody}` with HMAC-SHA256 and hex-encodes the digest', () => {
      const body = '{"id":"evt","type":"payment.created"}';
      const timestamp = 1_700_000_000;

      expect(signatureMaterial(timestamp, body)).toBe(`${timestamp}.${body}`);

      const expected = createHmac('sha256', 'whsec_value')
        .update(`${timestamp}.${body}`, 'utf8')
        .digest('hex');
      expect(computeSignature({ secret: 'whsec_value', timestamp, body })).toBe(expected);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
    });

    it('emits `t=<unix-seconds>,v1=<hex>` in the BrinnPay-Signature header', () => {
      const header = buildSignatureHeader({
        secret: 'whsec_value',
        timestamp: 1_700_000_000,
        body: '{}',
      });

      expect(header).toBe(
        `t=1700000000,v1=${computeSignature({ secret: 'whsec_value', timestamp: 1_700_000_000, body: '{}' })}`,
      );
      expect(header.split(',')).toHaveLength(2);
    });

    it('changes the signature when the timestamp changes but the body stays byte-identical', () => {
      const input = { secret: 'whsec_value', body: '{"a":1}' };
      const first = computeSignature({ ...input, timestamp: 1_700_000_000 });
      const second = computeSignature({ ...input, timestamp: 1_700_000_001 });

      // The body is reused verbatim across attempts, so only the timestamp
      // distinguishes the two attempts.
      expect(first).not.toBe(second);
    });

    it('changes the signature when a single body byte changes', () => {
      const base = { secret: 'whsec_value', timestamp: 1_700_000_000 };
      expect(computeSignature({ ...base, body: '{"a":1}' })).not.toBe(
        computeSignature({ ...base, body: '{"a":2}' }),
      );
    });

    it('compares signatures in constant time and rejects any mismatch', () => {
      const digest = computeSignature({ secret: 's', timestamp: 1, body: '{}' });
      expect(signaturesMatch(digest, digest)).toBe(true);
      expect(signaturesMatch(digest, digest.replace(/.$/, '0'))).toBe(false);
      // A truncated or absent digest can never be "close enough".
      expect(signaturesMatch(digest, digest.slice(0, 10))).toBe(false);
      expect(signaturesMatch(digest, '')).toBe(false);
      expect(signaturesMatch('', '')).toBe(false);
    });
  });

  describe('boot-time key validation (D8, phase 3 JWT_SECRET precedent)', () => {
    it('accepts base64 of exactly 32 bytes', () => {
      const raw = randomBytes(WEBHOOK_ENCRYPTION_KEY_BYTES).toString('base64');
      expect(resolveWebhookEncryptionKey(raw, false)).toHaveLength(WEBHOOK_ENCRYPTION_KEY_BYTES);
    });

    it('fails fast on a short or long key', () => {
      expect(() =>
        resolveWebhookEncryptionKey(randomBytes(16).toString('base64'), false),
      ).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
      expect(() =>
        resolveWebhookEncryptionKey(randomBytes(64).toString('base64'), false),
      ).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
    });

    it('fails fast when the key is missing and the fallback was not opted into', () => {
      expect(() => resolveWebhookEncryptionKey(undefined, false)).toThrow(/required/);
      expect(() => resolveWebhookEncryptionKey('', false)).toThrow(/required/);
    });

    it('uses the committed fallback only on the explicit opt-in', () => {
      // The opt-in exists because inference was wrong in both directions: keying
      // on `NODE_ENV=test` breaks any CI profile that sets it, and keying on "no
      // DATABASE_URL exported" misses a process that still reaches the hardcoded
      // localhost default. A deliberate flag is the only predicate that is not
      // wrong by accident.
      const key = resolveWebhookEncryptionKey(undefined, true);
      expect(key).toHaveLength(WEBHOOK_ENCRYPTION_KEY_BYTES);
    });

    it('prefers an explicit key over the fallback, so the opt-in cannot mask a real key', () => {
      const explicit = randomBytes(WEBHOOK_ENCRYPTION_KEY_BYTES);
      expect(resolveWebhookEncryptionKey(explicit.toString('base64'), true)).toEqual(explicit);
    });
  });

  describe('secret handling (D8)', () => {
    it('keeps the secret out of every projection that is not the 201 create response', () => {
      // There is no redaction helper on purpose: the secret is never placed
      // anywhere it would need one. It exists only as a local in
      // `WebhooksService.createEndpoint`, travels to the caller in the created
      // response, and is otherwise read back only as ciphertext to decrypt for
      // signing. A "redact before logging" helper with no caller would imply a
      // control that is not actually the thing protecting the secret.
      const row = {
        id: 'ep_1',
        projectId: 'pr_1',
        environment: 'test',
        url: 'https://example.test/hook',
        eventTypes: ['payment.created'],
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const secret = generateWebhookSecret();

      const created = toEndpointCreatedResponse(row, secret);
      const listed = toEndpointResponse(row);

      expect(created.signing_secret).toBe(secret);
      // The same row projected without the secret carries no trace of it.
      expect(JSON.stringify(listed)).not.toContain(secret);
      expect('signing_secret' in listed).toBe(false);
    });
  });
});
