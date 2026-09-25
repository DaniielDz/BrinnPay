import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CustomersAccessGuard } from './customers-access.guard';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * Customers domain module (phase 6): environment-scoped customer management
 * behind the dual-mode access boundary (API key or session JWT, D8), project
 * RBAC capabilities (D5), and the phase 5 key infrastructure.
 *
 * ApiKeysModule provides `ApiKeyAuthGuard` (delegated to in API-key mode);
 * the session boundary (`SessionAuthGuard`) is provided globally by the auth
 * module.
 */
@Module({
  imports: [ApiKeysModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomersAccessGuard],
  exports: [CustomersService],
})
export class CustomersModule {}