import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import {
  provideRequestLogRetentionPolicy,
  RequestLogStoreService,
  REQUEST_LOG_RETENTION_POLICY,
} from './request-log-store.service';

/**
 * The durable half of the request-logging capability (phase 11 §5).
 *
 * Split from {@link RequestLoggingModule} for the same reason as the phase 10
 * webhook core: the two processes need different graphs. The API writes records
 * through it; the worker needs only the store (for the D5 retention pass)
 * without pulling in the controller, the guards, or anything the HTTP surface
 * depends on. Nothing here emits an event — request logging is deliberately
 * outside the webhook event catalog (§6).
 */
@Module({
  imports: [PrismaModule],
  providers: [
    RequestLogStoreService,
    {
      // D5: retention window and cleanup cadence, injected from configuration
      // so the API and the worker always agree on the same policy.
      provide: REQUEST_LOG_RETENTION_POLICY,
      useFactory: provideRequestLogRetentionPolicy,
      inject: [ConfigService],
    },
  ],
  exports: [RequestLogStoreService, REQUEST_LOG_RETENTION_POLICY],
})
export class RequestLoggingCoreModule {}
