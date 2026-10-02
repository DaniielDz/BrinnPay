import { uuidv7 } from '../common/uuid/uuid';

/**
 * Audit action catalog, capture shapes and per-action `data` allowlists
 * (phase 12 §5, D1/D2/D13).
 *
 * **Closed catalog (§5.1).** Only the actions declared below may ever be
 * written; growing the catalog means amending this file (and the OpenAPI
 * description of the `action` property), never adding a value ad hoc from a
 * controller. `action` stays an open `string` in the contract, so the catalog
 * can grow without a breaking change (F2).
 *
 * **Allowlist, not redaction (§4.2 rule 7, D13).** `data` is composed by the
 * per-action builders of {@link buildAuditData} — every payload is typed field
 * by field, so a caller cannot widen the stored fields by passing a larger
 * object. Entries never carry passwords, API-key plaintext, tokens, webhook
 * secrets, `Idempotency-Key` values, headers, bodies, emails, IP addresses,
 * user agents or free text (e.g. a refund `reason`).
 */

// ---------------------------------------------------------------------------
// Actors (§4.2 rule 4, D5)
// ---------------------------------------------------------------------------

export const AUDIT_ACTOR_TYPES = ['user', 'api_key'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Who performed the action. Session-driven → `user`; API-key-driven →
 * `api_key` (the key id, never the plaintext — ADR-0006/ADR-0014); background
 * transitions → the resource's original creator (D5). The id is a UUID value
 * or, on the wire, `null`; it is never a secret.
 */
export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export function isAuditActorType(value: string): value is AuditActorType {
  return (AUDIT_ACTOR_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Action catalog (§5)
// ---------------------------------------------------------------------------

/** §5.2 — authentication outcomes (D4 membership fan-out). */
export const AUTH_AUDIT_ACTIONS = [
  'user.registered',
  'user.logged_in',
  'user.login_failed',
  'user.logged_out',
] as const;
export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];

/** §5.3 — access-control changes (single addressed organization). */
export const ACCESS_AUDIT_ACTIONS = [
  'invitation.created',
  'invitation.canceled',
  'member.joined',
  'member.role_changed',
  'member.removed',
] as const;
export type AccessAuditAction = (typeof ACCESS_AUDIT_ACTIONS)[number];

/** §5.4 — payment/refund lifecycle (resource's project organization). */
export const PAYMENT_AUDIT_ACTIONS = [
  'payment.created',
  'payment.succeeded',
  'payment.failed',
  'refund.created',
] as const;
export type PaymentAuditAction = (typeof PAYMENT_AUDIT_ACTIONS)[number];

/** §5.5 — coordination extensions (D2: API keys and customers). */
export const COORDINATION_AUDIT_ACTIONS = [
  'api_key.created',
  'api_key.revoked',
  'customer.created',
  'customer.updated',
  'customer.deleted',
] as const;
export type CoordinationAuditAction = (typeof COORDINATION_AUDIT_ACTIONS)[number];

/** The closed catalog (§5.1) — only these values may be persisted. */
export const AUDIT_ACTIONS = [
  ...AUTH_AUDIT_ACTIONS,
  ...ACCESS_AUDIT_ACTIONS,
  ...PAYMENT_AUDIT_ACTIONS,
  ...COORDINATION_AUDIT_ACTIONS,
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** Terminal payment edges whose capture is attributed per D5. */
export type PaymentTransitionAuditAction = Extract<
  AuditAction,
  'payment.succeeded' | 'payment.failed'
>;

// ---------------------------------------------------------------------------
// Resources (§5.1)
// ---------------------------------------------------------------------------

export const AUDIT_RESOURCE_TYPES = [
  'user',
  'member',
  'invitation',
  'api_key',
  'payment',
  'refund',
  'customer',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/** `resource_type` is derived from the action — never caller-supplied. */
const RESOURCE_TYPE_BY_ACTION: Record<AuditAction, AuditResourceType> = {
  'user.registered': 'user',
  'user.logged_in': 'user',
  'user.login_failed': 'user',
  'user.logged_out': 'user',
  'invitation.created': 'invitation',
  'invitation.canceled': 'invitation',
  'member.joined': 'member',
  'member.role_changed': 'member',
  'member.removed': 'member',
  'payment.created': 'payment',
  'payment.succeeded': 'payment',
  'payment.failed': 'payment',
  'refund.created': 'refund',
  'api_key.created': 'api_key',
  'api_key.revoked': 'api_key',
  'customer.created': 'customer',
  'customer.updated': 'customer',
  'customer.deleted': 'customer',
};

export function resourceTypeFor(action: AuditAction): AuditResourceType {
  const resourceType = RESOURCE_TYPE_BY_ACTION[action];
  if (!resourceType) {
    // Defensive: an action outside the catalog must never reach persistence.
    throw new Error(`Unknown audit action: ${String(action)}`);
  }
  return resourceType;
}

/** `environment` is app-validated (phase 4 D10 pattern), never free text. */
export const AUDIT_ENVIRONMENTS = ['test', 'live'] as const;
export type AuditEnvironment = (typeof AUDIT_ENVIRONMENTS)[number];

export function isAuditEnvironment(value: string): value is AuditEnvironment {
  return (AUDIT_ENVIRONMENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Capture shapes (§5.6 — how scope and actor are resolved)
// ---------------------------------------------------------------------------

/**
 * §5.2 auth events: organization scope is the acting user's memberships at
 * event time (D4 fan-out — possibly zero), actor is always the user.
 */
export interface AuditAuthCapture {
  action: AuthAuditAction;
  user_id: string;
  /** Server-assigned id of the triggering request (§4.2 rule 8). */
  request_id?: string | null;
}

/** §5.3 — the addressed organization; actor is the session user performing it. */
export type AuditAccessCapture =
  | {
      action: 'invitation.created' | 'invitation.canceled';
      organization_id: string;
      actor: AuditActor;
      invitation_id: string;
      role: string;
      request_id?: string | null;
    }
  | {
      action: 'member.joined';
      organization_id: string;
      actor: AuditActor;
      member_user_id: string;
      role: string;
      invitation_id: string;
      request_id?: string | null;
    }
  | {
      action: 'member.role_changed';
      organization_id: string;
      actor: AuditActor;
      member_user_id: string;
      previous_role: string;
      new_role: string;
      request_id?: string | null;
    }
  | {
      action: 'member.removed';
      organization_id: string;
      actor: AuditActor;
      member_user_id: string;
      role: string;
      request_id?: string | null;
    };

/** §5.4/§5.5 — project-scoped business actions; organization comes from the
 *  verified request scope (the resource's project organization). */
export type AuditProjectCapture =
  | {
      action: 'payment.created';
      organization_id: string;
      actor: AuditActor;
      project_id: string;
      environment: AuditEnvironment;
      payment_id: string;
      amount: string;
      currency: string;
      request_id?: string | null;
    }
  | {
      action: 'refund.created';
      organization_id: string;
      actor: AuditActor;
      project_id: string;
      environment: AuditEnvironment;
      refund_id: string;
      payment_id: string;
      amount: string;
      currency: string;
      request_id?: string | null;
    }
  | {
      action: 'api_key.created' | 'api_key.revoked';
      organization_id: string;
      actor: AuditActor;
      project_id: string;
      environment: AuditEnvironment;
      api_key_id: string;
      request_id?: string | null;
    }
  | {
      action: 'customer.created' | 'customer.updated' | 'customer.deleted';
      organization_id: string;
      actor: AuditActor;
      project_id: string;
      environment: AuditEnvironment;
      customer_id: string;
      request_id?: string | null;
    };

/**
 * §5.4 terminal payment edges. The capture deliberately carries **no**
 * organization and **no** actor: both are resolved by the capability from the
 * `payment.created` entry of the same payment (§5.6, D5), so the sweep and a
 * read-time catch-up record the payment's original creator, and a background
 * edge carries no `request_id` (AC6).
 */
export type AuditPaymentTransitionCapture =
  | {
      action: 'payment.succeeded';
      project_id: string;
      environment: AuditEnvironment;
      payment_id: string;
      amount: string;
      currency: string;
      request_id?: string | null;
    }
  | {
      action: 'payment.failed';
      project_id: string;
      environment: AuditEnvironment;
      payment_id: string;
      amount: string;
      currency: string;
      failure_code: string | null;
      request_id?: string | null;
    };

export type AuditCapture =
  | AuditAuthCapture
  | AuditAccessCapture
  | AuditProjectCapture
  | AuditPaymentTransitionCapture;

// ---------------------------------------------------------------------------
// Validation (§9 — catalog and enum values are validated server-side)
// ---------------------------------------------------------------------------

/**
 * Rejects anything outside the closed catalog before a row is built. Returns
 * narrowed values so the builders below stay exhaustive over `AuditAction`.
 */
export function assertValidCapture(capture: AuditCapture): AuditAction {
  if (!isAuditAction(capture.action)) {
    throw new Error(`Unknown audit action: ${String((capture as { action: string }).action)}`);
  }
  if (capture.action !== 'user.registered' && capture.action !== 'user.logged_in' &&
      capture.action !== 'user.login_failed' && capture.action !== 'user.logged_out') {
    // Auth captures carry a user id; every other capture carries a scope the
    // builder reads, so the actor is checked here (runtime, not only typed).
    const scope = capture as Exclude<AuditCapture, AuditAuthCapture>;
    if ('actor' in scope && !isAuditActorType(scope.actor.type)) {
      throw new Error(`Unknown audit actor type: ${String(scope.actor.type)}`);
    }
    if ('environment' in scope && !isAuditEnvironment(scope.environment)) {
      throw new Error(`Unknown audit environment: ${String(scope.environment)}`);
    }
  }
  return capture.action;
}

// ---------------------------------------------------------------------------
// `data` allowlist builders (§4.2 rule 7, D13)
// ---------------------------------------------------------------------------

type AllowlistedScalar = string | number | boolean | null;
export type AuditData = Record<string, AllowlistedScalar>;

/** Adds the common correlation key only when the action was request-driven
 *  (§4.2 rule 8) — background actions carry none, and an empty payload means
 *  `data` is omitted entirely. */
function withRequestId(
  data: AuditData,
  requestId: string | null | undefined,
): AuditData | null {
  const payload = requestId ? { ...data, request_id: requestId } : data;
  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * Builds the exact `data` object of one capture — a closed `switch` over the
 * catalog, so an unknown action is rejected rather than persisted and no
 * caller-controlled object shape can ever widen the stored fields.
 */
export function buildAuditData(capture: AuditCapture): AuditData | null {
  switch (capture.action) {
    // §5.2 — `request_id` only.
    case 'user.registered':
    case 'user.logged_in':
    case 'user.login_failed':
    case 'user.logged_out':
      return withRequestId({}, capture.request_id);

    // §5.3 — roles and the invitation id, bounded enums/uuids.
    case 'invitation.created':
    case 'invitation.canceled':
      return withRequestId({ role: capture.role }, capture.request_id);
    case 'member.joined':
      return withRequestId(
        { role: capture.role, invitation_id: capture.invitation_id },
        capture.request_id,
      );
    case 'member.role_changed':
      return withRequestId(
        { previous_role: capture.previous_role, new_role: capture.new_role },
        capture.request_id,
      );
    case 'member.removed':
      return withRequestId({ role: capture.role }, capture.request_id);

    // §5.4 — monetary amounts per ADR-0002/ADR-0003 (decimal string + code).
    case 'payment.created':
    case 'payment.succeeded':
      return withRequestId({ amount: capture.amount, currency: capture.currency }, capture.request_id);
    case 'payment.failed':
      return withRequestId(
        {
          amount: capture.amount,
          currency: capture.currency,
          failure_code: capture.failure_code,
        },
        capture.request_id,
      );
    case 'refund.created':
      return withRequestId(
        { payment_id: capture.payment_id, amount: capture.amount, currency: capture.currency },
        capture.request_id,
      );

    // §5.5 — `request_id` only (project/environment are D6 columns; changed
    // values are never echoed, D13).
    case 'api_key.created':
    case 'api_key.revoked':
    case 'customer.created':
    case 'customer.updated':
    case 'customer.deleted':
      return withRequestId({}, capture.request_id);

    default: {
      const unknown: never = capture;
      throw new Error(
        `Unknown audit action: ${String((unknown as { action: string }).action)}`,
      );
    }
  }
}

/** `resource_id` of a capture — every MVP action carries one (§4.2 rule 5). */
export function resourceIdOf(capture: AuditCapture): string {
  switch (capture.action) {
    case 'user.registered':
    case 'user.logged_in':
    case 'user.login_failed':
    case 'user.logged_out':
      return capture.user_id;
    case 'invitation.created':
    case 'invitation.canceled':
      return capture.invitation_id;
    case 'member.joined':
    case 'member.role_changed':
    case 'member.removed':
      return capture.member_user_id;
    case 'payment.created':
    case 'payment.succeeded':
    case 'payment.failed':
      return capture.payment_id;
    case 'refund.created':
      return capture.refund_id;
    case 'api_key.created':
    case 'api_key.revoked':
      return capture.api_key_id;
    case 'customer.created':
    case 'customer.updated':
    case 'customer.deleted':
      return capture.customer_id;
    default: {
      const unknown: never = capture;
      throw new Error(
        `Unknown audit action: ${String((unknown as { action: string }).action)}`,
      );
    }
  }
}

/** The row one capture produces for one organization (before the id/created_at
 *  the emitter owns). */
export interface AuditEntryDraft {
  id: string;
  organization_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: AuditAction;
  resource_type: AuditResourceType;
  resource_id: string;
  project_id: string | null;
  environment: AuditEnvironment | null;
  data: AuditData | null;
  created_at: Date;
}

/** Emitter-owned identity (ADR-0001): re-inserting the same draft inside the
 *  same transaction is a no-op rather than a duplicate (§4.2 rule 2). */
export function newAuditEntryId(): string {
  return uuidv7();
}
