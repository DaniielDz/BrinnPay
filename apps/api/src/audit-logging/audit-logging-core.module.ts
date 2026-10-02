import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AUDIT_LOG_PORT } from './audit-log.port';
import { AuditLoggingService } from './audit-logging.service';

/**
 * The durable half of the audit-logging capability (phase 12 §4.1): capture
 * scope/actor resolution and the `audit_log_entries` write path behind
 * {@link AUDIT_LOG_PORT}.
 *
 * Split from {@link AuditLoggingModule} for the same reason as the Phase 10
 * webhook core and the Phase 11 request-logging core: every domain module that
 * records an entry imports *this* module for the port, while the HTTP read
 * surface lives in the outer module. Nothing here exposes an update or a
 * delete — entries are append-only and the database rejects `UPDATE` (D8).
 */
@Module({
  imports: [PrismaModule],
  providers: [
    AuditLoggingService,
    {
      // The single inbound boundary the domain modules call (§4.1): the
      // Phase 10 port shape — caller's transaction, emitter-owned id,
      // fail-closed for mutations and best-effort for auth outcomes (D7).
      provide: AUDIT_LOG_PORT,
      useExisting: AuditLoggingService,
    },
  ],
  exports: [AuditLoggingService, AUDIT_LOG_PORT],
})
export class AuditLoggingCoreModule {}
