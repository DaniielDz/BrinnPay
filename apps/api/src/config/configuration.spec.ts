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

/**
 * The request-log retention knobs (phase 11 D5). Exercised through the loader
 * for the same reason as the delivery knobs above: these values decide when a
 * row is destroyed by a background job, so a typo has to fail at boot rather
 * than silently keeping records for a thousand days (or none).
 */
describe('request logging configuration (phase 11 D5)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['REQUEST_LOG_RETENTION_DAYS', 'REQUEST_LOG_CLEANUP_INTERVAL_MS', 'WEBHOOK_ENCRYPTION_KEY'];

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Required by `loadConfiguration` in every profile (see the cases above).
    process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(32, 0x2b).toString('base64');
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to 30 days of retention with an hourly cleanup pass', () => {
    const config = loadConfiguration();
    expect(config.requestLogging.retentionDays).toBe(30);
    expect(config.requestLogging.cleanupIntervalMs).toBe(3_600_000);
  });

  it('accepts explicit retention and cleanup cadence', () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '7';
    process.env.REQUEST_LOG_CLEANUP_INTERVAL_MS = '900000';
    const config = loadConfiguration();
    expect(config.requestLogging.retentionDays).toBe(7);
    expect(config.requestLogging.cleanupIntervalMs).toBe(900_000);
  });

  it('rejects a non-positive or non-integer retention at boot', () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '0';
    expect(() => loadConfiguration()).toThrow(/REQUEST_LOG_RETENTION_DAYS must be a positive integer/);
    process.env.REQUEST_LOG_RETENTION_DAYS = '1.5';
    expect(() => loadConfiguration()).toThrow(/REQUEST_LOG_RETENTION_DAYS must be a positive integer/);
  });

  it('rejects a non-positive or non-integer cleanup interval at boot', () => {
    process.env.REQUEST_LOG_CLEANUP_INTERVAL_MS = '-1';
    expect(() => loadConfiguration()).toThrow(
      /REQUEST_LOG_CLEANUP_INTERVAL_MS must be a positive integer/,
    );
  });

  it('rejects an out-of-range retention or cleanup interval at boot', () => {
    // A value beyond the ceiling would compute an invalid cutoff date and
    // silently disable cleanup, so it must fail loudly instead (F2).
    process.env.REQUEST_LOG_RETENTION_DAYS = '999999999';
    expect(() => loadConfiguration()).toThrow(/REQUEST_LOG_RETENTION_DAYS must be at most 3650/);
    delete process.env.REQUEST_LOG_RETENTION_DAYS;
    process.env.REQUEST_LOG_CLEANUP_INTERVAL_MS = '999999999999';
    expect(() => loadConfiguration()).toThrow(
      /REQUEST_LOG_CLEANUP_INTERVAL_MS must be at most 86400000/,
    );
  });
});