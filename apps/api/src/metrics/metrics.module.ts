import { Global, Module } from '@nestjs/common';

import { MetricsService } from './metrics.service';

/**
 * Phase 20 observability surface. `@Global()` so the single registry is
 * injectable anywhere without every feature module re-declaring it; imported
 * by `AppModule` and `WebhooksWorkerModule` only — the worker registers its
 * own worker-only metrics and HTTP listener in its own module.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
