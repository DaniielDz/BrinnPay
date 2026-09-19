import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const CHECK_TIMEOUT_MS = 3000;

export interface DependencyCheck {
  status: 'up' | 'down';
}

export interface ReadinessSuccess {
  status: 'ok';
  checks: Record<string, DependencyCheck>;
}

export interface ReadinessFailure {
  status: 'error';
  service: string;
  checks: Record<string, DependencyCheck>;
}

export type ReadinessResult = ReadinessSuccess | ReadinessFailure;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Readiness logic (phase 2 §4.3, D4). PostgreSQL is verified through Prisma
 * and Redis through a PING. Detailed failure causes are logged server-side
 * only; the HTTP payload exposes nothing but the service name and the failing
 * check names.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly serviceName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
    config: ConfigService,
  ) {
    this.serviceName = config.get<string>('serviceName') ?? 'brinnpay-api';
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const database = await this.checkDependency('database', () => this.prisma.ping());
    const redis = await this.checkDependency('redis', () => this.redis.ping());

    const checks: Record<string, DependencyCheck> = { database, redis };
    const failing = Object.entries(checks).filter(([, check]) => check.status === 'down');

    if (failing.length > 0) {
      // Minimal and safe failure payload: service name + failing check names.
      return {
        status: 'error',
        service: this.serviceName,
        checks: Object.fromEntries(failing),
      };
    }

    return { status: 'ok', checks };
  }

  private async checkDependency(
    name: string,
    operation: () => Promise<void>,
  ): Promise<DependencyCheck> {
    const indicator = this.healthIndicatorService.check(name);
    try {
      await withTimeout(operation(), CHECK_TIMEOUT_MS);
      return this.normalize(indicator.up());
    } catch (error) {
      this.logger.error({ err: error, check: name }, `Dependency health check '${name}' failed`);
      return this.normalize(indicator.down());
    }
  }

  private normalize(result: HealthIndicatorResult): DependencyCheck {
    const check = Object.values(result)[0];
    return check ? { status: check.status } : { status: 'down' };
  }
}