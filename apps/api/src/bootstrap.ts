import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { createValidationPipe } from './common/validation/validation';
import { requestIdMiddleware } from './request-id/request-id.middleware';

/**
 * Applies the Phase 2 cross-cutting base to an application instance. Shared by
 * `main.ts` and the e2e test bootstrap so both exercise identical wiring.
 */
export function configureApp(app: INestApplication, config: ConfigService): void {
  app.use(requestIdMiddleware);

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
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['health/live', 'health/ready'],
  });

  app.useGlobalPipes(createValidationPipe());
}
