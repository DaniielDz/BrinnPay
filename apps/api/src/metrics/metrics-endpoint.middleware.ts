import { createHash, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { requestPathOf } from '../request-logging/request-log-record';
import { MetricsService } from './metrics.service';

/**
 * The exposition endpoint (phase 20 D1(a)/D4(a), §8): Prometheus text format
 * at a configurable path outside `/api/v1`.
 *
 * This is a middleware rather than a controller on purpose: a Nest controller
 * would sit inside the versioned contract's routing table, would show up in
 * the route-class audit that assumes one entry per contract operation, and
 * would be reachable through the global prefix machinery the spec explicitly
 * excludes the endpoint from. Registered once in `configureApp`, it matches by
 * exact path, answers `405` to non-scrape verbs, authenticates the optional
 * scrape token, and never touches the domain layer.
 *
 * Security posture (D4(a), §7): the endpoint can expose internal labels
 * (route templates, queue states, sweep timings) but never tokens, secrets,
 * account identifiers or request-log contents; the optional bearer token is
 * compared in constant time over fixed-length digests so neither length nor
 * content of the expected secret leaks through response timing. The default
 * deployment keeps the endpoint on the internal network only (no published
 * port, compose `monitoring` profile).
 */

/** Constant-time bearer-token comparison; never echoes either side. */
export function isScrapeAuthorized(
  headers: Record<string, string | string[] | undefined>,
  token: string | null,
): boolean {
  if (token === null) {
    return true;
  }
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (match === null) {
    return false;
  }
  // Hash both sides to fixed length first: `timingSafeEqual` requires equal
  // sizes, and comparing digests keeps the comparison length-independent.
  const presented = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

export interface MetricsEndpointOptions {
  path: string;
  scrapeToken: string | null;
}

export function createMetricsEndpointMiddleware(
  metrics: MetricsService,
  options: MetricsEndpointOptions,
) {
  const logger = new Logger('MetricsEndpoint');
  const { path, scrapeToken } = options;

  return (request: Request, response: Response, next: NextFunction): void => {
    const requestPath = requestPathOf(request.originalUrl ?? request.url ?? '');
    if (requestPath !== path) {
      next();
      return;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.status(405).end();
      return;
    }

    if (!isScrapeAuthorized(request.headers, scrapeToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(401).end();
      return;
    }

    metrics
      .render()
      .then((body) => {
        response.status(200);
        response.setHeader('Content-Type', metrics.contentType);
        response.end(method === 'HEAD' ? undefined : body);
      })
      .catch((error: unknown) => {
        // An exposition failure means the process is unhealthy, not that the
        // scraper should retry a partial body; log loudly, answer 500.
        logger.error({ err: error }, 'metrics exposition failed');
        response.status(500).end();
      });
  };
}
