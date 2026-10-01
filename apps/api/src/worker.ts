import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WebhooksWorkerModule } from './webhooks/webhooks-worker.module';

/**
 * The webhook delivery worker process (phase 10 §5.3, D14).
 *
 * A separate process from the API, sharing only PostgreSQL and Redis. It runs
 * four things and nothing else:
 *
 * - the BullMQ consumer that performs the signed HTTP attempts and records each
 *   attempt on the delivery aggregate;
 * - the reconciliation pass that repairs a failed enqueue (§4.3.7, D2);
 * - the payment advancement sweep, so `payment.succeeded`/`payment.failed` are
 *   emitted and delivered without any read of the payment (D3, F2);
 * - the retention cleanup pass (D9).
 *
 * It serves **no HTTP traffic**: no controller, no global prefix, no Swagger, and
 * no readiness contract. Deployments run it as its own service
 * (`docker compose … up worker`); the API process keeps only the producer.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WebhooksWorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // An application context has no HTTP server to close, so shutdown is awaited
  // explicitly: the process must not exit before the BullMQ consumer has closed
  // its Redis connections, or an in-flight attempt would be abandoned.
  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) {
        return;
      }
      closing = true;
      app.get(Logger).log(`Received ${signal}; closing the webhook worker.`);
      void app.close().then(() => resolve());
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}

void bootstrap();
