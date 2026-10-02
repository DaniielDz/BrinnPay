import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_LOG_PORT, type AuditLogPort } from '../audit-logging/audit-log.port';
import type { AuditEnvironment } from '../audit-logging/audit-actions';
import { actorOfScope, organizationIdOfScope } from '../audit-logging/audit-scope';
import { ApiError } from '../common/errors/api-error';
import { ErrorCode } from '../common/errors/error-code';
import { formatAmountMinor, isUsd, parseAmountMinor } from '../common/money/money';
import { uuidv7 } from '../common/uuid/uuid';
import {
  PAYMENTS_CREATE_SCOPE,
  type IdempotencyOperationScope,
} from '../idempotency/idempotency-operation';
import { IdempotencyService, type IdempotentResult } from '../idempotency/idempotency.service';
import {
  buildCursorPage,
  cursorToWhere,
  DEFAULT_LIST_LIMIT,
  type CursorPage,
} from '../organizations/cursor';
import type { Environment } from '../projects/environment';
import { isUuidLike } from '../projects/projects.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentCreateDto } from './dto/payment-create.dto';
import type { PaymentListQueryDto } from './dto/payment-list-query.dto';
import type { PaymentEvent, PaymentEventType } from './payment-events';
import {
  PAYMENT_DELAYS,
  scheduledTransition,
  type LegalTransition,
  type SimulationDelays,
} from './payment-simulation';
import type { PaymentRow, PaymentResponse } from './payment-types';
import { toPaymentResponse } from './payment-types';
import type { PaymentStatus } from './payment-types';
import type { PaymentsScope } from './payments-scope';
import { WEBHOOK_EVENT_PORT, type WebhookEventPort } from '../webhooks/webhook-events';

const PAYMENT_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Payment not found', 404);
const CUSTOMER_NOT_FOUND = () => new ApiError(ErrorCode.NOT_FOUND, 'Customer not found', 404);

/** The operation scope of this mutation (phase 8 §4.3.1, ADR-0004). */
const OPERATION_SCOPE: IdempotencyOperationScope = PAYMENTS_CREATE_SCOPE;

/**
 * The result of applying one edge together with its event:
 * `lost` means a concurrent writer owns this edge, `rolled-back` means the edge
 * and its event did not commit and the next pass must retry it.
 */
type EdgeOutcome = 'applied' | 'lost' | 'rolled-back';

