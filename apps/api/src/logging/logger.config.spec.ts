import type { ServerResponse } from 'node:http';

import { pino, type Logger } from 'pino';
import type { AutoLoggingOptions, Options as PinoHttpOptions } from 'pino-http';

import { REDACT_CENSOR, REDACT_PATHS, buildLoggerOptions } from './logger.config';

interface TestRequest {
  id?: string;
  url?: string;
  method?: string;
}

function createCaptureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const destination = {
    write: (line: string): void => {
      lines.push(line);
    },
  };
  const logger = pino(
    {
      level: 'info',
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    },
    destination,
  );
  return { logger, lines };
}

describe('logging base — secure redaction (phase 2 §4.2, §9.2)', () => {
  it('redacts secret-shaped values at any nesting level', () => {
    const { logger, lines } = createCaptureLogger();

    logger.info({
      keep: 'visible-value',
      password: 'sup3r-secret-pw',
      api_key: 'sk_test_secretkey123',
      token: 'tok_secret123',
      card_number: '4111-secret-1111',
      nested: { cvc: '123-secret', apiKey: 'nested-key-secret', token: 'nested-token' },
    });

    const output = lines.join('\n');
    expect(output).toContain('visible-value');
    expect(output).toContain(REDACT_CENSOR);
    expect(output).not.toContain('sup3r-secret-pw');
    expect(output).not.toContain('sk_test_secretkey123');
    expect(output).not.toContain('tok_secret123');
    expect(output).not.toContain('nested-token');
    expect(output).not.toContain('4111-secret-1111');
    expect(output).not.toContain('123-secret');
    expect(output).not.toContain('nested-key-secret');
  });

  it('redacts a webhook signing secret in both casings (phase 10 §8)', () => {
    const { logger, lines } = createCaptureLogger();

    // Nothing logs the secret today: `req.body` is censored wholesale and the
    // response serializer emits only a status. This assertion exists so the
    // property no longer *depends* on that invariant — Phase 11 adds request
    // logging, and `signing_secret` matches no other redaction path because the
    // wildcard rule covers `*.secret`, not `*.signing_secret`.
    logger.info({ signing_secret: 'whsec_leaked_value_here' });
    logger.info({ endpoint: { signingSecret: 'whsec_nested_leak_here' } });

    const output = lines.join('\n');
    expect(output).not.toContain('whsec_leaked_value_here');
    expect(output).not.toContain('whsec_nested_leak_here');
    expect(output).toContain(REDACT_CENSOR);
  });

  it('redacts the at-rest AES-GCM envelope of a webhook signing secret (phase 10 D8)', () => {
    const { logger, lines } = createCaptureLogger();

    // Ciphertext is not plaintext, but it is the encrypted body of every
    // endpoint secret under one key: leaking it hands an offline attacker the
    // whole set to grind. Redaction paths match whole key names rather than
    // prefixes, so the existing `secret` / `*.secret` entries do not cover
    // `secret_ciphertext`.
    logger.info({
      secret_ciphertext: 'LEAK-CIPHERTEXT',
      secretCipher: 'LEAK-CIPHER-CAMEL',
      secret_iv: 'LEAK-IV',
      secretIv: 'LEAK-IV-CAMEL',
      secret_auth_tag: 'LEAK-TAG',
      secretAuthTag: 'LEAK-TAG-CAMEL',
      endpoint: { secret_ciphertext: 'LEAK-NESTED-CIPHERTEXT' },
    });

    const output = lines.join('\n');
    for (const leak of [
      'LEAK-CIPHERTEXT',
      'LEAK-CIPHER-CAMEL',
      'LEAK-IV',
      'LEAK-IV-CAMEL',
      'LEAK-TAG',
      'LEAK-TAG-CAMEL',
      'LEAK-NESTED-CIPHERTEXT',
    ]) {
      expect(output).not.toContain(leak);
    }
    expect(output).toContain(REDACT_CENSOR);
  });

  it('redacts entire request bodies (req.body)', () => {
    const { logger, lines } = createCaptureLogger();

    logger.info({
      req: {
        method: 'POST',
        url: '/api/v1/example',
        body: { email: 'dev@brinnpay.dev', note: 'visible-body-key' },
      },
    });

    const output = lines.join('\n');
    expect(output).not.toContain('dev@brinnpay.dev');
    expect(output).not.toContain('visible-body-key');
    expect(output).toContain(REDACT_CENSOR);
  });

  it('asserts absence of secret-shaped values in the complete output', () => {
    const { logger, lines } = createCaptureLogger();

    logger.info({ password: 'hunter2' });
    logger.info({ authorization: 'Bearer sk_live_abcdef' });
    logger.info({ refresh_token: 'rt_secret' });

    const output = lines.join('\n');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('Bearer');
    expect(output).not.toContain('sk_live_abcdef');
    expect(output).not.toContain('rt_secret');
  });

  it('never emits an Idempotency-Key in plaintext (phase 8 §6.6)', () => {
    const { logger, lines } = createCaptureLogger();

    logger.info({
      req: {
        method: 'POST',
        url: '/api/v1/projects/0192f2a0-0000-7000-8000-00000000000b/payments',
        headers: { 'idempotency-key': 'order_client_key_do_not_log' },
      },
    });
    logger.info({ 'idempotency-key': 'order_client_key_do_not_log' });
    logger.info({ idempotency_key: 'order_client_key_do_not_log' });
    logger.info({ payload: { idempotency_key: 'order_client_key_do_not_log' } });

    const output = lines.join('\n');
    expect(output).toContain(REDACT_CENSOR);
    expect(output).not.toContain('order_client_key_do_not_log');
  });
});

