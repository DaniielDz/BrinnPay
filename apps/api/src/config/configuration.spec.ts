import { loadConfiguration } from './configuration';

/**
 * Environment parsing for the webhook delivery knobs (phase 10 D5, §5.5).
 *
 * These are exercised through {@link loadConfiguration} rather than against the
 * private parsers, because the parsers are only reachable as the values the
 * application actually boots with: a mistyped variable has to fail here, where
 * it is cheap, instead of surfacing as delivery behavior hours later.
 */
describe('webhook delivery configuration (phase 10 D5)', () => {
  const saved: Record<string, string | undefined> = {};
  const WEBHOOK_KEYS = [
    'WEBHOOK_MAX_ATTEMPTS',
    'WEBHOOK_ENCRYPTION_KEY',
    'WEBHOOK_ALLOW_INSECURE_TEST_KEY',
    'DATABASE_URL',
  ];

  beforeEach(() => {
    for (const key of WEBHOOK_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // `loadConfiguration` demands an encryption key whenever a database is
    // configured, and `DATABASE_URL` is what signals that. These tests are about
    // the delivery knobs, so supply a key and let the encryption cases below
    // remove it deliberately.
    process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(32, 0x2b).toString('base64');
  });

  afterEach(() => {
    for (const key of WEBHOOK_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults the retry ladder to five attempts (D5)', () => {
    expect(loadConfiguration().webhooks.maxAttempts).toBe(5);
  });

  it('accepts an explicit attempt count within the ceiling', () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = '12';
    expect(loadConfiguration().webhooks.maxAttempts).toBe(12);
  });

  it('rejects an attempt count past the ceiling at boot', () => {
    // The ladder tops out at an hour of backoff, so an unbounded count is not a
    // delivery policy — it is an unbounded number of outbound requests against a
    // destination that is already failing. A typo must not become that.
    process.env.WEBHOOK_MAX_ATTEMPTS = '1000000';
    expect(() => loadConfiguration()).toThrow(/WEBHOOK_MAX_ATTEMPTS must be at most 20/);
  });

  it('rejects a non-integer or non-positive attempt count', () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = '5.5';
    expect(() => loadConfiguration()).toThrow(/positive integer/);
    process.env.WEBHOOK_MAX_ATTEMPTS = '0';
    expect(() => loadConfiguration()).toThrow(/positive integer/);
  });

  it('demands an encryption key, even under NODE_ENV=test', () => {
    // `NODE_ENV=test` is set by `pnpm test` itself, so keying the fallback on it
    // would hand every unit run a key that protects nothing while silently
    // applying to any CI profile or deployment that sets it for other reasons.
    expect(process.env.NODE_ENV).toBe('test');
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    expect(() => loadConfiguration()).toThrow(/WEBHOOK_ENCRYPTION_KEY is required/);
  });

  it('never grants the committed fallback key when a database is reachable', () => {
    // The runtime connection string falls back to a hardcoded localhost default,
    // so "no DATABASE_URL in the environment" is not "no database". The opt-in
    // is therefore refused once a database is in play — that combination is the
    // one that would encrypt real secrets under a published key.
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    process.env.WEBHOOK_ALLOW_INSECURE_TEST_KEY = 'true';
    process.env.DATABASE_URL = 'postgresql://brinnpay:brinnpay@localhost:5432/brinnpay';
    expect(() => loadConfiguration()).toThrow(/WEBHOOK_ENCRYPTION_KEY is required/);
  });

  it('grants the fallback only on the explicit opt-in with no database configured', () => {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    process.env.WEBHOOK_ALLOW_INSECURE_TEST_KEY = 'true';
    expect(loadConfiguration().webhooks.secretEncryptionKey).toHaveLength(32);
  });
});