import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { isRateLimitClass, type RateLimitClass } from './rate-limit-classes';

export const RATE_LIMIT_CLASS_METADATA = 'brinnpay:rateLimit:class';

/**
 * Declares the route class of an operation (phase 13 §4.2 rule 2, D6).
 *
 * A domain module declares **only** the class: the limit, window, Redis key and
 * response headers all come from the shared policy. A class may be declared per
 * route or per controller; a handler declaration wins over a controller one.
 *
 * A route with **no** declared class is a programming error and fails loudly at
 * enforcement time (see {@link resolveRateLimitClass}) rather than being silently
 * unlimited — the same precedent as `@RequireCapability` in phase 4 and phase 10.
 *
 * The class name is validated at declaration time, so a typo fails when the
 * module is loaded instead of when the first request arrives.
 */
export function RateLimit(routeClass: RateLimitClass): MethodDecorator & ClassDecorator {
  if (!isRateLimitClass(routeClass)) {
    throw new Error(
      `@RateLimit received "${String(routeClass)}", which is not in the closed class catalog`,
    );
  }
  return SetMetadata(RATE_LIMIT_CLASS_METADATA, routeClass);
}

/**
 * Resolves the route class of the operation being executed: handler declaration
 * first, then the controller's. Throws when neither declares one, so an
 * unclassified route is a loud failure rather than an unlimited one (AC5).
 */
export function resolveRateLimitClass(
  reflector: Reflector,
  context: ExecutionContext,
): RateLimitClass {
  const routeClass = reflector.getAllAndOverride<RateLimitClass | undefined>(
    RATE_LIMIT_CLASS_METADATA,
    [context.getHandler(), context.getClass()],
  );

  if (!isRateLimitClass(routeClass)) {
    throw new Error(
      'Every contracted route must declare its rate-limit class with @RateLimit; ' +
        `"${context.getClass().name}.${context.getHandler().name}" declares none`,
    );
  }

  return routeClass;
}