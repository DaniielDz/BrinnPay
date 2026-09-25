import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import type { CursorPage } from '../organizations/cursor';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { PaymentCreateDto } from './dto/payment-create.dto';
import { PaymentListQueryDto } from './dto/payment-list-query.dto';
import { PaymentsAccessGuard } from './payments-access.guard';
import { PaymentsScope, type PaymentsScope as PaymentsScopeValue } from './payments-scope';
import { PaymentsService } from './payments.service';
import type { PaymentResponse } from './payment-types';

/**
 * Payments surface (phase 7 §4.2/§4.3). Every route sits under a `project_id`
 * path parameter and is protected by the dual-mode `PaymentsAccessGuard`
 * (D11, mirroring Phase 6 D8):
 *
 * - **session mode** (dashboard JWT): project-RBAC on the route's capability
 *   (404 non-member / 403 insufficient capability);
 * - **API-key mode** (`sk_…` token): the key's (project, environment) scope
 *   applies and the path project must be the key's project.
 *
 * All `api-key`-scoped data access is further pinned to the key's environment
 * inside `PaymentsService` (404 cross-environment, 422 explicit mismatches).
 *
 * `payments.create` is the first idempotent consumer (phase 8): the optional
 * `Idempotency-Key` header is validated, and a same-project retry inside the
 * 24-hour window replays the stored 201 `Payment` body without creating a
 * second payment.
 */
@Controller('projects/:project_id/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @UseGuards(PaymentsAccessGuard)
  @RequireCapability({ capability: 'payments.read' })
  list(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Query() query: PaymentListQueryDto,
  ): Promise<CursorPage<PaymentResponse>> {
    return this.payments.list(scope, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PaymentsAccessGuard)
  @RequireCapability({ capability: 'payments.create' })
  async create(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Body() dto: PaymentCreateDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PaymentResponse> {
    // The status comes from the idempotency capability, so a replayed retry
    // answers with the stored status of the original execution (phase 8 §4.2.4,
    // §4.3.2) instead of recomputing it.
    const result = await this.payments.create(scope, dto, idempotencyKey);
    response.status(result.status);
    return result.body;
  }

  @Get(':payment_id')
  @UseGuards(PaymentsAccessGuard)
  @RequireCapability({ capability: 'payments.read' })
  retrieve(
    @PaymentsScope() scope: PaymentsScopeValue,
    @Param('payment_id') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.payments.retrieve(scope, paymentId);
  }
}