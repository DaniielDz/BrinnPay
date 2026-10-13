import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditLoggingCoreModule } from '../audit-logging/audit-logging-core.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * Customers domain module (phase 6): environment-scoped customer management
 * behind the shared dual-mode access boundary (API key or session JWT —
 * `ProjectAccessGuard`, phase 18 D1 consolidated the phase 6 clone into it),
 * project RBAC capabilities (D5), and the phase 5 key infrastructure.
 *
 * ApiKeysModule is imported so the shared guard's API-key half resolves in
 * this module's context (Nest resolves a controller's guard in the declaring
 * module's context). The session boundary (`SessionAuthGuard`) is provided
 * globally by the auth module.
 *
 * AuditLoggingCoreModule (phase 12) supplies the audit capture port: each
 * customer mutation and its entry share one transaction (§6.2, D7).
 */
@Module({
  imports: [ApiKeysModule, AuditLoggingCoreModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}