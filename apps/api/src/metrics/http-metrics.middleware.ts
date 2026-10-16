import type { NextFunction, Request, Response } from 'express';

import {
  isCorsPreflight,
  requestPathOf,
} from '../request-logging/request-log-record';
import {
  isMetricsScopePath,
  normalizeMethodLabel,
  routeTemplateOf,
  statusClassOf,
} from './http-metrics';
import { MetricsService } from './metrics.service';

/**
 * Passive HTTP instrumentation for the API process (phase 20 M1, §4 rule 5:
 * metric collection must never fail, throttle or retry a request).
 *
 * One middleware wraps every request of the versioned contract and records
 * the count, duration and in-flight gauges. It is registered once, at boot,
 * in `configureApp` — never per request.
 *
 * Scope and safety properties:
 * - only `/api/v1/...` requests are measured, via the same
 *   `isUnderApiPrefix` predicate the rate-limit guard and request-log
 *   middleware use, so the exposition endpoint, health probes and Swagger
 *   never appear in the API series;
 * - CORS preflights are skipped, matching the request-log policy;
 * - labels come from closed sets only (template, method enum, status class);
 * - recording happens on `finish` **and** `close` (aborted connections still
 *   count), guarded so the pair cannot double-count;
 * - every metric operation is wrapped so that a defect in instrumentation
 *   can degrade observability but never a request.
 */
export function createHttpRequestMetricsMiddleware(metrics: MetricsService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const rawUrl = request.originalUrl ?? request.url ?? '';
    if (!isMetricsScopePath(requestPathOf(rawUrl))) {
      next();
      return;
    }
    if (isCorsPreflight(request.method, request.headers as Record<string, unknown>)) {
      next();
      return;
    }

    metrics.incHttpInFlight();
    const startedAt = performance.now();
    let recorded = false;

    const record = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      try {
        metrics.decHttpInFlight();
        const route = routeTemplateOf(request);
        const statusClass = statusClassOf(response.statusCode);
        metrics.observeHttpRequest({
          route,
          method: normalizeMethodLabel(request.method),
          statusClass,
          durationSeconds: (performance.now() - startedAt) / 1000,
        });
        if (response.statusCode >= 500) {
          metrics.incHttpServerError(route);
        }
      } catch {
        // §4 rule 5: instrumentation degrades silently; the request result
        // has already been produced by the time this runs.
      }
    };

    response.on('finish', record);
    response.on('close', record);
    next();
  };
}
