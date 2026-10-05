import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import 'reflect-metadata';

import { AppModule } from '../src/app.module';
import { GLOBAL_PREFIX_EXCLUSIONS, configureApp } from '../src/bootstrap';
import { ApiKeyAuthGuard } from '../src/api-keys/api-key-auth.guard';
import { CustomersAccessGuard } from '../src/customers/customers-access.guard';
import { PaymentsAccessGuard } from '../src/payments/payments-access.guard';
import { RefundsAccessGuard } from '../src/refunds/refunds-access.guard';
import { ProjectAccessGuard } from '../src/common/project-scope/project-access.guard';
import { ApiKeyRateLimitGuard } from '../src/rate-limiting/api-key-rate-limit.guard';
import { isRateLimitClass, type RateLimitClass } from '../src/rate-limiting/rate-limit-classes';
import { RATE_LIMIT_CLASS_METADATA } from '../src/rate-limiting/rate-limit.decorator';

/**
 * The guards that can resolve an API key onto `request.apiKey`. A route guarded
 * by one of them is reachable in API-key mode, so it must register the stage-2
 * enforcement point; a route guarded only by session guards is not, and needs no
 * `api_key` bucket (D5, D7).
 *
 * This is derived from the guards rather than from a list of routes, so adding a
 * route to a dual-mode controller is covered the moment it is written.
 */
const API_KEY_CAPABLE_GUARDS: readonly unknown[] = [
  ApiKeyAuthGuard,
  ProjectAccessGuard,
  CustomersAccessGuard,
  PaymentsAccessGuard,
  RefundsAccessGuard,
];

/**
 * Boot-time coverage of the route-class declaration (phase 13 §4.2 rule 2, AC5).
 *
 * `resolveRateLimitClass` only throws when traffic arrives, so nothing in the
 * repository's own checks would notice a route that declares no class: lint,
 * typecheck and build pass, and the first production request to that route 500s.
 * This suite therefore boots the real application and walks its route table.
 *
 * It asserts three invariants:
 *
 * 1. **Every routed operation under the API prefix declares exactly one class
 *    from the catalog** — so "unlimited" is always an explicit, reviewable
 *    choice, and a typo'd class is caught rather than resolved at request time.
 * 2. **A route reachable in API-key mode registers the stage-2 guard** — a route
 *    that accepts a key but omits `ApiKeyRateLimitGuard` would silently enforce
 *    nothing on that dimension (the scope the class declares would be a lie).
 * 3. **Stage 2 runs after the guard that resolves the key** — before the key is
 *    attached there is no `key_id` to key the bucket on (D7).
 *
 * Route metadata is read the way Nest reads it, so the suite tracks the
 * application graph rather than a hand-maintained list of routes.
 */
jest.setTimeout(60_000);

interface RouteUnderTest {
  /** `Controller.method`, as Nest reports it in a failure message. */
  name: string;
  /** Composed path, for the failure message. */
  path: string;
  routeClass: RateLimitClass | null;
  guards: unknown[];
}

