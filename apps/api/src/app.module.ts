import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuditLoggingModule } from './audit-logging/audit-logging.module';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { CustomersModule } from './customers/customers.module';
import loadConfiguration from './config/configuration';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { buildLoggerOptions } from './logging/logger.config';
import { OrganizationsModule } from './organizations/organizations.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { RateLimitGuard } from './rate-limiting/rate-limit.guard';
import { RateLimitingModule } from './rate-limiting/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { RefundsModule } from './refunds/refunds.module';
import { RequestLoggingModule } from './request-logging/request-logging.module';
import { ProjectScopeModule } from './common/project-scope/project-scope.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Root application module (Phase 8). Wires the base cross-cutting
 * infrastructure (configuration, structured logging, Prisma, Redis, health
 * checks, the global error envelope, idempotency, rate limiting) together with
 * the auth, organizations, projects, api-keys, customers, payments, refunds,
 * webhooks, request-logging and audit-logging domain modules.
 *
 * The webhook **worker** is deliberately absent (D14): it is a separate process
 * with its own entrypoint (`worker.ts`) so the API only enqueues. `WebhooksModule`
 * itself is registered here because the payments and refunds modules bind the
 * durable event port through it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfiguration],
      cache: true,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildLoggerOptions({
          logLevel: config.get<string>('logLevel') ?? 'info',
          nodeEnv: config.get<string>('nodeEnv') ?? 'development',
        }),
    }),
    PrismaModule,
    RedisModule,
    IdempotencyModule,
    RateLimitingModule,
    HealthModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    ApiKeysModule,
    CustomersModule,
    PaymentsModule,
    RefundsModule,
    ProjectScopeModule,
    WebhooksModule,
    RequestLoggingModule,
    AuditLoggingModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    {
      // Phase 13 §4.3 stage 1. Global so it precedes **every** route
      // authentication and runs before any database work; the stage-2 API-key
      // point is a per-route guard exported by `RateLimitingModule`.
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule {}
