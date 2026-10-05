import { Controller, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimit } from '../rate-limiting/rate-limit.decorator';
import { AuthRateLimitGuard } from './rate-limit.guard';
import type { RateLimitService } from '../rate-limiting/rate-limit.service';

/**
 * The phase 3 per-account limiter as a thin consumer (phase 13 §15, AC10/D9). Its
 * behavior is unchanged: it applies the **`account`** dimension of
 * `auth.session-creation` and nothing else — the `ip` dimension is staged for
 * every request by the global pre-authentication guard, so counting it here too
 * would charge an authenticated client twice per attempt.
 */
describe('AuthRateLimitGuard (phase 13 §15, D9/D10)', () => {
  const reflector = new Reflector();
  let enforce: jest.Mock;

  @Controller('auth')
  class Auth {
    @Post('login')
    @RateLimit('auth.session-creation')
    login(): void {}

    @Post('refresh')
    @RateLimit('auth.refresh')
    refresh(): void {}
  }

  function contextFor(handler: object, body?: unknown): ExecutionContext {
    const request = { headers: {}, body };
    const response = { setHeader: jest.fn() };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => handler,
      getClass: () => Auth,
    } as unknown as ExecutionContext;
  }

  function guardFor(): AuthRateLimitGuard {
    return new AuthRateLimitGuard(reflector, {
      scopesFor: (routeClass: string) =>
        routeClass === 'auth.session-creation' ? ['ip', 'account'] : ['ip'],
      enforce,
    } as unknown as RateLimitService);
  }

  beforeEach(() => {
    enforce = jest.fn().mockResolvedValue(undefined);
  });

  it('counts the normalized account email on a session-creation route', async () => {
    await expect(
      guardFor().canActivate(contextFor(Auth.prototype.login, { email: '  Someone@Example.COM ' })),
    ).resolves.toBe(true);

    expect(enforce).toHaveBeenCalledTimes(1);
    const [, , routeClass, scopes, discriminators] = enforce.mock.calls[0];
    expect(routeClass).toBe('auth.session-creation');
    expect(scopes).toEqual(['account']);
    // Normalized before hashing, so the same account cannot hold two budgets.
    expect(discriminators).toEqual({ account: 'someone@example.com' });
  });

  it('does not count the ip dimension, which the global guard already staged', async () => {
    await guardFor().canActivate(contextFor(Auth.prototype.login, { email: 'someone@example.com' }));
    expect(enforce.mock.calls[0][3]).toEqual(['account']);
  });

  it('does not count a route whose class has no account dimension', async () => {
    await expect(
      guardFor().canActivate(contextFor(Auth.prototype.refresh, { email: 'someone@example.com' })),
    ).resolves.toBe(true);
    expect(enforce).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { email: '' }, { email: 42 }, { email: null }])(
    'counts nothing when the request carries no usable email (%p)',
    async (body) => {
      await expect(guardFor().canActivate(contextFor(Auth.prototype.login, body))).resolves.toBe(true);
      expect(enforce).not.toHaveBeenCalled();
    },
  );

  it('surfaces the 429 raised by the enforcement point unchanged', async () => {
    enforce.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    await expect(
      guardFor().canActivate(contextFor(Auth.prototype.login, { email: 'someone@example.com' })),
    ).rejects.toMatchObject({ status: 429 });
  });
});