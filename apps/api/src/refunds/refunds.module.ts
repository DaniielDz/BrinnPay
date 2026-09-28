import { Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { PaymentsModule } from '../payments/payments.module';
import { NoopRefundEventSink, REFUND_EVENT_SINK } from './refund-events';
import { RefundsAccessGuard } from './refunds-access.guard';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [ApiKeysModule, PaymentsModule, IdempotencyModule],
  controllers: [RefundsController],
  providers: [RefundsService, RefundsAccessGuard, { provide: REFUND_EVENT_SINK, useClass: NoopRefundEventSink }],
})
export class RefundsModule {}
