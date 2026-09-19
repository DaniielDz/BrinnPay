import { randomUUID } from 'node:crypto';

/**
 * Request ID scheme (`req_...`, phase 1 §7.8). Request IDs are assigned at
 * ingress and are never used as secrets.
 */
export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '')}`;
}

interface RequestIdCarrier {
  // pino-http augments IncomingMessage with `id?: ReqId` (string | number |
  // object); only string values are treated as pre-assigned request IDs.
  id?: unknown;
}

/**
 * Returns the request ID already assigned to the request, or generates a new
 * one. Idempotent so that the request-ID middleware and the structured logger
 * agree on a single ID regardless of middleware ordering.
 */
export function resolveRequestId(request: RequestIdCarrier): string {
  if (typeof request.id === 'string' && request.id.length > 0) {
    return request.id;
  }

  const requestId = generateRequestId();
  request.id = requestId;
  return requestId;
}
