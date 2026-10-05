import { Controller, Get, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimit, RATE_LIMIT_CLASS_METADATA, resolveRateLimitClass } from './rate-limit.decorator';

/**
 * Route-class resolution (phase 13 §4.2 rule 2, AC5): the mapping is declared
 * once, centrally, and a route that declares nothing fails loudly rather than
 * being silently unlimited.
 */
describe('@RateLimit / resolveRateLimitClass', () => {
  const reflector = new Reflector();

  /** Mirrors Nest's `ExecutionContext`: the handler function and the class itself. */
  function contextFor(handler: object, controller: object): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controller,
    } as unknown as ExecutionContext;
  }

  @Controller('things')
  class Mixed {
    @Get()
    @RateLimit('read')
    read(): void {}

    @Post()
    @RateLimit('write')
    write(): void {}
  }

  @Controller('uniform')
  @RateLimit('read')
  class Uniform {
    @Get()
    list(): void {}
  }

  @Controller('override')
  @RateLimit('read')
  class Overridden {
    @Post()
    @RateLimit('write')
    create(): void {}
  }

  @Controller('undeclared')
  class Undeclared {
    @Get()
    @Post()
    orphan(): void {}
  }

  it('resolves the class a handler declares', () => {
    expect(resolveRateLimitClass(reflector, contextFor(Mixed.prototype.read, Mixed))).toBe('read');
    expect(resolveRateLimitClass(reflector, contextFor(Mixed.prototype.write, Mixed))).toBe('write');
  });

  it('falls back to the controller declaration', () => {
    expect(resolveRateLimitClass(reflector, contextFor(Uniform.prototype.list, Uniform))).toBe('read');
  });

  it('prefers the handler declaration over the controller one', () => {
    expect(resolveRateLimitClass(reflector, contextFor(Overridden.prototype.create, Overridden))).toBe(
      'write',
    );
  });

  it('fails loudly for a route with no declared class (AC5)', () => {
    expect(() =>
      resolveRateLimitClass(reflector, contextFor(Undeclared.prototype.orphan, Undeclared)),
    ).toThrow(/must declare its rate-limit class/);
  });

  it('stores the class under a namespaced metadata key', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_METADATA, Mixed.prototype.read)).toBe('read');
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_METADATA, Uniform)).toBe('read');
  });

  it('rejects a class outside the catalog at declaration time', () => {
    // A typo must fail when the module loads, not when the first request arrives.
    expect(() => RateLimit('delete-everything' as never)).toThrow(/closed class catalog/);
    expect(() => RateLimit(undefined as never)).toThrow(/closed class catalog/);
  });
});