import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthService, ReadinessResult } from './health.service';

describe('HealthService (phase 2 §4.3)', () => {
  function createService(options: {
    prismaPing?: jest.Mock;
    redisPing?: jest.Mock;
  }): HealthService {
    const prisma = {
      ping: options.prismaPing ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const redis = {
      ping: options.redisPing ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const config = { get: jest.fn(() => 'brinnpay-api') } as unknown as ConfigService;

    return new HealthService(prisma, redis, new HealthIndicatorService(), config);
  }

  it('reports ok when PostgreSQL and Redis are reachable', async () => {
    const service = createService({});

    const result = await service.checkReadiness();

    expect(result).toEqual({
      status: 'ok',
      checks: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
    });
  });

  it('reports error with only the failing checks when a dependency is down', async () => {
    const service = createService({
      prismaPing: jest.fn().mockRejectedValue(new Error('connection refused at postgres://internal')),
    });

    const result = (await service.checkReadiness()) as ReadinessResult;

    expect(result.status).toBe('error');
    expect(result).toMatchObject({
      service: 'brinnpay-api',
      checks: { database: { status: 'down' } },
    });
    expect('redis' in result.checks).toBe(false);
  });

  it('reports both checks down when both dependencies are down', async () => {
    const service = createService({
      prismaPing: jest.fn().mockRejectedValue(new Error('no database')),
      redisPing: jest.fn().mockRejectedValue(new Error('no redis')),
    });

    const result = (await service.checkReadiness()) as ReadinessResult;

    expect(result.status).toBe('error');
    expect(result.checks).toEqual({
      database: { status: 'down' },
      redis: { status: 'down' },
    });
  });

  it('never exposes failure internals in the payload', async () => {
    const service = createService({
      prismaPing: jest
        .fn()
        .mockRejectedValue(new Error('credentials rejected postgresql://user:pass@db:5432/x')),
    });

    const result = await service.checkReadiness();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('pass');
    expect(serialized).not.toContain('credentials');
    expect(serialized).toContain('brinnpay-api');
  });
});