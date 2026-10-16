import type { NextFunction, Request, Response } from 'express';

import {
  createMetricsEndpointMiddleware,
  isScrapeAuthorized,
} from './metrics-endpoint.middleware';
import { MetricsService } from './metrics.service';

/**
 * The exposition endpoint's gatekeeping (phase 20 D4(a), §7/§8): path
 * matching, verb policy, and the optional bearer token. Asserted against the
 * middleware itself — this endpoint is the one surface outside the contract,
 * so its access rules are exactly the rules a scrape will meet.
 */
describe('metrics endpoint middleware (phase 20 D4(a))', () => {
  const token = 's'.repeat(48);
  let metrics: MetricsService;
  let response: {
    status: jest.Mock;
    setHeader: jest.Mock;
    end: jest.Mock;
  };
  let next: NextFunction;

  function createRequest(input: {
    url: string;
    method?: string;
    authorization?: string;
  }): Request {
    const headers: Record<string, string | undefined> = {};
    if (input.authorization !== undefined) {
      headers.authorization = input.authorization;
    }
    return {
      url: input.url,
      originalUrl: input.url,
      method: input.method ?? 'GET',
      headers,
    } as unknown as Request;
  }

  function createMiddleware(tokenOverride?: string | null) {
    return createMetricsEndpointMiddleware(metrics, {
      path: '/metrics',
      scrapeToken: tokenOverride === undefined ? token : tokenOverride,
    });
  }

  beforeEach(() => {
    metrics = new MetricsService();
    response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      end: jest.fn(),
    };
    next = jest.fn();
  });

  it('serves the exposition on the exact path with the registry content type', async () => {
    const middleware = createMiddleware();
    middleware(
      createRequest({ url: '/metrics', authorization: `Bearer ${token}` }),
      response as unknown as Response,
      next,
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('brinnpay_http_requests_total'));
    expect(next).not.toHaveBeenCalled();
  });

  it('passes every other path straight through', () => {
    const middleware = createMiddleware();
    const request = createRequest({ url: '/api/v1/customers' });
    middleware(request, response as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('matches on the path, not the query string', async () => {
    // Consistent with every other path consumer in the app (guard, request
    // logs): the query is not part of the match.
    const middleware = createMiddleware(null);
    middleware(createRequest({ url: '/metrics?g=0' }), response as unknown as Response, next);

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers HEAD without a body', async () => {
    const middleware = createMiddleware(null);
    middleware(createRequest({ url: '/metrics', method: 'HEAD' }), response as unknown as Response, next);

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.end).toHaveBeenCalledWith(undefined);
  });

  it('refuses other verbs with 405 and Allow', () => {
    const middleware = createMiddleware();
    middleware(createRequest({ url: '/metrics', method: 'POST' }), response as unknown as Response, next);

    expect(response.setHeader).toHaveBeenCalledWith('Allow', 'GET, HEAD');
    expect(response.status).toHaveBeenCalledWith(405);
    expect(next).not.toHaveBeenCalled();
  });

  it('requires the bearer token when one is configured (D4(a))', async () => {
    const middleware = createMiddleware();
    middleware(createRequest({ url: '/metrics' }), response as unknown as Response, next);

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(response.end).not.toHaveBeenCalledWith(expect.anything());
  });

  it('accepts the correct bearer token', async () => {
    const middleware = createMiddleware();
    middleware(
      createRequest({ url: '/metrics', authorization: `Bearer ${token}` }),
      response as unknown as Response,
      next,
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('brinnpay_'));
  });

  it('serves without any credential when no token is configured', async () => {
    const middleware = createMiddleware(null);
    middleware(createRequest({ url: '/metrics' }), response as unknown as Response, next);

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('answers 500 rather than crashing when exposition fails', async () => {
    jest.spyOn(metrics, 'render').mockRejectedValueOnce(new Error('registry broken'));
    const middleware = createMiddleware(null);
    middleware(createRequest({ url: '/metrics' }), response as unknown as Response, next);

    await new Promise((resolve) => setImmediate(resolve));
    expect(response.status).toHaveBeenCalledWith(500);
  });
});

describe('isScrapeAuthorized (phase 20 D4(a), §7)', () => {
  it('treats a null token as network trust', () => {
    expect(isScrapeAuthorized({}, null)).toBe(true);
  });

  it('accepts a matching bearer token, case-insensitively on the scheme', () => {
    const token = 'x'.repeat(40);
    expect(isScrapeAuthorized({ authorization: `Bearer ${token}` }, token)).toBe(true);
    expect(isScrapeAuthorized({ authorization: `bearer ${token}` }, token)).toBe(true);
  });

  it('rejects a wrong, absent or non-bearer credential', () => {
    const token = 'x'.repeat(40);
    expect(isScrapeAuthorized({ authorization: `Bearer ${'y'.repeat(40)}` }, token)).toBe(false);
    expect(isScrapeAuthorized({}, token)).toBe(false);
    expect(isScrapeAuthorized({ authorization: `Basic ${token}` }, token)).toBe(false);
    expect(isScrapeAuthorized({ authorization: token }, token)).toBe(false);
  });

  it('still validates when the header arrives as a one-element array', () => {
    // Express gives scalar headers, but the guard must not weaken if a
    // fronting proxy ever produces a repeated one.
    const token = 'x'.repeat(40);
    expect(isScrapeAuthorized({ authorization: [`Bearer ${token}`] }, token)).toBe(true);
    expect(isScrapeAuthorized({ authorization: [`Bearer ${'y'.repeat(40)}`] }, token)).toBe(false);
  });
});
