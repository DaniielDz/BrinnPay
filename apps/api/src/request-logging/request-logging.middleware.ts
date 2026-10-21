import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/current-user';
import { uuidv7 } from '../common/uuid/uuid';
import { resolveRequestId } from '../request-id/request-id';
import {
  buildRequestLogRecord,
  isCorsPreflight,
  isUnderApiPrefix,
  requestPathOf,
  type RequestLogRequestContext,
} from './request-log-record';
import { RequestLogStoreService } from './request-log-store.service';

function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}(${code})` : error.name;
}

/**
 * Narrows the express request to exactly the context a record may read
 * (§4.2 rule 4, §14): the four attachments the guards resolve plus the parsed
 * query. Nothing else about the request is reachable from the capture path —
 * no header, no body, no cookie.
 */
function captureContext(request: Request): RequestLogRequestContext {
  const attached = request as unknown as AuthenticatedRequest;
  return {
    authUser: attached.authUser,
    project: attached.project,
    organizationMembership: attached.organizationMembership,
    apiKey: attached.apiKey,
    query: (request as unknown as { query?: unknown }).query,
  };
}

/**
 * Capture half of the request-logging capability (phase 11 §4.2/§5.2, D3).
 *
 * A Nest middleware rather than an interceptor because guards run *before*
 * interceptors: a 401/403/404 raised by an authorization guard would never
 * reach an interceptor, and §4.2 rule 1 requires those requests to produce a
 * record like any other. Middleware, by contrast, wraps every request under the
 * API prefix including the ones that are rejected before a handler exists.
 *
 * The record is assembled and written on the response's `finish` event — the
 * same lifecycle seam the structured logger uses — so the write is outside the
 * request/response path: it cannot delay the response, change it, or fail it,
 * and a store outage cannot change API readiness (AC5).
 *
 * Excluded surfaces (D7 §5.3) return before the listener is even attached, so
 * health probes, Swagger asset traffic, and CORS preflights produce no record
 * and no write attempt. Stdout logging is unaffected: the Phase 2 channel stays
 * process-wide and the two share the request id.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggingMiddleware.name);

  constructor(private readonly store: RequestLogStoreService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // `originalUrl` is the target the client sent; Express may rewrite `url`
    // while dispatching into a mounted router, and the prefix rule (D7) is
    // stated in terms of the request the client made.
    const rawUrl = request.originalUrl ?? request.url ?? '';
    if (!isUnderApiPrefix(requestPathOf(rawUrl))) {
      next();
      return;
    }
    if (isCorsPreflight(request.method, request.headers as Record<string, unknown>)) {
      next();
      return;
    }

    const requestId = resolveRequestId(request);
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    response.on('finish', () => {
      if (recorded) return;
      recorded = true;
      try {
        // Read at completion, deliberately: middleware runs *before* the guards,
        // so the scope they resolve (`project`, `organizationMembership`, …) only
        // exists once the response is being produced. Reading it here also means
        // the record reflects the context that actually authorized this very
        // response, including a partial resolution at the point of failure.
        const context = captureContext(request);
        const elapsedNs = process.hrtime.bigint() - startedAt;
        const record = buildRequestLogRecord({
          requestId,
          method: request.method,
          rawUrl,
          preflight: false,
          statusCode: response.statusCode,
          durationMs: Number(elapsedNs / 1_000_000n),
          now: new Date(),
          id: uuidv7(),
          request: context,
        });
        if (!record) return;
        // Best-effort by design (D3): `write` never throws, and the surrounding
        // try/catch keeps even an unexpected assembly failure off the response
        // path — it is logged with the request id only.
        void this.store.write(record);
      } catch (error) {
        this.logger.error(
          { request_id: requestId, reason: errorClassOf(error) },
          'Failed to assemble a request log record; it is dropped.',
        );
      }
    });

    next();
  }
}
