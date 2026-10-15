import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WorkerHttpListener } from './metrics/worker-http.listener';
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
 * Plus, since phase 20 (D3(a)/D7(a)), one bare-socket listener on its own port:
 * `/health/live` and the metrics exposition, so the worker is observable
 * without an HTTP framework (and therefore without controllers, auth, or the
 * readiness contract). It serves **no API traffic**: no global prefix, no
 * Swagger, no `/api/v1`. Deployments run it as its own service
 * (`docker compose … up worker`); the API process keeps only the producer.
 *
 * The listener is started here rather than on a module lifecycle hook because
 * three e2e suites boot `WebhooksWorkerModule` in-process: a hook would bind
 * the configured port under them and make those suites collide.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WebhooksWorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // D3(a)/D7(a): own-port observability. A lost port race is an operational
  // error, not a delivery failure — log it loudly and keep the worker alive;
  // the API process's own endpoint still reports the fleet's HTTP side.
  const listener = app.get(WorkerHttpListener);
  try {
    const port = await listener.start();
    app.get(Logger).log(`Worker observability listener started on port ${port}.`);
  } catch (error) {
    app
      .get(Logger)
      .error({ reason: error instanceof Error ? error.message : 'unknown error' }, 'Worker observability listener could not bind; delivery continues without it.');
  }

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
      void listener
        .stop()
        .catch(() => undefined)
        .then(() => app.close())
        .then(() => resolve());
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}

void bootstrap();
