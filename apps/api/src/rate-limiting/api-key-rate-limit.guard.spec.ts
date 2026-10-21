import { Controller, Get, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { ApiKeyContext } from '../api-keys/api-key-context';
import { ApiKeyRateLimitGuard } from './api-key-rate-limit.guard';
import { RateLimit } from './rate-limit.decorator';
import type { RateLimitService } from './rate-limit.service';

/**
 * Stage 2 (phase 13 §4.3, D7/D5): the API-key budget, applied only once a key has
 * resolved and only on the classes that declare the scope. The domain access
 * guards are untouched — this is a second guard on the same route.
 */
describe('ApiKeyRateLimitGuard (phase 13 §4.3 stage 2)', () => {
  const reflector = new Reflector();
  let enforce: jest.Mock;

  const KEY_ID = '0192f2a0-0000-7000-8000-000000000004';

  @Controller('projects/:project_id/customers')
  class Customers {
    @Get()
    @RateLimit('read')
    list(): void {}

    @Post()
    @RateLimit('write')
    create(): void {}
  }

  function contextFor(handler: object, apiKey?: Partial<ApiKeyContext>): ExecutionContext {
    const request = { headers: {}, ...(apiKey ? { apiKey } : {}) };
    const response = { setHeader: jest.fn() };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => handler,
      getClass: () => Customers,
    } as unknown as ExecutionContext;
  }

  function guardFor(scopesOf: Record<string, string[]>): ApiKeyRateLimitGuard {
    return new ApiKeyRateLimitGuard(reflector, {
      scopesFor: (routeClass: string) => scopesOf[routeClass] ?? [],
      enforce,
    } as unknown as RateLimitService);
  }

  const SCOPES = { read: ['ip'], write: ['ip', 'api_key'] };

  beforeEach(() => {
    enforce = jest.fn().mockResolvedValue(undefined);
  });

  it('counts an API-key-authenticated mutation against the key budget', async () => {
    await expect(
      guardFor(SCOPES).canActivate(contextFor(Customers.prototype.create, { key_id: KEY_ID })),
    ).resolves.toBe(true);

    expect(enforce).toHaveBeenCalledTimes(1);
    const [, , routeClass, scopes, discriminators] = enforce.mock.calls[0];
    expect(routeClass).toBe('write');
    expect(scopes).toEqual(['api_key']);
    // The key **id** scopes the bucket; the presented plaintext never appears.
    expect(discriminators).toEqual({ api_key: KEY_ID });
  });

  it('counts nothing in session mode, where stage 1 alone applies (D5)', async () => {
    await expect(guardFor(SCOPES).canActivate(contextFor(Customers.prototype.create))).resolves.toBe(
      true,
    );
    expect(enforce).not.toHaveBeenCalled();
  });

  it('does not stage the key budget on a class that does not declare it', async () => {
    await expect(
      guardFor(SCOPES).canActivate(contextFor(Customers.prototype.list, { key_id: KEY_ID })),
    ).resolves.toBe(true);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('refuses to count an empty key id', async () => {
    await expect(
      guardFor(SCOPES).canActivate(contextFor(Customers.prototype.create, { key_id: '' })),
    ).resolves.toBe(true);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('surfaces the 429 raised by the enforcement point unchanged', async () => {
    enforce.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    await expect(
      guardFor(SCOPES).canActivate(contextFor(Customers.prototype.create, { key_id: KEY_ID })),
    ).rejects.toMatchObject({ status: 429 });
  });
});