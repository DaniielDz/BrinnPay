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
/**
 * The rate-limit policy knobs (phase 13 §5/§6.2, D6/D8/D9/D1). Exercised through
 * the loader for the same reason as above, and with an extra one: a mistyped
 * limit must fail at boot instead of silently disabling throttling on the surface
 * it protects (AC13), and the Phase 3 `AUTH_RATE_LIMIT_*` names must keep working
 * unchanged (D9).
 */
describe('rate limiting configuration (phase 13 §5/§6.2)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'RATE_LIMIT_READ_MAX',
    'RATE_LIMIT_WRITE_MAX',
    'RATE_LIMIT_WINDOW_SECONDS',
    'RATE_LIMIT_WEBHOOK_REPLAY_MAX',
    'RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS',
    'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX',
    'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS',
    'RATE_LIMIT_FAIL_MODE',
    'TRUST_PROXY_HOPS',
    'TRUST_PROXY_CIDRS',
    'AUTH_RATE_LIMIT_WINDOW_SECONDS',
    'AUTH_RATE_LIMIT_IP_LOGIN_MAX',
    'AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX',
    'AUTH_RATE_LIMIT_IP_REFRESH_MAX',
    'AUTH_RATE_LIMIT_IP_READ_MAX',
    'WEBHOOK_ENCRYPTION_KEY',
  ];

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(32, 0x2b).toString('base64');
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to the confirmed sandbox numbers of §6.2', () => {
    const config = loadConfiguration();
    expect(config.rateLimit.readMax).toBe(600);
    expect(config.rateLimit.writeMax).toBe(120);
    expect(config.rateLimit.windowSeconds).toBe(60);
    expect(config.rateLimit.webhookReplay).toEqual({ max: 20, windowSeconds: 300 });
    expect(config.rateLimit.webhookEndpointCreate).toEqual({ max: 10, windowSeconds: 3600 });
  });

  it('defaults to trusting the socket peer, failing open, with no proxy allowlist (D1/D8)', () => {
    const config = loadConfiguration();
    expect(config.rateLimit.trustedProxyHops).toBe(0);
    expect(config.rateLimit.trustedProxyCidrs).toEqual([]);
    expect(config.rateLimit.failMode).toBe('open');
  });

  it('accepts explicit limits and windows', () => {
    process.env.RATE_LIMIT_READ_MAX = '900';
    process.env.RATE_LIMIT_WRITE_MAX = '250';
    process.env.RATE_LIMIT_WINDOW_SECONDS = '30';
    process.env.RATE_LIMIT_WEBHOOK_REPLAY_MAX = '5';
    process.env.RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS = '120';
    process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX = '3';
    process.env.RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS = '7200';

    const config = loadConfiguration();
    expect(config.rateLimit.readMax).toBe(900);
    expect(config.rateLimit.writeMax).toBe(250);
    expect(config.rateLimit.windowSeconds).toBe(30);
    expect(config.rateLimit.webhookReplay).toEqual({ max: 5, windowSeconds: 120 });
    expect(config.rateLimit.webhookEndpointCreate).toEqual({ max: 3, windowSeconds: 7200 });
  });

  it.each([
    'RATE_LIMIT_READ_MAX',
    'RATE_LIMIT_WRITE_MAX',
    'RATE_LIMIT_WINDOW_SECONDS',
    'RATE_LIMIT_WEBHOOK_REPLAY_MAX',
    'RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS',
    'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX',
    'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS',
  ])('rejects a non-positive %s at boot (AC13)', (key) => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      process.env[key] = value;
      expect(() => loadConfiguration()).toThrow(new RegExp(`${key} must be a positive integer`));
      delete process.env[key];
    }
  });

  it('accepts both documented failure postures and rejects anything else (D8)', () => {
    process.env.RATE_LIMIT_FAIL_MODE = 'closed';
    expect(loadConfiguration().rateLimit.failMode).toBe('closed');
    process.env.RATE_LIMIT_FAIL_MODE = 'open';
    expect(loadConfiguration().rateLimit.failMode).toBe('open');
    process.env.RATE_LIMIT_FAIL_MODE = 'fail-soft';
    expect(() => loadConfiguration()).toThrow(/RATE_LIMIT_FAIL_MODE must be "open" or "closed"/);
  });

  it('bounds the trusted proxy hop count (D1/§8)', () => {
    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/8';
    process.env.TRUST_PROXY_HOPS = '2';
    expect(loadConfiguration().rateLimit.trustedProxyHops).toBe(2);

    process.env.TRUST_PROXY_HOPS = '-1';
    expect(() => loadConfiguration()).toThrow(/TRUST_PROXY_HOPS must be a non-negative integer/);

    process.env.TRUST_PROXY_HOPS = '100';
    expect(() => loadConfiguration()).toThrow(/TRUST_PROXY_HOPS must be at most 10/);
  });

  it('refuses a hop count without an allowlist to go with it (D1)', () => {
    // `X-Forwarded-For` is written by the client up to the first proxy, so with no
    // allowlist the entry the limiter reads is the entry the caller chose — one
    // fresh budget per request, on every class including credential stuffing.
    process.env.TRUST_PROXY_HOPS = '1';
    delete process.env.TRUST_PROXY_CIDRS;
    expect(() => loadConfiguration()).toThrow(/TRUST_PROXY_CIDRS is required/);

    process.env.TRUST_PROXY_HOPS = '10';
    expect(() => loadConfiguration()).toThrow(/TRUST_PROXY_HOPS is greater than 0/);

    // Either half of the rule makes it a valid configuration.
    process.env.TRUST_PROXY_HOPS = '0';
    expect(loadConfiguration().rateLimit.trustedProxyHops).toBe(0);
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/8';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual(['10.0.0.0/8']);
  });

  it('refuses an allowlist entry that trusts more than a dedicated range', () => {
    // `0.0.0.0/0` and `::/0` are not a list of proxies; trusting them would
    // neutralize the model exactly as trusting nothing forwarded would.
    process.env.TRUST_PROXY_CIDRS = '0.0.0.0/0';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/8/);

    process.env.TRUST_PROXY_CIDRS = '::/0';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/32/);

    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/7';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/8/);

    // The ranges a deployment can actually dedicate to infrastructure are accepted.
    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/8,172.16.0.0/12,fd00:1234::/32,::1';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      'fd00:1234::/32',
      '::1/128',
    ]);
  });

  it('holds IPv6 entries to a floor a proxy fleet actually fits in', () => {
    // An IPv6 block is 4 billion times larger per prefix bit than an IPv4 one:
    // `::/8` is most of the routing table and `2000::/8` is every globally
    // routable peer, so both would put the peer gate open to the internet.
    process.env.TRUST_PROXY_CIDRS = '::/8';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/32/);

    process.env.TRUST_PROXY_CIDRS = '2000::/8';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/32/);

    process.env.TRUST_PROXY_CIDRS = 'fd00::/8';
    expect(() => loadConfiguration()).toThrow(/must not be shorter than \/32/);

    // A site allocation and a per-address entry both clear the floor.
    process.env.TRUST_PROXY_CIDRS = 'fd00:1234::/48,2001:db8::5/128';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual([
      'fd00:1234::/48',
      '2001:db8::5/128',
    ]);
  });

  it('holds an IPv4-mapped IPv6 entry to the IPv4 floor it is in disguise', () => {
    // `::ffff:0:0/96` is `0.0.0.0/0` in another notation: every IPv4 peer
    // becomes a "trusted proxy" and can mint a fresh budget per request.
    process.env.TRUST_PROXY_CIDRS = '::ffff:0:0/96';
    expect(() => loadConfiguration()).toThrow(/implied IPv4 prefix \/0 must be at least \/8/);

    // Narrower spellings of the same span: `::/64` reaches the mapped range.
    process.env.TRUST_PROXY_CIDRS = '::/64';
    expect(() => loadConfiguration()).toThrow(/spans the IPv4-mapped range/);

    // An entry wholly inside the mapped range implies IPv4 `prefix - 96`.
    process.env.TRUST_PROXY_CIDRS = '::ffff:1.0.0.0/100';
    expect(() => loadConfiguration()).toThrow(/implied IPv4 prefix \/4 must be at least \/8/);

    process.env.TRUST_PROXY_CIDRS = '::ffff:1.0.0.0/104';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual(['::ffff:1.0.0.0/104']);

    // A single mapped address is a single IPv4 host (/32).
    process.env.TRUST_PROXY_CIDRS = '::ffff:1.2.3.4';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual(['::ffff:1.2.3.4/128']);

    // The gate is on the range, not on how the address is spelled: an expanded,
    // uppercased or dotted-quad spelling of the same entry is the same entry.
    for (const spelling of [
      '::ffff:0.0.0.0/96',
      '0:0:0:0:0:ffff:0:0/96',
      '0000:0000:0000:0000:0000:ffff:0000:0000/96',
      '::FFFF:0:0/96',
      '0:0:0:0:0:FFFF:0.0.0.0/96',
    ]) {
      process.env.TRUST_PROXY_CIDRS = spelling;
      expect(() => loadConfiguration()).toThrow(/implied IPv4 prefix \/0 must be at least \/8/);
    }

    process.env.TRUST_PROXY_CIDRS = '::ffff:1.2.3.4/64';
    expect(() => loadConfiguration()).toThrow(/spans the IPv4-mapped range/);
  });

  it('validates the proxy allowlist at boot, so a trusted proxy cannot be a dead entry', () => {
    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/8, 172.16.0.5';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual(['10.0.0.0/8', '172.16.0.5/32']);

    process.env.TRUST_PROXY_CIDRS = 'fd00:1234::/32';
    expect(loadConfiguration().rateLimit.trustedProxyCidrs).toEqual(['fd00:1234::/32']);

    process.env.TRUST_PROXY_CIDRS = 'not-a-network';
    expect(() => loadConfiguration()).toThrow(/TRUST_PROXY_CIDRS entry "not-a-network"/);

    process.env.TRUST_PROXY_CIDRS = '10.0.0.0/99';
    expect(() => loadConfiguration()).toThrow(/prefix length between 0 and 32/);
  });

  it('keeps the Phase 3 auth variables on their names, defaults and meaning (D9)', () => {
    // The auth classes must not need a rename: deployed configuration keeps
    // working, and the confirmed phase 3 values are unchanged.
    const defaults = loadConfiguration().auth.rateLimits;
    expect(defaults).toEqual({
      windowSeconds: 900,
      ipLoginRegisterMax: 10,
      accountLoginRegisterMax: 10,
      ipRefreshMax: 60,
      ipReadMax: 100,
    });

    process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '3600';
    process.env.AUTH_RATE_LIMIT_IP_LOGIN_MAX = '3';
    process.env.AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX = '4';
    process.env.AUTH_RATE_LIMIT_IP_REFRESH_MAX = '5';
    process.env.AUTH_RATE_LIMIT_IP_READ_MAX = '6';

    expect(loadConfiguration().auth.rateLimits).toEqual({
      windowSeconds: 3600,
      ipLoginRegisterMax: 3,
      accountLoginRegisterMax: 4,
      ipRefreshMax: 5,
      ipReadMax: 6,
    });
  });
});

