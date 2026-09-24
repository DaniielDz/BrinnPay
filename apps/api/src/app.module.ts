import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import loadConfiguration from './config/configuration';
import { HealthModule } from './health/health.module';
import { buildLoggerOptions } from './logging/logger.config';
import { OrganizationsModule } from './organizations/organizations.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { RedisModule } from './redis/redis.module';

/**
 * Root application module (Phase 5). Wires the base cross-cutting
 * infrastructure (configuration, structured logging, Prisma, Redis, health
 * checks, the global error envelope) together with the auth, organizations,
 * projects, and api-keys domain modules. Remaining domain modules arrive with
 * their owning phases (6–13).
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
    HealthModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    ApiKeysModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {}