import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const PING_TIMEOUT_MS = 1500;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
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
 * Redis connectivity for the readiness check (D9). BullMQ is intentionally not
 * wired in Phase 2 (ADR-0013); this service only proves the connection.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private connectionErrorReported = false;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get<string>('redisUrl') as string, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });

    this.client.on('error', () => {
      // Connection URLs may contain credentials — never log them.
      if (!this.connectionErrorReported) {
        this.connectionErrorReported = true;
        this.logger.warn(
          'Redis is not reachable; readiness will report the dependency as unavailable.',
        );
      }
    });
    this.client.on('ready', () => {
      this.connectionErrorReported = false;
    });
  }

  get connection(): Redis {
    return this.client;
  }

  async ping(): Promise<void> {
    if (this.client.status === 'wait') {
      // `lazyConnect` defers the socket; a command issued while `wait` is
      // rejected synchronously ("Stream isn't writeable and enableOfflineQueue
      // options is false"), so the connection is established before probing.
      // This gates the readiness check (phase 2 D9) and the e2e suites' DB
      // reachability probe (phases 3–14).
      await withTimeout(this.client.connect(), PING_TIMEOUT_MS);
    }
    await withTimeout(this.client.ping(), PING_TIMEOUT_MS);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
