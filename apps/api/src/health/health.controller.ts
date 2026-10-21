import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService } from './health.service';

/**
 * Operational health endpoints, outside `/api/v1` and outside the OpenAPI
 * contract (phase 2 §4.3, ADR-0012). Both are unauthenticated; they are meant
 * for Docker, CI, and orchestration and must never reveal internals.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() response: Response): Promise<void> {
    const result = await this.health.checkReadiness();
    response
      .status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(result);
  }
}