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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import type { CursorPage } from '../organizations/cursor';
import { ProjectAccessGuard } from '../common/project-scope/project-access.guard';
import {
  ProjectScope,
  type ProjectScope as ProjectScopeValue,
} from '../common/project-scope/project-scope';
import { resolveRequestId } from '../request-id/request-id';
import { ApiKeyRateLimitGuard } from '../rate-limiting/api-key-rate-limit.guard';
import { RateLimit } from '../rate-limiting/rate-limit.decorator';
import { RequireCapability } from '../organizations/org-rbac.guard';
import { PaymentCreateDto } from './dto/payment-create.dto';
import { PaymentListQueryDto } from './dto/payment-list-query.dto';
import { PaymentsService } from './payments.service';
import type { PaymentResponse } from './payment-types';

/**
 * Payments surface (phase 7 §4.2/§4.3). Every route sits under a `project_id`
 * path parameter and is protected by the shared dual-mode
 * `ProjectAccessGuard` (phase 10 §14; phase 18 D1 consolidated the phase 7
 * clone into it with no behavior change):
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
  @RateLimit('read')
  @UseGuards(ProjectAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'payments.read' })
  list(
    @ProjectScope() scope: ProjectScopeValue,
    @Query() query: PaymentListQueryDto,
  ): Promise<CursorPage<PaymentResponse>> {
    return this.payments.list(scope, query);
  }

  @Post()
  @RateLimit('write')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProjectAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'payments.create' })
  async create(
    @ProjectScope() scope: ProjectScopeValue,
    @Body() dto: PaymentCreateDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Req() request?: { id?: unknown },
  ): Promise<PaymentResponse> {
    // The status comes from the idempotency capability, so a replayed retry
    // answers with the stored status of the original execution (phase 8 §4.2.4,
    // §4.3.2) instead of recomputing it.
    //
    // The request ID is recorded on the delivery rows the `payment.created` event
    // produces (phase 10 §4.3.11, F4) and is never part of the envelope.
    const requestId = request ? resolveRequestId(request) : undefined;
    const result = await this.payments.create(scope, dto, idempotencyKey, requestId);
    response.status(result.status);
    return result.body;
  }

  @Get(':payment_id')
  @RateLimit('read')
  @UseGuards(ProjectAccessGuard, ApiKeyRateLimitGuard)
  @RequireCapability({ capability: 'payments.read' })
  retrieve(
    @ProjectScope() scope: ProjectScopeValue,
    @Param('payment_id') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.payments.retrieve(scope, paymentId);
  }
}