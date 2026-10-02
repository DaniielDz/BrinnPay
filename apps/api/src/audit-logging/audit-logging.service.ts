import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertValidCapture,
  buildAuditData,
  isAuditActorType,
  newAuditEntryId,
  resourceIdOf,
  resourceTypeFor,
  type AuditActorType,
  type AuditAuthCapture,
  type AuditCapture,
  type AuditEntryDraft,
} from './audit-actions';
import type { AuditLogPort, AuditTransaction } from './audit-log.port';

/** §5.2 outcome events written on the capability's own connection (D7). */
function isAuthCapture(capture: AuditCapture): capture is AuditAuthCapture {
  return 'user_id' in capture;
}

/** §5.4 terminal edges attributed to the payment's original creator (D5). */
function isPaymentTransition(
  capture: AuditCapture,
): capture is Extract<AuditCapture, { action: 'payment.succeeded' | 'payment.failed' }> {
  return capture.action === 'payment.succeeded' || capture.action === 'payment.failed';
}

/**
 * Secure failure detail: the error *class* only — never the entry payload,
 * never a message that could carry one (phase 12 §9).
 */
function errorClass(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }
  return typeof error;
}

/**
 * Capture and persistence of audit entries (phase 12 §4.1, D7).
 *
 * **Fail-closed {@link record}.** Domain modules call it with *their*
 * transaction; the rows are inserted inside it, so an audited change and its
 * entries commit or roll back together. Anything unexpected (unknown action,
 * failed insert) propagates and therefore rolls the caller back — there is no
 * committed change without its audit entry (AC4).
 *
 * **Best-effort {@link captureAuth}.** Login/login-failed/logout have no
 * transaction to join: each fan-out insert runs independently on the
 * capability's own connection and a failure is logged (action, organization
 * id, error class — never the payload) and dropped; the auth outcome is never
 * altered and readiness is never affected (§6.2).
 *
 * **Exactly once (§4.2 rule 2).** The entry id is emitter-owned (UUIDv7) and
 * the insert uses `skipDuplicates`, so a retried write inside the same
 * transaction converges on one row instead of failing (Phase 10 §4.3.5
 * pattern).
 *
 * The module never exposes update or delete: entries are append-only and the
 * database rejects `UPDATE` outright (D8).
 */
