import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Param,
  Post, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { ListQueryDto, type CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { PaymentsScope, type PaymentsScope as PaymentsScopeValue } from '../payments/payments-scope';
import { RefundCreateDto } from './dto/refund-create.dto';
import { RefundsAccessGuard } from './refunds-access.guard';
import { RefundsService } from './refunds.service';
import type { RefundResponse } from './refund-types';

@Controller('payments/:payment_id/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @UseGuards(RefundsAccessGuard)
  @RequireCapability({ capability: 'refunds.read' })
  list(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Param('payment_id') paymentId: string,
    @Query() query: ListQueryDto,
  ): Promise<CursorPage<RefundResponse>> {
    return this.refunds.list(scope, paymentId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RefundsAccessGuard)
  @RequireCapability({ capability: 'refunds.create' })
  async create(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Param('payment_id') paymentId: string,
    @Body() dto: RefundCreateDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') key?: string,
  ): Promise<RefundResponse> {
    const result = await this.refunds.create(scope, paymentId, dto, key);
    response.status(result.status);
    return result.body;
  }

  @Get(':refund_id')
  @UseGuards(RefundsAccessGuard)
  @RequireCapability({ capability: 'refunds.read' })
  retrieve(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Param('payment_id') paymentId: string,
    @Param('refund_id') refundId: string,
  ): Promise<RefundResponse> {
    return this.refunds.retrieve(scope, paymentId, refundId);
  }
}
