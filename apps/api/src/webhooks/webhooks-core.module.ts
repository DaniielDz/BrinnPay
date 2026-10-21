import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { WEBHOOK_EVENT_PORT } from './webhook-events';
import { WEBHOOK_SECRET_KEY } from './webhook-crypto';
import {
  provideDeliveryPolicy,
  provideJobRetention,
  WebhookQueueService,
  WEBHOOK_DELIVERY_POLICY,
  WEBHOOK_JOB_RETENTION,
} from './webhook-queue.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookEventService } from './webhook-event.service';
import { WEBHOOK_DESTINATIONS } from './webhook-url';

/**
 * The webhook **core** (phase 10 §4.1): event persistence, the queue producer,
 * and the delivery executor — everything that is not an HTTP surface.
 *
 * It is a module of its own because the two consumers need different graphs:
 *
 * - the API process serves `WebhooksController` on top of these services;
 * - the worker process (D14) needs them **without** the controller, the
 *   dual-mode guard, or anything those pull in (the API-key and session
 *   authentication stack). A worker is not a server: it must not boot an HTTP
 *   surface or depend on a JWT secret it never uses.
 *
 * Emitters (payments, refunds) import this module too, because
 * {@link WEBHOOK_EVENT_PORT} lives here: an emitting module depends on the
 * persistence boundary only, never on the endpoint registry that the API owns.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    WebhookEventService,
    WebhookDeliveryService,
    WebhookQueueService,
    {
      // The single inbound boundary the emitting modules call (D2): durable,
      // transactional persistence plus best-effort scheduling.
      provide: WEBHOOK_EVENT_PORT,
      useExisting: WebhookEventService,
    },
    {
      // AES-256-GCM key protecting endpoint signing secrets at rest (D8),
      // validated at boot by the configuration loader.
      provide: WEBHOOK_SECRET_KEY,
      useFactory: (config: ConfigService) => config.get<Buffer>('webhooks.secretEncryptionKey'),
      inject: [ConfigService],
    },
    {
      provide: WEBHOOK_DELIVERY_POLICY,
      useFactory: (config: ConfigService) => provideDeliveryPolicy(config),
      inject: [ConfigService],
    },
    {
      // Bounded job retention, applied to every job the producer adds. Declared
      // once so the API's queue, the worker's queue, and the periodic schedulers
      // cannot disagree about how long a finished job survives in Redis.
      provide: WEBHOOK_JOB_RETENTION,
      useFactory: (config: ConfigService) => provideJobRetention(config),
      inject: [ConfigService],
    },
    {
      // Destination policy is a runtime control and must be enforced at delivery
      // time, not only at registration (ADR-0019). The worker and the API share
      // it via the core module so a denylist change takes effect immediately on
      // in-flight attempts.
      provide: WEBHOOK_DESTINATIONS,
      useFactory: (config: ConfigService) =>
        config.get<{ allowlist?: string[]; denylist?: string[] }>('webhooks.destinations') ?? {},
      inject: [ConfigService],
    },
  ],
  exports: [
    WebhookEventService,
    WebhookDeliveryService,
    WebhookQueueService,
    WEBHOOK_EVENT_PORT,
    WEBHOOK_SECRET_KEY,
    WEBHOOK_DELIVERY_POLICY,
    WEBHOOK_JOB_RETENTION,
    WEBHOOK_DESTINATIONS,
  ],
})
export class WebhooksCoreModule {}
