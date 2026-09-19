import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health surface (D4): `GET /health/live` + `GET /health/ready`, outside
 * `/api/v1`. Readiness verifies PostgreSQL (via Prisma) and Redis using
 * @nestjs/terminus primitives.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}