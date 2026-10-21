import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  KEY_HASH_CHARS,
  RANDOM_SECTION_BYTES,
  RANDOM_SECTION_CHARS,
} from './api-key-crypto';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

describe('API key scheme (phase 5 §4.5, D4 / ADR-0006)', () => {
  it('generates keys with the sk_test_ / sk_live_ prefixes and a 43-char base64url random section', () => {
    const testKey = generateApiKey('test');
    const liveKey = generateApiKey('live');

    expect(testKey.startsWith(`${API_KEY_PREFIX}test_`)).toBe(true);
    expect(liveKey.startsWith(`${API_KEY_PREFIX}live_`)).toBe(true);

    const testSection = testKey.slice(`${API_KEY_PREFIX}test_`.length);
    const liveSection = liveKey.slice(`${API_KEY_PREFIX}live_`.length);

    expect(testSection).toHaveLength(RANDOM_SECTION_CHARS);
    expect(liveSection).toHaveLength(RANDOM_SECTION_CHARS);
    expect(BASE64URL_PATTERN.test(testSection)).toBe(true);
    expect(BASE64URL_PATTERN.test(liveSection)).toBe(true);
  });

  it('random section is 32 bytes (256 bits of entropy) of unpadded base64url', () => {
    // 32 bytes encode to exactly 43 unpadded base64url characters.
    expect(Math.ceil((RANDOM_SECTION_BYTES * 8) / 6)).toBe(RANDOM_SECTION_CHARS);
    expect(RANDOM_SECTION_CHARS).toBe(43);
  });

  it('generates unique keys in bulk (no collisions in a large sample)', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      keys.add(generateApiKey('test'));
    }
    expect(keys.size).toBe(5000);
  });

  it('test keys never look like live keys and vice versa', () => {
    for (let i = 0; i < 100; i += 1) {
      const testKey = generateApiKey('test');
      const liveKey = generateApiKey('live');
      expect(testKey.startsWith('sk_live_')).toBe(false);
      expect(liveKey.startsWith('sk_test_')).toBe(false);
    }
  });

  it('hashes to a 64-char lowercase hex digest', () => {
    const digest = hashApiKey('sk_test_abc');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toHaveLength(KEY_HASH_CHARS);
  });

  it('hashing is deterministic for the same input but never returns the plaintext', () => {
    const key = generateApiKey('live');
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).not.toBe(key);
    expect(hashApiKey(key)).not.toContain(key);
  });

  it('different keys hash differently', () => {
    const a = hashApiKey('sk_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = hashApiKey('sk_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(a).not.toBe(b);
  });
});