import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditLoggingCoreModule } from '../audit-logging/audit-logging-core.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksCoreModule } from '../webhooks/webhooks-core.module';
import { RefundsAccessGuard } from './refunds-access.guard';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [ApiKeysModule, PaymentsModule, IdempotencyModule, WebhooksCoreModule, AuditLoggingCoreModule],
  controllers: [RefundsController],
  providers: [RefundsService, RefundsAccessGuard],
})
export class RefundsModule {}