describe('buildLoggerOptions (D3)', () => {
  const testConfig = { nodeEnv: 'test', logLevel: 'info' };

  function pinoHttpOptions(
    config: { nodeEnv: string; logLevel: string } = testConfig,
  ): PinoHttpOptions {
    const { pinoHttp } = buildLoggerOptions(config);
    return pinoHttp as PinoHttpOptions;
  }

  it('configures redaction for every log line', () => {
    const options = pinoHttpOptions();
    expect(options.redact).toEqual({ paths: REDACT_PATHS, censor: REDACT_CENSOR });
  });

  it('generates req_ request IDs and sets the X-Request-Id header', () => {
    const genReqId = pinoHttpOptions().genReqId as unknown as (
      request: TestRequest,
      response: ServerResponse & { setHeader: jest.Mock },
    ) => string;

    const request: TestRequest = {};
    const response = { setHeader: jest.fn() } as unknown as ServerResponse & {
      setHeader: jest.Mock;
    };

    const requestId = genReqId(request, response);

    expect(requestId).toMatch(/^req_/);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', requestId);
  });

  it('reuses a request ID already assigned by the middleware', () => {
    const genReqId = pinoHttpOptions().genReqId as unknown as (
      request: TestRequest,
      response: ServerResponse,
    ) => string;

    const request: TestRequest = { id: 'req_existing' };
    const response = { setHeader: jest.fn() } as unknown as ServerResponse;

    expect(genReqId(request, response)).toBe('req_existing');
  });

  it('skips auto-logging for health endpoints only', () => {
    const autoLogging = pinoHttpOptions().autoLogging as AutoLoggingOptions<TestRequest>;
    const ignore = autoLogging.ignore as (request: TestRequest) => boolean;

    expect(ignore({ url: '/health/live' })).toBe(true);
    expect(ignore({ url: '/health/ready' })).toBe(true);
    expect(ignore({ url: '/api/v1/anything' })).toBe(false);
  });

  it('uses pino-pretty only in development', () => {
    const development = pinoHttpOptions({ nodeEnv: 'development', logLevel: 'info' });
    expect(development.transport).toBeDefined();

    const production = pinoHttpOptions({ nodeEnv: 'production', logLevel: 'info' });
    expect(production.transport).toBeUndefined();
  });
});