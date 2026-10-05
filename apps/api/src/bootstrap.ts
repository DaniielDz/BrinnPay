import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { createValidationPipe } from './common/validation/validation';
import { requestIdMiddleware } from './request-id/request-id.middleware';
import { API_GLOBAL_PREFIX } from './request-logging/request-log-record';
import { RATE_LIMIT_EXPOSED_HEADERS } from './rate-limiting/rate-limit.service';

/**
 * Routes kept out of the `/api/v1` prefix (Phase 2 D9). They are operational
 * endpoints, not contracted API traffic, so they are neither recorded as request
 * logs (Phase 11 D7) nor rate limited (Phase 13 §4.3 stage 0). Exported so the
 * boot-time route test reads the same list the router is built from.
 */
export const GLOBAL_PREFIX_EXCLUSIONS = ['health/live', 'health/ready'] as const;

/**
 * Applies the Phase 2/3 cross-cutting base to an application instance. Shared
 * by `main.ts` and the e2e test bootstrap so both exercise identical wiring.
 */
export function configureApp(app: INestApplication, config: ConfigService): void {
  app.use(requestIdMiddleware);

  // Cookie parsing for the refresh session (`brinnpay_refresh` HttpOnly cookie
  // on /api/v1/auth, phase 3 §4.3). Only parses; cookies remain opaque to JS.
  app.use(cookieParser());

  // Basic API security headers (phase 1 §10). CSP is disabled because Swagger
  // UI relies on inline assets; web security headers are a Phase 14 concern.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: config.get<string[]>('corsOrigins'),
    credentials: true,
    // Phase 13 §4.4 point 6: the limit headers are only readable by
    // cross-origin browser JavaScript when they are exposed here, which is what
    // lets the dashboard show a remaining-budget indicator. Only these
    // non-secret budget fields are exposed; the exposure grants no access to any
    // identity, key or internal name.
    exposedHeaders: RATE_LIMIT_EXPOSED_HEADERS,
  });

  // The same constant decides which requests are persisted as request logs
  // (phase 11 D7), so routing and recording can never disagree about what the
  // API surface is.
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: [...GLOBAL_PREFIX_EXCLUSIONS],
  });

  app.useGlobalPipes(createValidationPipe());
}
