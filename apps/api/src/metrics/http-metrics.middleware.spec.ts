import type { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

import { createHttpRequestMetricsMiddleware } from './http-metrics.middleware';
import { MetricsService } from './metrics.service';

/**
 * Passive HTTP instrumentation (phase 20 M1, §4 rule 5): measure what is in
 * scope, never touch what is not, and never let a metric defect reach the
 * request path.
 */
describe('http metrics middleware (phase 20 M1, §4 rule 5)', () => {
  let metrics: MetricsService;
  let next: NextFunction;

  /** A response double carrying the event emitter semantics the middleware uses. */
  function createResponse(statusCode: number): Response & EventEmitter {
    const listeners: Record<string, Array<() => void>> = {};
    const emitter = {
      on: (event: string, listener: () => void) => {
        (listeners[event] ??= []).push(listener);
        return emitter;
      },
      emit: (event: string) => {
        for (const listener of listeners[event] ?? []) listener();
      },
    };
    return {
      statusCode,
      on: emitter.on,
      emit: emitter.emit,
    } as unknown as Response & EventEmitter;
  }

  function createRequest(input: {
    url?: string;
    method?: string;
    /** `true` produces a request whose route never resolved (404 handling). */
    unmatched?: boolean;
    headers?: Record<string, string>;
  }): Request {
    return {
      url: input.url ?? '/api/v1/customers',
      originalUrl: input.url ?? '/api/v1/customers',
      method: input.method ?? 'GET',
      route: input.unmatched === true ? undefined : { path: '/customers/:id' },
      baseUrl: '/api/v1',
      headers: input.headers ?? {},
    } as unknown as Request;
  }

  beforeEach(() => {
    metrics = new MetricsService();
    next = jest.fn();
  });

  it('records a matched /api/v1 request on finish', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(200);
    middleware(createRequest({}), response, next);
    expect(next).toHaveBeenCalledTimes(1);

    response.emit('finish');
    const body = await metrics.render();
    expect(body).toContain(
      'brinnpay_http_requests_total{route="/customers/:id",method="GET",status_class="2xx"} 1',
    );
    expect(body).toContain('brinnpay_http_requests_in_flight 0');
  });

  it('also records on close alone (aborted connections still count), exactly once', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(499);
    middleware(createRequest({}), response, next);

    response.emit('close');
    response.emit('finish'); // the pair must not double-count

    const body = await metrics.render();
    expect(body).toContain(
      'brinnpay_http_requests_total{route="/customers/:id",method="GET",status_class="4xx"} 1',
    );
  });

  it('counts 5xx responses into the server-error counter', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(503);
    middleware(createRequest({}), response, next);
    response.emit('finish');

    const body = await metrics.render();
    expect(body).toContain('brinnpay_http_server_errors_total{route="/customers/:id"} 1');
  });

  it('labels an unmatched request as a single series', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(404);
    middleware(createRequest({ unmatched: true }), response, next);
    response.emit('finish');

    const body = await metrics.render();
    expect(body).toContain('route="unmatched"');
  });

  it('skips everything outside /api/v1 (health, Swagger, the metrics path itself)', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    for (const url of ['/health/live', '/health/ready', '/docs', '/metrics']) {
      const response = createResponse(200);
      middleware(createRequest({ url }), response, next);
      response.emit('finish');
      expect(next).toHaveBeenCalled();
    }

    const body = await metrics.render();
    expect(body).not.toContain('brinnpay_http_requests_total{');
  });

  it('skips CORS preflights, matching the request-log policy', async () => {
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(204);
    middleware(
      createRequest({
        method: 'OPTIONS',
        headers: { origin: 'https://example.test', 'access-control-request-method': 'GET' },
      }),
      response,
      next,
    );
    response.emit('finish');

    const body = await metrics.render();
    expect(body).not.toContain('brinnpay_http_requests_total{');
  });

  it('still completes the request when the service throws (§4 rule 5)', () => {
    jest.spyOn(metrics, 'observeHttpRequest').mockImplementationOnce(() => {
      throw new Error('label explosion');
    });
    const middleware = createHttpRequestMetricsMiddleware(metrics);
    const response = createResponse(200);
    expect(() => {
      middleware(createRequest({}), response, next);
      response.emit('finish');
    }).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