describe('route-class declarations (Phase 13 §4.2 rule 2, AC5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function guardsOf(target: object): unknown[] {
    const methodGuards = Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined;
    const controllerGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      Object.getPrototypeOf(target),
    ) as unknown[] | undefined;
    return [...(controllerGuards ?? []), ...(methodGuards ?? [])];
  }

  /** Every routed method of every controller, skipping the prefix exclusions. */
  function routedOperations(): RouteUnderTest[] {
    const excluded = new Set(
      GLOBAL_PREFIX_EXCLUSIONS.map((path) => path.split('/')[0] as string),
    );
    const routes: RouteUnderTest[] = [];

    for (const module of app.get(ModulesContainer).values()) {
      // `Module.controllers` is a `Map<InjectionToken, InstanceWrapper>` whose
      // key is the controller class: path and method metadata live on the token,
      // not on the wrapper the value points at.
      for (const [token] of module.controllers) {
        if (typeof token !== 'function') {
          continue;
        }
        const controller = token;
        const prototype = controller.prototype as object | undefined;
        const controllerPath = (Reflect.getMetadata(PATH_METADATA, controller) ?? '') as string;
        if (prototype === undefined || excluded.has(controllerPath)) {
          continue;
        }

        // `getOwnPropertyNames` yields strings, so each is read off the prototype
        // rather than destructured — a tuple destructure would take the first two
        // *characters* of the method name. The descriptor is read instead of the
        // property so that a getter on the controller is never invoked: only data
        // properties can be route handlers anyway.
        for (const key of Object.getOwnPropertyNames(prototype)) {
          const handler = Object.getOwnPropertyDescriptor(prototype, key)?.value;
          if (key === 'constructor' || typeof handler !== 'function') {
            continue;
          }
          const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
          if (typeof methodPath !== 'string' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
            continue;
          }

          // Same resolution order as `resolveRateLimitClass`: the handler
          // declares, the controller is the fallback.
          const declared =
            Reflect.getMetadata(RATE_LIMIT_CLASS_METADATA, handler) ??
            Reflect.getMetadata(RATE_LIMIT_CLASS_METADATA, controller);
          routes.push({
            name: `${controller.name}.${key}`,
            path: `/${[controllerPath, methodPath]
              .flatMap((part) => part.split('/'))
              .filter((part) => part.length > 0)
              .join('/')}`,
            routeClass: (declared ?? null) as RateLimitClass | null,
            guards: guardsOf(handler),
          });
        }
      }
    }

    return routes;
  }

  it('finds the contracted surface', () => {
    // A walker that silently found nothing would make every assertion below vacuous.
    expect(routedOperations().length).toBeGreaterThanOrEqual(46);
  });

  it('declares exactly one rate-limit class on every operation under the prefix', () => {
    const undeclared = routedOperations()
      .filter((route) => !isRateLimitClass(route.routeClass))
      .map((route) => `${route.name} (${route.path}) → ${String(route.routeClass)}`);

    expect(undeclared).toEqual([]);
  });

  it('registers the API-key enforcement point wherever the route can resolve a key', () => {
    const unguarded = routedOperations()
      .filter((route) => route.guards.some((guard) => API_KEY_CAPABLE_GUARDS.includes(guard)))
      .filter((route) => !route.guards.includes(ApiKeyRateLimitGuard))
      .map((route) => `${route.name} (${route.path}) → ${String(route.routeClass)}`);

    expect(unguarded).toEqual([]);
  });

  it('runs the API-key enforcement point after the guard that resolves the key', () => {
    // Stage 2 keys its bucket on `request.apiKey.key_id`, which the access guard
    // attaches; running before it would charge the wrong dimension or none.
    const wrongOrder = routedOperations()
      .filter((route) => route.guards.includes(ApiKeyRateLimitGuard))
      .filter((route) => {
        const rateLimitIndex = route.guards.indexOf(ApiKeyRateLimitGuard);
        const accessIndex = route.guards.findIndex((guard) =>
          API_KEY_CAPABLE_GUARDS.includes(guard),
        );
        return accessIndex !== -1 && accessIndex > rateLimitIndex;
      })
      .map((route) => `${route.name} (${route.path})`);

    expect(wrongOrder).toEqual([]);
  });

  it('scopes the API-key enforcement point to routes that can actually take a key', () => {
    // The inverse of the ordering guard: a route with no API-key-capable guard
    // must not carry stage 2, or it would charge a bucket that never exists.
    const spurious = routedOperations()
      .filter((route) => route.guards.includes(ApiKeyRateLimitGuard))
      .filter((route) => !route.guards.some((guard) => API_KEY_CAPABLE_GUARDS.includes(guard)))
      .map((route) => `${route.name} (${route.path})`);

    expect(spurious).toEqual([]);
  });
});
