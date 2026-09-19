import type { NextFunction, Request, Response } from 'express';

import { resolveRequestId } from './request-id';

/**
 * Assigns a request ID at ingress and exposes it on the `X-Request-Id`
 * response header (phase 1 §7.7). Reuses an ID already assigned by the
 * structured logger so every log line and response correlate.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(request);
  response.setHeader('X-Request-Id', requestId);
  next();
}
