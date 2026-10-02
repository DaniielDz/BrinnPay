import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
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
import { RedisModule } from './redis/redis.module';
import { RefundsModule } from './refunds/refunds.module';
import { ProjectScopeModule } from './common/project-scope/project-scope.module';
import { WebhooksModule } from './webhooks/webhooks.module';

/**
 * Root application module (Phase 8). Wires the base cross-cutting
 * infrastructure (configuration, structured logging, Prisma, Redis, health
 * checks, the global error envelope, idempotency) together with the auth,
 * organizations, projects, api-keys, customers, payments, refunds, and webhooks
 * domain modules. Request logs, audit logs, and rate limiting arrive with their
 * owning phases (11–13).
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
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {}
