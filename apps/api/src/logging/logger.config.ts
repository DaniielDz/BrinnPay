import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';

import type { BrinnPayConfig } from '../config/configuration';
import { resolveRequestId } from '../request-id/request-id';

export const REDACT_CENSOR = '[REDACTED]';

/**
 * Redaction paths applied to every log line from day one (phase 1 §10). Full
 * request bodies are redacted; passwords, API keys, webhook secrets, tokens,
 * idempotency keys, and card-like payloads must never be written to logs — at
 * any nesting level (paths are declared for both the top-level key and a
 * wildcard position).
 *
 * `idempotency-key` is redacted since Phase 8: `payments.create` is a live
 * idempotent consumer, so the header is client-identifying retry data that must
 * not reach structured logs, error messages, request logs, or audit logs
 * (phase 8 §6.6). It was not redacted before because no endpoint used
 * idempotency keys yet.
 */
export const REDACT_PATHS: string[] = [
  'req.body',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'current_password',
  '*.current_password',
  'new_password',
  '*.new_password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'api_key',
  '*.api_key',
  'apiKey',
  '*.apiKey',
  'idempotency-key',
  '*.idempotency-key',
  'idempotency_key',
  '*.idempotency_key',
  'authorization',
  '*.authorization',
  'card',
  '*.card',
  'card_number',
  '*.card_number',
  'cvc',
  '*.cvc',
];

type LogRequest = IncomingMessage;

/**
 * Structured JSON logging with request IDs and redaction (D3). Uses
 * `pino-pretty` only for readable local development output; production and
 * test environments emit JSON.
 */
export function buildLoggerOptions(
  config: Pick<BrinnPayConfig, 'logLevel' | 'nodeEnv'>,
): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      redact: {
        paths: REDACT_PATHS,
        censor: REDACT_CENSOR,
      },
      genReqId: (request: IncomingMessage, response: ServerResponse): string => {
        const requestId = resolveRequestId(request);
        response.setHeader('X-Request-Id', requestId);
        return requestId;
      },
      serializers: {
        req: (request: LogRequest) => ({
          id: request.id,
          method: request.method,
          url: request.url,
        }),
        res: (response: ServerResponse & { statusCode: number }) => ({
          statusCode: response.statusCode,
        }),
      },
      autoLogging: {
        ignore: (request) =>
          request.url === '/health/live' || request.url === '/health/ready',
      },
      ...(config.nodeEnv === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                singleLine: true,
                translateTime: 'SYS:standard',
                colorize: true,
              },
            },
          }
        : {}),
    },
  };
}
