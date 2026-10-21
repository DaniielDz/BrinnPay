import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { setupSwagger } from './openapi/swagger';

/**
 * API entry point (Phase 2). Boots the modular monolith, applies the base
 * cross-cutting infrastructure (request IDs, security headers, CORS, global
 * validation pipe, global prefix) and serves Swagger UI from the canonical
 * contract (D5).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.useLogger(app.get(Logger));
  configureApp(app, config);
  setupSwagger(app, config);

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
}

void bootstrap();