@Injectable()
export class AuditLoggingService implements AuditLogPort {
  private readonly logger = new Logger(AuditLoggingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(tx: AuditTransaction, capture: AuditCapture): Promise<void> {
    const drafts = await this.drafts(tx, capture);
    if (drafts.length === 0) {
      return; // auth fan-out over zero memberships (D4) or an unattributable edge
    }
    try {
      await this.insert(tx, drafts);
    } catch (error) {
      // Fail-closed: rethrow so the caller's transaction rolls back. The log
      // carries the action, organization id and error class only (§9).
      this.logger.error(
        {
          action: capture.action,
          organization_id: drafts[0].organization_id,
          error_class: errorClass(error),
        },
        'Audit insert failed; the audited change rolls back with it.',
      );
      throw error;
    }
  }

  async captureAuth(capture: AuditCapture): Promise<void> {
    if (!isAuthCapture(capture)) {
      // Programming error: only §5.2 outcome events are best-effort. Logged
      // and dropped rather than thrown — a caller must never fail on audit.
      this.logger.error(
        { action: (capture as { action: string }).action, error_class: 'InvalidCapture' },
        'Best-effort capture received a non-authentication action; dropped.',
      );
      return;
    }
    try {
      const drafts = await this.drafts(this.prisma, capture);
      for (const draft of drafts) {
        try {
          await this.insert(this.prisma, [draft]);
        } catch (error) {
          // Independent fan-out inserts: a partial fan-out with logged
          // failures is an accepted outcome (§6.2).
          this.logger.warn(
            {
              action: draft.action,
              organization_id: draft.organization_id,
              error_class: errorClass(error),
            },
            'Authentication outcome audit entry failed; dropped.',
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        { action: capture.action, organization_id: null, error_class: errorClass(error) },
        'Authentication outcome audit capture failed; dropped.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Capture: scope + actor resolution (§5.6) and the allowlisted payload (§5)
  // -------------------------------------------------------------------------

  private async drafts(tx: AuditTransaction, capture: AuditCapture): Promise<AuditEntryDraft[]> {
    const action = assertValidCapture(capture);
    const head = {
      action,
      resource_type: resourceTypeFor(action),
      resource_id: resourceIdOf(capture),
      data: buildAuditData(capture),
      created_at: new Date(),
    };

    // §5.2 / D4: one entry per organization the acting user is a member of at
    // event time — possibly zero (no row may ever be written without an
    // organization, §4.2 rule 3).
    if (isAuthCapture(capture)) {
      const memberships = await tx.organizationMember.findMany({
        where: { userId: capture.user_id },
        select: { organizationId: true },
      });
      return memberships.map((membership) => ({
        ...head,
        id: newAuditEntryId(),
        organization_id: membership.organizationId,
        actor_type: 'user' as AuditActorType,
        actor_id: capture.user_id,
        project_id: null,
        environment: null,
      }));
    }

    // §5.4 / D5: a terminal edge is attributed to the payment's original
    // creator by reading the `payment.created` entry written with the payment
    // — the same creator whether the edge fires in the worker sweep or in a
    // read-time catch-up, and never the actor of the request that happened to
    // trigger it. A payment created before this phase exists has no such entry:
    // it cannot be attributed per D5, so it is reported and skipped rather
    // than recorded under a wrong actor.
    if (isPaymentTransition(capture)) {
      // The origin row is matched on the full project scope, not the resource id
      // alone: `resource_id` is a payment id whose uniqueness is an application
      // invariant, never a security boundary (§9 — opaque ids are not a
      // control). If the invariant were ever violated, an entry carrying
      // another tenant's organization/actor would land in this tenant's trail.
      const origin = await tx.auditLogEntry.findFirst({
        where: {
          action: 'payment.created',
          resourceType: 'payment',
          resourceId: capture.payment_id,
          projectId: capture.project_id,
          environment: capture.environment,
        },
        orderBy: { id: 'asc' },
        select: { organizationId: true, actorType: true, actorId: true },
      });
      if (!origin) {
        this.logger.warn(
          {
            action: capture.action,
            organization_id: null,
            error_class: 'MissingPaymentCreatedEntry',
          },
          'No payment.created entry to attribute a terminal transition to; skipped.',
        );
        return [];
      }
      // The origin row is data, not a trusted constant: an actor type outside
      // the catalog enum is validated here rather than cast, and an
      // unresolvable attribution is skipped instead of guessed.
      if (!isAuditActorType(origin.actorType)) {
        this.logger.warn(
          {
            action: capture.action,
            organization_id: null,
            error_class: 'UnknownOriginActorType',
          },
          'payment.created entry carries an unknown actor type; skipped.',
        );
        return [];
      }
      return [
        {
          ...head,
          id: newAuditEntryId(),
          organization_id: origin.organizationId,
          actor_type: origin.actorType,
          actor_id: origin.actorId,
          project_id: capture.project_id,
          environment: capture.environment,
        },
      ];
    }

    // §5.3 (access) and §5.5 (project-scoped): one entry, scope already
    // resolved from verified request context by the caller.
    const scope = capture;
    return [
      {
        ...head,
        id: newAuditEntryId(),
        organization_id: scope.organization_id,
        actor_type: scope.actor.type,
        actor_id: scope.actor.id,
        project_id: 'project_id' in scope ? scope.project_id : null,
        environment: 'environment' in scope ? scope.environment : null,
      },
    ];
  }

  /**
   * The single write path. `skipDuplicates` turns a repeated insert of the
   * emitter-owned id into a no-op (§4.2 rule 2); `data` is omitted when the
   * allowlist produced nothing (§4.2 rule 7).
   */
  private async insert(tx: AuditTransaction, drafts: AuditEntryDraft[]): Promise<void> {
    if (drafts.length === 0) {
      return;
    }
    await tx.auditLogEntry.createMany({
      data: drafts.map((draft) => ({
        id: draft.id,
        organizationId: draft.organization_id,
        actorType: draft.actor_type,
        actorId: draft.actor_id,
        action: draft.action,
        resourceType: draft.resource_type,
        resourceId: draft.resource_id,
        projectId: draft.project_id,
        environment: draft.environment,
        ...(draft.data ? { data: draft.data as Prisma.InputJsonValue } : {}),
        createdAt: draft.created_at,
      })),
      skipDuplicates: true,
    });
  }
}
