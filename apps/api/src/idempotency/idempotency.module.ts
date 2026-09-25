import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_RETENTION,
  IdempotencyService,
  type IdempotencyRetention,
} from './idempotency.service';

/**
 * Cross-cutting idempotency module (phase 8 §4.1, phase 1 §6.3). It owns the
 * database-backed claim/replay capability used by critical mutations —
 * `payments.create` now, `refunds.create` in Phase 9 — and exposes no
 * transport surface of its own: idempotency records are internal infrastructure
 * with no public API resource (phase 1 §13.2.2).
 *
 * The retention window (ADR-0004) is injected from configuration so storage and
 * tests share one constant with the API documentation.
 */
@Module({
  providers: [
    IdempotencyService,
    {
      provide: IDEMPOTENCY_RETENTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IdempotencyRetention => {
        const hours = config.get<number>('idempotency.retentionHours');
        return {
          retentionMs: hours === undefined ? DEFAULT_IDEMPOTENCY_RETENTION_MS : hours * 60 * 60 * 1000,
        };
      },
    },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
