import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { RequestLoggingCoreModule } from './request-logging-core.module';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { RequestLogsController } from './request-logs.controller';
import { RequestLogsService } from './request-logs.service';

/**
 * The request-logging capability (phase 11 §4.1): capture, persistence, and the
 * contracted read surface.
 *
 * Three responsibilities, one module (§4.1):
 *
 * 1. **Capture** — {@link RequestLoggingMiddleware} wraps every request under
 *    the `/api/v1` prefix and writes one record after the response completes.
 * 2. **Persistence** — {@link RequestLoggingCoreModule} owns the `request_logs`
 *    rows and their retention cleanup.
 * 3. **Read surface** — {@link RequestLogsController} serves the session-only
 *    `logs.listRequestLogs` operation.
 *
 * Domain modules never touch any of this: capture is driven by the application
 * request lifecycle, not by a domain service, and the module reads nothing
 * beyond context the guards already resolved (§14).
 */
@Module({
  imports: [RequestLoggingCoreModule],
  controllers: [RequestLogsController],
  providers: [RequestLogsService, RequestLoggingMiddleware],
})
export class RequestLoggingModule implements NestModule {
  /**
   * Applied to every route rather than to the controller: §4.2 rule 1 requires
   * a record for *every* request under the prefix — including the ones rejected
   * by a guard or the validation pipe before any handler runs. The prefix scope
   * itself is enforced here (D7) as well as by the router's global prefix.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
  }
}
