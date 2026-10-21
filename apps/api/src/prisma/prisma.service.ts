import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Prisma client wrapper. Connection failures at startup are non-fatal: the
 * process must remain able to serve liveness and report readiness as
 * unavailable until PostgreSQL is reachable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: config.get<string>('databaseUrl'),
    });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      this.logger.warn(
        'PostgreSQL is not reachable at startup; readiness will report the dependency as unavailable.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => undefined);
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
