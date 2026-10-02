import { BullModule } from '@nestjs/bullmq';
import { Inject, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from '../auth/auth.module';
import loadConfiguration from '../config/configuration';
import { buildLoggerOptions } from '../logging/logger.config';
import { PaymentsModule } from '../payments/payments.module';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RequestLoggingCoreModule } from '../request-logging/request-logging-core.module';
import {
  REQUEST_LOG_CLEANUP_JOB,
  REQUEST_LOG_RETENTION_POLICY,
  type RequestLogRetentionPolicy,
} from '../request-logging/request-log-store.service';
import { WebhookMaintenanceService } from './webhook-maintenance.service';
import {
  parseRedisUrl,
  provideJobRetention,
  WebhookQueueService,
} from './webhook-queue.service';
import { WebhookProcessor } from './webhook.processor';
import { WEBHOOK_QUEUE_NAME } from './webhook-queue';
import { WebhooksCoreModule } from './webhooks-core.module';

/**
 * The worker composition root (phase 10 §5.3, D14).
 *
 * The worker is a **separate process** with its own entrypoint, so the API never
 * consumes the queue: delivery latency, destination failure modes, and the
 * periodic passes stay off the request-serving path, and a second API replica can
 * be started without duplicating consumers.
 *
 * It reuses {@link WebhooksCoreModule}'s services (event persistence, the queue
 * producer, the delivery executor) and adds the consumer plus the maintenance
 * passes. It imports `PaymentsModule` for one reason only: the advancement sweep
 * needs the payments module's compare-and-set advancement, and the payments
 * module must never import the worker — the dependency is one-directional.
 *
 * It deliberately imports the **core** module, not `WebhooksModule`: a worker is
 * not a server, so the controller, the dual-mode access guard, and the
 * authentication stack they depend on stay out of this process (D14).
 *
 * Configuration, structured logging, and Prisma are wired here rather than
 * inherited from `AppModule` because the worker is a different application
 * context: it must not boot the HTTP surface or the readiness contract
 * (Phase 2 D9) — readiness is about serving requests, not about the health of the
 * queue (Phase 20 owns worker observability).
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
    /**
     * `@nestjs/bullmq` builds the `Worker` for {@link WebhookProcessor} from the
     * module's root configuration: without this registration the decorated class
     * is instantiated but **nothing consumes the queue**, and delivery jobs
     * accumulate in `wait` until the queue grows unbounded. It is the worker's
     * only Bull registration — the API process deliberately never imports it, so
     * it cannot consume (D14).
     *
     * The connection comes from the same `REDIS_URL` and the same parser the
     * producer uses, so producer and consumer always agree on host, port,
     * credentials, TLS, and database index.
     */
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: parseRedisUrl(config.get<string>('redisUrl') ?? 'redis://localhost:6379'),
      }),
    }),
    // `registerQueue` is what installs the registrar that builds the `Worker`
    // for a `@Processor` class; the root configuration above only supplies its
    // connection. Registering the queue under the shared name also keeps the
    // worker's queue prefix and options identical to the producer's — including
    // the job-retention defaults, which both ends must agree on or Redis grows
    // without bound on whichever side adds the job.
    BullModule.registerQueueAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        name: WEBHOOK_QUEUE_NAME,
        defaultJobOptions: provideJobRetention(config),
      }),
    }),
    // The advancement sweep needs `PaymentsService`, and a Nest module carries
    // its whole provider graph: importing `PaymentsModule` therefore also brings
    // its route guard, whose session dependency is the global `AuthModule`. The
    // worker never authenticates anybody, but the import keeps the graph
    // resolvable without splitting a phase 7 module (phase 10 §14 keeps the
    // payments/refunds change limited to event emission).
    AuthModule,
    // Redis connectivity is global in the API process and is what BullMQ itself
    // runs on; the worker needs the same shared connection capability.
    RedisModule,
    PaymentsModule,
    WebhooksCoreModule,
    // The request-log retention pass (phase 11 D5) runs in this process as one
    // more scheduled job on the shared queue (§14: schedule alongside Phase
    // 10's maintenance rather than adding a job runner). The core module is
    // enough — a worker never serves HTTP, so the capture middleware and the
    // read controller stay out of this graph.
    RequestLoggingCoreModule,
  ],
  providers: [WebhookProcessor, WebhookMaintenanceService],
})
export class WebhooksWorkerModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhooksWorkerModule.name);

  constructor(
    private readonly maintenance: WebhookMaintenanceService,
    private readonly queue: WebhookQueueService,
    @Inject(REQUEST_LOG_RETENTION_POLICY)
    private readonly requestLogPolicy: RequestLogRetentionPolicy,
  ) {}

  /**
   * Registers the repeatable passes after the consumer is up. A registration
   * failure is logged and swallowed by the queue service; the next worker start
   * retries, and a worker that never registers simply does not run the passes.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.maintenance.registerSchedule();
    await this.queue.ensureScheduler(
      REQUEST_LOG_CLEANUP_JOB,
      this.requestLogPolicy.cleanupIntervalMs,
    );
    this.logger.log(`Webhook worker consuming the "${WEBHOOK_QUEUE_NAME}" queue.`);
  }
}