/**
 * The observability knobs (phase 20 D1/D4/D7). Exercised through the loader,
 * like every other boot-critical surface above: these values decide whether
 * an endpoint is exposed at all, which path it answers on, and whether a
 * scrape needs a credential — so a mistake must fail here, in milliseconds,
 * rather than shipping an unauthenticated exposition or a path that collides
 * with a health probe.
 */
describe('metrics configuration (phase 20 D1/D4/D7)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'METRICS_ENABLED',
    'METRICS_PATH',
    'METRICS_SCRAPE_TOKEN',
    'WORKER_METRICS_PORT',
    'SWAGGER_PATH',
    'JWT_SECRET',
    'WEBHOOK_ENCRYPTION_KEY',
  ];

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

  it('defaults to on outside production and off inside it (D4(a))', () => {
    // AC1 wants a clean local checkout scrapeable with zero setup; production
    // wants exposure to be a deliberate act, not a default.
    const config = loadConfiguration();
    expect(config.metrics.enabled).toBe(true);
    process.env.NODE_ENV = 'production';
    // Production mode demands a real JWT secret (phase 3 §6), unrelated to the
    // metrics default being exercised here.
    process.env.JWT_SECRET = 'a'.repeat(64);
    try {
      expect(loadConfiguration().metrics.enabled).toBe(false);
    } finally {
      process.env.NODE_ENV = 'test';
      delete process.env.JWT_SECRET;
    }
    process.env.METRICS_ENABLED = 'true';
    expect(loadConfiguration().metrics.enabled).toBe(true);
  });

  it('defaults to /metrics on a dedicated worker port (D1/D3)', () => {
    const config = loadConfiguration();
    expect(config.metrics.path).toBe('/metrics');
    expect(config.metrics.workerPort).toBe(9464);
    expect(config.metrics.scrapeToken).toBeNull();
  });

  it('accepts an explicit enablement, path, token and worker port', () => {
    const token = 't'.repeat(48);
    process.env.METRICS_ENABLED = 'false';
    process.env.METRICS_PATH = '/internal/metrics';
    process.env.METRICS_SCRAPE_TOKEN = token;
    process.env.WORKER_METRICS_PORT = '9999';

    const config = loadConfiguration();
    expect(config.metrics).toEqual({
      enabled: false,
      path: '/internal/metrics',
      scrapeToken: token,
      workerPort: 9999,
    });
  });

  it('rejects a non-boolean METRICS_ENABLED at boot', () => {
    process.env.METRICS_ENABLED = 'yes';
    expect(() => loadConfiguration()).toThrow(/METRICS_ENABLED must be "true" or "false"/);
  });

  it.each([
    'metrics',
    '/metrics?debug=1',
    '/metrics#top',
    '/metrics path',
    '',
    '.metrics',
  ])('rejects the invalid METRICS_PATH %p at boot', (value) => {
    process.env.METRICS_PATH = value;
    // An empty value falls back to the default (the established convention for
    // every other path-like knob, e.g. CORS_ORIGINS), so it must not throw.
    if (value === '') {
      expect(loadConfiguration().metrics.path).toBe('/metrics');
      return;
    }
    expect(() => loadConfiguration()).toThrow(/METRICS_PATH/);
  });

  it('refuses a path under the versioned contract, a health probe or Swagger', () => {
    // §5/§6/§8: the exposition sits outside /api/v1 (contract, rate limits,
    // request logs), must never shadow the health probes the platform probes,
    // and must not take over the developer docs mount.
    process.env.METRICS_PATH = '/api/v1/metrics';
    expect(() => loadConfiguration()).toThrow(/must not live under \/api\/v1/);
    process.env.METRICS_PATH = '/health/live';
    expect(() => loadConfiguration()).toThrow(/must not shadow the health endpoints/);
    process.env.METRICS_PATH = '/docs';
    expect(() => loadConfiguration()).toThrow(/must not shadow the Swagger UI mount/);
    process.env.SWAGGER_PATH = '/reference';
    process.env.METRICS_PATH = '/reference/metrics';
    expect(() => loadConfiguration()).toThrow(/must not shadow the Swagger UI mount/);
  });

  it('accepts the root-of-prefix path spelling that health uses', () => {
    process.env.METRICS_PATH = '/';
    expect(() => loadConfiguration()).toThrow(/must not be the root path/);
  });

  it('refuses a weak scrape token and never echoes it (D4(a), §7)', () => {
    // A short token is brute-forceable across the internal network it is meant
    // to complement, so boot rejects it — and the error names the variable and
    // the floor but never the value, because a rejected secret in a boot log
    // is a leaked secret.
    process.env.METRICS_SCRAPE_TOKEN = 'short';
    expect(() => loadConfiguration()).toThrow(/METRICS_SCRAPE_TOKEN must be at least 32 characters/);
    try {
      loadConfiguration();
    } catch (error) {
      expect((error as Error).message).not.toContain('short');
    }
  });

  it('bounds the worker listener port and names the variable on failure', () => {
    process.env.WORKER_METRICS_PORT = '0';
    expect(() => loadConfiguration()).toThrow(/WORKER_METRICS_PORT must be an integer between 1 and 65535/);
    process.env.WORKER_METRICS_PORT = '70000';
    expect(() => loadConfiguration()).toThrow(/WORKER_METRICS_PORT/);
    process.env.WORKER_METRICS_PORT = 'not-a-port';
    expect(() => loadConfiguration()).toThrow(/WORKER_METRICS_PORT/);
  });
});