/**
 * Payments domain service (phase 7 §4.2/§4.6/§4.7).
 *
 * The dual-mode boundary (`PaymentsAccessGuard`) has already resolved the
 * request to exactly one scope (D11) and enforced the project-level
 * authorization (session: membership + capability; API key: path project =
 * key project). This service enforces what remains:
 *
 * - the environment-match rule (D1): session requests must provide the
 *   environment (400 when missing); API-key requests derive it from the key
 *   and reject conflicting explicit values (422);
 * - project/environment scoping of every query (404 non-disclosure for
 *   cross-project and cross-environment payment ids);
 * - customer scoping on create (D3): the referenced customer must be visible
 *   in the addressed project (and, in API-key mode, the key's environment) —
 *   otherwise 404;
 * - the field rules: strictly-positive decimal-string amounts (D7) converted
 *   to integer minor units at the boundary (D8/ADR-0002), `usd`-only
 *   currency (ADR-0003), and trimmed description (≤ 500, D9);
 * - idempotency (phase 8): the `Idempotency-Key` header is validated and the
 *   mutation is executed through the shared `IdempotencyService` under
 *   operation scope `payments.create`, so a same-project, same-scope retry
 *   inside the 24-hour window replays the stored 201 `Payment` instead of
 *   creating a second payment or emitting a second `payment.created`;
 * - the default-success simulation (D2): payment creation arms the schedule
 *   (status `pending`); lazy, guarded, compare-and-set advancement on read
 *   (list and retrieve) — `pending → processing → succeeded`; `failed` is
 *   defined (column, transition legality, event) but has no public trigger in
 *   Phase 7 (Phase 16 sandbox);
 * - event emission (D10, phase 10 §5.3/D2): `payment.created` on create;
 *   `payment.succeeded`/`payment.failed` when the terminal edge is applied —
 *   through the webhooks module's `WEBHOOK_EVENT_PORT`. The port persists the
 *   event **inside this module's transaction** and schedules delivery after the
 *   commit, so an event exists if and only if the mutation committed (§4.3.4)
 *   and a crash between commit and enqueue cannot lose it. The payment and
 *   lifecycle rules themselves are unchanged by Phase 10.
 * - the advancement sweep entry point (phase 10 D3/F2): `advanceDuePayments`
 *   applies the same CAS-guarded edges a read would, so a terminal event fires
 *   without anybody reading the payment.
 * - audit capture (phase 12 §5.4/§6.2): `payment.created` and each terminal
 *   transition are written inside the same transaction as the change, through
 *   the audit module's port — a committed payment always has its entry, and a
 *   replay or a rollback writes none. Terminal edges are attributed to the
 *   payment's original creator (D5) with no `request_id` (AC6).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WEBHOOK_EVENT_PORT) private readonly events: WebhookEventPort,
    @Inject(PAYMENT_DELAYS) private readonly delays: SimulationDelays,
    private readonly idempotency: IdempotencyService,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
  ) {}

  /** List (§4.2): cursor-paginated payments of one project environment. The
   *  environment must be explicit (session) or match the key (API key, D1);
   *  non-terminal payments whose scheduled time has passed are advanced
   *  before the page is assembled (D2). */
  async list(
    scope: PaymentsScope,
    query: PaymentListQueryDto,
  ): Promise<CursorPage<PaymentResponse>> {
    const environment = this.resolveListEnvironment(scope, query.environment);
    await this.catchUpEnvironment(scope.project_id, environment, new Date());

    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const rows = await this.prisma.payment.findMany({
      where: {
        projectId: scope.project_id,
        environment,
        ...(cursorToWhere(query.cursor) ?? {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    return buildCursorPage(rows.map(toPaymentResponse), limit);
  }

  /**
   * Create (§4.2): a payment belongs to exactly one (project, environment)
   * and one customer of the addressed project (D3) — scoped per mode.
   * Session mode: `environment` is required in the body (DTO-enforced);
   * API-key mode: it must equal the key's environment (else 422, D1).
   *
   * The whole mutation runs inside the idempotency capability (phase 8 §4.3.1)
   * with operation scope `payments.create`: with a valid `Idempotency-Key` the
   * payment is created at most once per (project, scope, key) within the
   * 24-hour window — a retry replays the stored 201 body without a second
   * payment row and without a second `payment.created` event — while an absent
   * key behaves as a normal non-idempotent create. Authorization and request
   * validation have already run in the guards and pipes; a mutation rejected
   * here rolls its claim back, so the key is never poisoned.
   *
   * The event is emitted only after the transaction commits, so an event can
   * never describe a payment that was rolled back (phase 8 §10).
   */
  async create(
    scope: PaymentsScope,
    dto: PaymentCreateDto,
    idempotencyKey?: string,
    requestId?: string,
  ): Promise<IdempotentResult<PaymentResponse>> {
    return this.idempotency.execute<PaymentResponse>(
      { projectId: scope.project_id, operationScope: OPERATION_SCOPE, key: idempotencyKey },
      async (tx) => {
        const environment = this.resolveCreateEnvironment(scope, dto.environment);
        const amountMinor = parseAmountMinor(dto.amount);
        this.requireUsd(dto.currency);
        const description =
          dto.description === undefined ? null : this.validateDescription(dto.description);

        // D3 (phase 6 §15): the customer must be visible in the addressed
        // project (session) and, in API-key mode, in the key's environment —
        // otherwise 404, indistinguishable from an unknown customer
        // (non-disclosure).
        const customer = await tx.customer.findFirst({
          where: {
            id: dto.customer_id,
            projectId: scope.project_id,
            ...(scope.mode === 'api_key' ? { environment } : {}),
          },
          select: { id: true },
        });
        if (!customer) {
          throw CUSTOMER_NOT_FOUND();
        }

        const now = new Date();
        const payment = await tx.payment.create({
          data: {
            id: uuidv7(),
            projectId: scope.project_id,
            environment,
            customerId: dto.customer_id,
            amountMinor,
            currency: dto.currency,
            status: 'pending',
            failureCode: null,
            description,
            createdAt: now,
            updatedAt: now,
          },
        });

        // D2: the event row commits atomically with the payment, so a rolled-back
        // mutation can never leave a phantom event and a committed payment can
        // never be missing one. An idempotency replay takes none of this path, so
        // a replayed create emits nothing (§4.3.4).
        const event = this.paymentEvent('payment.created', payment, now, requestId);
        await this.events.persist(tx, event);

        // Phase 12 §5.4/§6.2: the `payment.created` entry joins the same
        // transaction, so no payment can commit without it (fail-closed, D7)
        // and a replay writes no second entry (§4.2 rule 6). Organization and
        // actor come from the guard-resolved scope — never from the body.
        await this.audit.record(tx, {
          action: 'payment.created',
          organization_id: organizationIdOfScope(scope),
          actor: actorOfScope(scope),
          project_id: scope.project_id,
          environment,
          payment_id: payment.id,
          amount: formatAmountMinor(payment.amountMinor),
          currency: payment.currency,
          request_id: requestId ?? null,
        });

        return {
          status: HttpStatus.CREATED,
          body: toPaymentResponse(payment),
          // Scheduling is best-effort and strictly post-commit: a job that ran
          // before the commit would find no row, and a queue failure must not fail
          // an already-committed mutation (§4.3.7). Reconciliation repairs it.
          afterCommit: () => {
            void this.events.dispatch(event.id);
          },
        };
      },
    );
  }

  /** Retrieve (§4.2): scoped to the addressed project; an API key can only
   *  see payments of its own environment (else 404, non-disclosure). A
   *  non-terminal payment whose scheduled time has passed is advanced before
   *  responding (D2). */
  async retrieve(scope: PaymentsScope, paymentId: string): Promise<PaymentResponse> {
    const payment = await this.findScopedPayment(scope, paymentId);
    const advanced = await this.advance(payment, new Date());
    return toPaymentResponse(advanced);
  }

  // -------------------------------------------------------------------------
  // Scope and environment resolution (D1)
  // -------------------------------------------------------------------------

  /**
   * Session mode: the `environment` query parameter is required — TEST/LIVE
   * data is never mixed, so a session request without an explicit environment
   * cannot be served (400, field error). API-key mode: the environment is
   * derived from the key; an explicit conflicting value → 422 (the contract's
   * `required: false` covers this API-key path).
   */
  private resolveListEnvironment(
    scope: PaymentsScope,
    explicit: Environment | undefined,
  ): Environment {
    if (scope.mode === 'api_key') {
      if (explicit && explicit !== scope.environment) {
        this.environmentMismatch();
      }
      return scope.environment;
    }
    if (!explicit) {
      throw ApiError.validation({
        fields: [
          {
            field: 'environment',
            errors: ['environment is required for session-authenticated requests'],
          },
        ],
      });
    }
    return explicit;
  }

  /** Create environment check: session → DTO-required body value; API key →
   *  the body value must equal the key's environment (422 on mismatch). */
  private resolveCreateEnvironment(scope: PaymentsScope, body: Environment): Environment {
    if (scope.mode === 'api_key') {
      if (body !== scope.environment) {
        this.environmentMismatch();
      }
      return scope.environment;
    }
    return body;
  }

  /** 422 `BUSINESS_RULE_VIOLATION` for the environment-mismatch rule (D1). */
  private environmentMismatch(): never {
    throw new ApiError(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'Environment does not match the API key scope',
      422,
      { field: 'environment' },
    );
  }

  // -------------------------------------------------------------------------
  // Simulation (D2) — lazy, guarded advancement
  // -------------------------------------------------------------------------

  /**
   * The queue-driven advancement sweep (phase 10 §5.3, D3/F2).
   *
   * Read-time catch-up alone would mean a `payment.succeeded` webhook is only
   * emitted when somebody happens to read the payment, so the sandbox would
   * rarely fire its most important event. This is the **driver** that fixes that:
   * it finds non-terminal payments whose schedule is due and applies exactly the
   * same compare-and-set edges {@link advance} applies, across every project and
   * environment.
   *
   * It adds no lifecycle rule: `advance()` re-derives the transition from the row
   * it just read, so the sweep and a concurrent read both go through the same CAS
   * and only the winner emits. Terminal states are absorbing, so a payment cannot
   * be advanced twice or regressed.
   *
   * The batch is bounded so a large backlog cannot monopolize the worker, and the
   * next pass continues where this one stopped.
   */
  async advanceDuePayments(now: Date, batchSize = 100): Promise<number> {
    // No transition can be due before the whole schedule has elapsed, so the
    // bound is a cheap indexed filter rather than a full non-terminal scan.
    const scheduleCompleteAt = new Date(
      now.getTime() - (this.delays.pendingDelayMs + this.delays.settlementDelayMs),
    );
    const due = await this.prisma.payment.findMany({
      where: {
        status: { in: ['pending', 'processing'] },
        createdAt: { lte: scheduleCompleteAt },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    });

    let advanced = 0;
    for (const row of due) {
      const before = row.status;
      const after = await this.advance(row, now);
      if (after.status !== before) {
        advanced += 1;
      }
    }
    return advanced;
  }

  /**
   * Advances every non-terminal payment of the (project, environment) whose
   * scheduled time has passed (read-time catch-up). Each edge is a guarded
   * compare-and-set (`updateMany` on the expected status, affected-count
   * check), so concurrent timers/reads never advance a payment twice or
   * regress it, and terminal states are absorbing.
   */
  private async catchUpEnvironment(
    projectId: string,
    environment: string,
    now: Date,
  ): Promise<void> {
    const due = await this.prisma.payment.findMany({
      where: {
        projectId,
        environment,
        status: { in: ['pending', 'processing'] },
      },
    });
    for (const row of due) {
      await this.advance(row, now);
    }
  }

  /**
   * Applies the due edges of one payment (at most `pending → processing →
   * succeeded|failed` — two edges). Emits the terminal event only when this
   * call wins the CAS (an event fires exactly once per edge). Re-reads the
   * authoritative row whenever a transition was due so the caller never
   * returns a stale snapshot after contention.
   */
  private async advance(row: PaymentRow, now: Date): Promise<PaymentRow> {
    let current = row;
    let wrote = false;
    let due = false;

    for (let step = 0; step < 2; step += 1) {
      // The row status is an app-validated enum on write (phase 4 D10
      // pattern); the cast keeps the simulation engine pure on `PaymentStatus`.
      const transition = scheduledTransition(
        { status: current.status as PaymentStatus, createdAt: current.createdAt },
        now,
        this.delays,
      );
      if (!transition) {
        break;
      }
      due = true;

      const outcome = await this.applyEdge(current, transition, now);
      if (outcome !== 'applied') {
        // `lost`: a concurrent writer applied this edge (or holds a newer state);
        // never advance or regress from a stale snapshot.
        // `rolled-back`: the edge and its event did not commit together, so the
        // payment is unchanged and the next read or sweep pass retries it.
        break;
      }

      wrote = true;
      current = { ...current, status: transition.to, updatedAt: now };
    }

    if (!wrote && !due) {
      return row; // no transition due; snapshot is authoritative
    }
    // A transition was due: re-read the authoritative state (we may or may
    // not have been the writer under contention).
    const latest = await this.prisma.payment.findUnique({ where: { id: row.id } });
    return latest ?? row;
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  /**
   * Loads a payment within the addressed project (and, in API-key mode,
   * within the key's environment). A cross-project or cross-environment
   * `payment_id`, or any malformed id, is indistinguishable from an unknown
   * payment (404 non-disclosure). Session mode applies no environment filter:
   * the payment id is the address and project scoping is the isolation
   * boundary (D12).
   */
  private async findScopedPayment(scope: PaymentsScope, paymentId: string): Promise<PaymentRow> {
    if (!isUuidLike(paymentId)) {
      throw PAYMENT_NOT_FOUND();
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        projectId: scope.project_id,
        ...(scope.mode === 'api_key' ? { environment: scope.environment } : {}),
      },
    });
    if (!payment) {
      throw PAYMENT_NOT_FOUND();
    }
    return payment;
  }

  // -------------------------------------------------------------------------
  // Field rules (D7/D9)
  // -------------------------------------------------------------------------

  /** Defensive USD check (the DTO enum already rejects non-`usd` values at
   *  the boundary — ADR-0003). */
  private requireUsd(currency: string): void {
    if (!isUsd(currency)) {
      throw ApiError.validation({
        fields: [{ field: 'currency', errors: ['Currency must be "usd"'] }],
      });
    }
  }

  /** `description` is trimmed, non-empty, and ≤ 500 characters (D9);
   *  whitespace-only → 400; absent → `null` handled by the caller. */
  private validateDescription(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw ApiError.validation({
        fields: [{ field: 'description', errors: ['Payment description must not be empty'] }],
      });
    }
    if (trimmed.length > 500) {
      throw ApiError.validation({
        fields: [
          { field: 'description', errors: ['Payment description must be at most 500 characters'] },
        ],
      });
    }
    return trimmed;
  }

  // -------------------------------------------------------------------------
  // Events (D10)
  // -------------------------------------------------------------------------

  /**
   * Applies one compare-and-set edge together with the terminal event it
   * implies, in a single transaction: the status change and the event commit or
   * roll back as one (D2). A payment can therefore never reach a terminal state
   * without its event, and no event can describe a rolled-back change.
   *
   * Only the CAS winner reaches the event insert, so `payment.succeeded` or
   * `payment.failed` is persisted exactly once per edge no matter how many
   * readers or sweep passes race. The window is narrow but not free: committing
   * the CAS on its own — the pre-Phase-10 shape — meant a crash or database
   * error before the event insert lost the event permanently, because the
   * payment was already terminal and no later pass re-derived the edge.
   *
   * A rollback is logged rather than propagated: it must not fail the read that
   * triggered it, and because the status change did not commit, the next read or
   * sweep pass re-applies the edge and retries the event.
   */
  private async applyEdge(
    current: PaymentRow,
    transition: LegalTransition,
    now: Date,
  ): Promise<EdgeOutcome> {
    let claimed = false;
    // Captured inside the transaction so the delivery is scheduled after it
    // commits, never before (a job that ran early would find no rows).
    let eventId: string | null = null;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const result = await tx.payment.updateMany({
            where: { id: current.id, status: transition.from },
            data: { status: transition.to, updatedAt: now },
          });
          if (result.count === 0) {
            return; // lost the race; nothing was written
          }
          claimed = true;
          if (transition.event) {
            const updated = { ...current, status: transition.to, updatedAt: now };
            const event = this.paymentEvent(transition.event, updated, now);
            eventId = event.id;
            await this.events.persist(tx, event);
            // Phase 12 §5.4/§6.2: the terminal entry joins the CAS
            // transaction, so an edge and its entry commit or roll back
            // together. No `request_id`: the edge is applied by the worker
            // sweep or a read-time catch-up, and D5 attributes it to the
            // payment's original creator — never to whoever triggered the
            // pass (AC6).
            const terminal = {
              project_id: current.projectId,
              environment: current.environment as AuditEnvironment,
              payment_id: current.id,
              amount: formatAmountMinor(current.amountMinor),
              currency: current.currency,
            };
            await this.audit.record(
              tx,
              transition.event === 'payment.succeeded'
                ? { action: 'payment.succeeded', ...terminal }
                : { action: 'payment.failed', ...terminal, failure_code: current.failureCode },
            );
          }
        },
        // The fan-out inserts one delivery per subscribed endpoint, so this
        // transaction is not as short as the CAS alone (same budget the detached
        // path used before the edge and its event shared a commit).
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      this.logger.error(
        {
          payment_id: current.id,
          project_id: current.projectId,
          from: transition.from,
          to: transition.to,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
        'Could not apply a payment edge and its event atomically; the next pass will retry.',
      );
      return 'rolled-back';
    }

    if (!claimed) {
      return 'lost';
    }
    if (eventId) {
      // Best-effort and strictly post-commit (§4.3.7): a queue failure is logged
      // inside the port and reconciliation creates the missing deliveries later.
      void this.events.dispatch(eventId);
    }
    return 'applied';
  }

  /** Builds the phase 1 §9.5 envelope around the contracted `Payment`. */
  private paymentEvent(
    type: PaymentEventType,
    row: PaymentRow,
    at: Date,
    requestId?: string,
  ): PaymentEvent {
    return {
      id: uuidv7(),
      type,
      created_at: at,
      data: toPaymentResponse(row),
      environment: row.environment as Environment,
      project_id: row.projectId,
      request_id: requestId ?? null,
    };
  }
}