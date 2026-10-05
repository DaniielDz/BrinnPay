import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import type { BrinnPayConfig } from '../config/configuration';
import { RateLimit } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitService } from './rate-limit.service';

/**
 * Stage 0 + stage 1 of the enforcement order (phase 13 §4.3).
 *
 * The two properties that matter are proven here: the exclusions are decided from
 * the path and method **before any Redis work**, and the `ip` check runs on a
 * route whose authentication would otherwise reject the request — so an
 * unauthenticated flood is bounded without a database lookup (AC2/AC9).
 */
describe('RateLimitGuard (phase 13 §4.3 stages 0-1)', () => {
  const reflector = new Reflector();
  let enforce: jest.Mock;

  const config = {
    rateLimit: { trustedProxyHops: 0, trustedProxyCidrs: [] },
  } as unknown as BrinnPayConfig;

  function guardFor(trust: Partial<BrinnPayConfig['rateLimit']> = {}): RateLimitGuard {
    const merged = {
      rateLimit: { ...config.rateLimit, ...trust },
    } as unknown as BrinnPayConfig;
    return new RateLimitGuard(
      reflector,
      { getOrThrow: () => merged.rateLimit } as unknown as ConfigService,
      { scopesFor: () => ['ip'], enforce } as unknown as RateLimitService,
    );
  }

  function contextFor(options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    peer?: string;
  }) {
    const request = {
      method: options.method ?? 'GET',
      originalUrl: options.url ?? '/api/v1/projects',
      headers: options.headers ?? {},
      socket: { remoteAddress: options.peer ?? '203.0.113.7' },
    };
    const response = { setHeader: jest.fn() };
    return {
      request,
      response,
      context: {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
        getHandler: () => Declared.prototype.list,
        getClass: () => Declared,
      } as unknown as ExecutionContext,
    };
  }

  @Controller('projects')
  class Declared {
    @Get()
    @RateLimit('read')
    list(): void {}
  }

  @Controller('legacy')
  class Undeclared {
    @Get()
    list(): void {}
  }

  beforeEach(() => {
    enforce = jest.fn().mockResolvedValue(undefined);
  });

  it('counts an ordinary API request against the ip bucket', async () => {
    const { context } = contextFor({ url: '/api/v1/projects' });

    await expect(guardFor().canActivate(context)).resolves.toBe(true);

    expect(enforce).toHaveBeenCalledTimes(1);
    const [, , routeClass, scopes, discriminators] = enforce.mock.calls[0];
    expect(routeClass).toBe('read');
    expect(scopes).toEqual(['ip']);
    expect(discriminators).toEqual({ ip: '203.0.113.7' });
  });

  it('never counts anything outside the API prefix (stage 0)', async () => {
    for (const url of ['/health/live', '/health/ready', '/docs', '/docs/swagger-ui.css', '/']) {
      const { context } = contextFor({ url });
      await expect(guardFor().canActivate(context)).resolves.toBe(true);
    }
    expect(enforce).not.toHaveBeenCalled();
  });

  it('never counts a CORS preflight, and never throttles one (stage 0)', async () => {
    const { context } = contextFor({
      method: 'OPTIONS',
      url: '/api/v1/projects',
      headers: {
        'access-control-request-method': 'GET',
        origin: 'http://localhost:3001',
      },
    });

    await expect(guardFor().canActivate(context)).resolves.toBe(true);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('still counts a real OPTIONS on an API route', async () => {
    // The contract's method enum includes OPTIONS, so it is API traffic.
    const { context } = contextFor({ method: 'OPTIONS', url: '/api/v1/projects' });
    await expect(guardFor().canActivate(context)).resolves.toBe(true);
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it('resolves the client identity under the configured proxy trust (D1)', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    const untrusted = contextFor({ url: '/api/v1/projects', headers, peer: '10.0.0.1' });
    await guardFor().canActivate(untrusted.context);
    expect(enforce.mock.calls[0][4]).toEqual({ ip: '10.0.0.1' });

    enforce.mockClear();
    const trusted = contextFor({ url: '/api/v1/projects', headers, peer: '10.0.0.1' });
    await guardFor({ trustedProxyHops: 1, trustedProxyCidrs: ['10.0.0.0/8'] }).canActivate(
      trusted.context,
    );
    expect(enforce.mock.calls[0][4]).toEqual({ ip: '203.0.113.7' });

    // A hop count without an allowlist is refused at boot; a hand-built trust
    // object must not be able to re-open it, or the forwarded entry would be
    // the one the caller chose (D1).
    enforce.mockClear();
    const hopsOnly = contextFor({ url: '/api/v1/projects', headers, peer: '10.0.0.1' });
    await guardFor({ trustedProxyHops: 1 }).canActivate(hopsOnly.context);
    expect(enforce.mock.calls[0][4]).toEqual({ ip: '10.0.0.1' });
  });

  it('still counts a request whose client identity cannot be resolved', async () => {
    // An empty discriminator would skip counting entirely and leave the request
    // unlimited; such requests share one bounded bucket instead (phase 3 posture).
    const { context } = contextFor({ url: '/api/v1/projects', peer: '' });

    await expect(guardFor().canActivate(context)).resolves.toBe(true);

    expect(enforce).toHaveBeenCalledTimes(1);
    expect(enforce.mock.calls[0][4]).toEqual({ ip: 'unresolved' });
  });

  it('fails loudly for a route that declares no class (AC5)', async () => {
    const request = { method: 'GET', originalUrl: '/api/v1/legacy', headers: {}, socket: {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: jest.fn() }) }),
      getHandler: () => Undeclared.prototype.list,
      getClass: () => Undeclared,
    } as unknown as ExecutionContext;

    await expect(guardFor().canActivate(context)).rejects.toThrow(/must declare its rate-limit class/);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('surfaces the 429 raised by the enforcement point unchanged', async () => {
    enforce.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));

    const { context } = contextFor({ url: '/api/v1/projects' });
    await expect(guardFor().canActivate(context)).rejects.toMatchObject({ status: 429 });
  });
});