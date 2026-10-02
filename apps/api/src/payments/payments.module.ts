import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { DEFAULT_SIMULATION_DELAYS, PAYMENT_DELAYS } from './payment-simulation';
import { WebhooksCoreModule } from '../webhooks/webhooks-core.module';
import { PaymentsAccessGuard } from './payments-access.guard';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments domain module (phase 7): simulated payment operations with the
 * default-success state machine behind the dual-mode access boundary (API key
 * or session JWT, D11), the payment RBAC capabilities (D5), the money helper
 * boundary (D8), and the payment event seam (D10 — a no-op sink until
 * Phase 10 wires persistence/delivery).
 *
 * ApiKeysModule provides `ApiKeyAuthGuard` (delegated to in API-key mode);
 * the session boundary (`SessionAuthGuard`) is provided globally by the auth
 * module. The simulation delays are env-configurable via the shared
 * configuration (defaults in `DEFAULT_SIMULATION_DELAYS`) so tests run
 * deterministically.
 *
 * IdempotencyModule (phase 8) supplies the cross-cutting claim/replay
 * capability that `payments.create` executes its mutation through.
 *
 * WebhooksCoreModule (phase 10 §4.1) supplies the inbound event port: events are
 * persisted inside this module's transaction and delivery is scheduled after the
 * commit. The dependency is one-directional — the webhooks module never imports
 * the payments module for this purpose (it derives the catalog from the constant
 * in `payment-events.ts`), and only the *worker* composition root imports both.
 */
@Module({
  imports: [ApiKeysModule, IdempotencyModule, WebhooksCoreModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsAccessGuard,
    {
      provide: PAYMENT_DELAYS,
      useFactory: (config: ConfigService) => ({
        pendingDelayMs:
          config.get<number>('payments.pendingDelayMs') ?? DEFAULT_SIMULATION_DELAYS.pendingDelayMs,
        settlementDelayMs:
          config.get<number>('payments.settlementDelayMs') ??
          DEFAULT_SIMULATION_DELAYS.settlementDelayMs,
      }),
      inject: [ConfigService],
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}