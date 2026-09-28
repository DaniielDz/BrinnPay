import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { parseAmountMinor } from '../common/money/money';
import { uuidv7 } from '../common/uuid/uuid';
import { REFUNDS_CREATE_SCOPE } from '../idempotency/idempotency-operation';
import { IdempotencyService, type IdempotentResult, type IdempotencyTransaction } from '../idempotency/idempotency.service';
import { buildCursorPage, cursorToWhere, DEFAULT_LIST_LIMIT, type CursorPage, type ListQueryDto } from '../organizations/cursor';
import type { PaymentsScope } from '../payments/payments-scope';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { isUuidLike } from '../projects/projects.service';
import type { RefundCreateDto } from './dto/refund-create.dto';
import { REFUND_EVENT_SINK, type RefundEventSink } from './refund-events';
import { toRefundResponse, type RefundResponse } from './refund-types';

const notFound = () => new ApiError(ErrorCode.NOT_FOUND, 'Refund not found', 404);
const paymentNotFound = () => new ApiError(ErrorCode.NOT_FOUND, 'Payment not found', 404);
const ruleViolation = () => new ApiError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Payment is not refundable for this amount', 422);
const MAX_BIGINT = 9223372036854775807n;

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly idempotency: IdempotencyService,
    @Inject(REFUND_EVENT_SINK) private readonly events: RefundEventSink,
  ) {}

  async list(scope: PaymentsScope, paymentId: string, query: ListQueryDto): Promise<CursorPage<RefundResponse>> {
    const payment = await this.findPayment(this.prisma, scope, paymentId);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const rows = await this.prisma.refund.findMany({
      where: { paymentId: payment.id, ...(cursorToWhere(query.cursor) ?? {}) },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map((row) => toRefundResponse(row, payment)), limit);
  }

  async retrieve(scope: PaymentsScope, paymentId: string, refundId: string): Promise<RefundResponse> {
    const payment = await this.findPayment(this.prisma, scope, paymentId);
    if (!isUuidLike(refundId)) throw notFound();
    const row = await this.prisma.refund.findFirst({ where: { id: refundId, paymentId: payment.id } });
    if (!row) throw notFound();
    return toRefundResponse(row, payment);
  }

  async create(
    scope: PaymentsScope,
    paymentId: string,
    dto: RefundCreateDto,
    key?: string,
  ): Promise<IdempotentResult<RefundResponse>> {
    // An already-due payment can become succeeded on read. The guard has
    // authorized this payment before any idempotency lookup or side effect.
    await this.payments.retrieve(scope, paymentId);
    return this.idempotency.execute(
      { projectId: scope.project_id, operationScope: REFUNDS_CREATE_SCOPE, key },
      (tx) => this.createInTransaction(tx, scope, paymentId, dto),
      {
        transactionalWithoutKey: true,
        validateReplay: (body) => {
          if (body.payment_id !== paymentId || body.project_id !== scope.project_id ||
            (scope.mode === 'api_key' && body.environment !== scope.environment)) {
            throw new ApiError(ErrorCode.CONFLICT, 'Idempotency key was used for another refund target', 409);
          }
        },
      },
    );
  }

  private async createInTransaction(
    tx: IdempotencyTransaction,
    scope: PaymentsScope,
    paymentId: string,
    dto: RefundCreateDto,
  ) {
    // Serialize *all* attempts against the same payment, even without an
    // idempotency key. Lock before reading the current status and balance;
    // PostgreSQL READ COMMITTED then sees prior committed refunds.
    // The shape is checked first so the `::uuid` cast can never fail.
    if (!isUuidLike(paymentId)) throw paymentNotFound();
    await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
    const payment = await this.findPayment(tx, scope, paymentId);
    if (payment.status !== 'succeeded') throw ruleViolation();

    const sum = await tx.refund.aggregate({
      where: { paymentId, status: 'succeeded' },
      _sum: { amountMinor: true },
    });
    const remaining = payment.amountMinor - (sum._sum.amountMinor ?? 0n);
    if (remaining <= 0n) throw ruleViolation();
    const amount = dto.amount === undefined ? remaining : parseAmountMinor(dto.amount);
    if (amount > remaining || amount > MAX_BIGINT) throw ruleViolation();
    if (dto.currency !== undefined && dto.currency !== payment.currency) {
      throw ApiError.validation({ fields: [{ field: 'currency', errors: ['Currency must match the payment'] }] });
    }
    const reason = dto.reason === undefined ? null : dto.reason.trim();
    if (reason !== null && (reason.length === 0 || reason.length > 255)) {
      throw ApiError.validation({ fields: [{ field: 'reason', errors: ['Reason must contain 1–255 characters'] }] });
    }

    const now = new Date();
    const row = await tx.refund.create({
      data: {
        id: uuidv7(), paymentId, amountMinor: amount, currency: payment.currency,
        status: 'succeeded', reason, createdAt: now, updatedAt: now,
      },
    });
    const body = toRefundResponse(row, payment);
    const event = {
      id: uuidv7(), type: 'refund.created' as const, created_at: now,
      data: body, environment: body.environment, project_id: payment.projectId,
    };
    return {
      status: HttpStatus.CREATED, body,
      afterCommit: () => { void this.events.emit(event); },
    };
  }

  private async findPayment(tx: IdempotencyTransaction, scope: PaymentsScope, paymentId: string) {
    if (!isUuidLike(paymentId)) throw paymentNotFound();
    const payment = await tx.payment.findFirst({
      where: {
        id: paymentId,
        projectId: scope.project_id,
        ...(scope.mode === 'api_key' ? { environment: scope.environment } : {}),
      },
    });
    if (!payment) throw paymentNotFound();
    return payment;
  }
}
