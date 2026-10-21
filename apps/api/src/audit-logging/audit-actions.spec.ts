import {
  assertValidCapture,
  AUDIT_ACTIONS,
  buildAuditData,
  isAuditAction,
  newAuditEntryId,
  resourceIdOf,
  resourceTypeFor,
  type AuditCapture,
} from './audit-actions';

const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const USER_ID = '0192f2a0-0000-7000-8000-00000000000c';
const KEY_ID = '0192f2a0-0000-7000-8000-00000000000d';
const PAYMENT_ID = '0192f2a0-0000-7000-8000-00000000000e';
const REFUND_ID = '0192f2a0-0000-7000-8000-00000000000f';
const CUSTOMER_ID = '0192f2a0-0000-7000-8000-000000000100';
const API_KEY_ID = '0192f2a0-0000-7000-8000-000000000101';
const INVITATION_ID = '0192f2a0-0000-7000-8000-000000000102';
const REQUEST_ID = 'req_0192f2a00000700080000000000000ff';

const sessionPayment = (over: Record<string, unknown> = {}): AuditCapture =>
  ({
    action: 'payment.created',
    organization_id: ORG_ID,
    actor: { type: 'user', id: USER_ID },
    project_id: PROJECT_ID,
    environment: 'test',
    payment_id: PAYMENT_ID,
    amount: '10.00',
    currency: 'usd',
    request_id: REQUEST_ID,
    ...over,
  }) as AuditCapture;

describe('audit action catalog (phase 12 §5)', () => {
  it('is the closed catalog of §5.1–§5.5 — 18 actions', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        'user.registered',
        'user.logged_in',
        'user.login_failed',
        'user.logged_out',
        'invitation.created',
        'invitation.canceled',
        'member.joined',
        'member.role_changed',
        'member.removed',
        'payment.created',
        'payment.succeeded',
        'payment.failed',
        'refund.created',
        'api_key.created',
        'api_key.revoked',
        'customer.created',
        'customer.updated',
        'customer.deleted',
      ].sort(),
    );
    expect(AUDIT_ACTIONS).toHaveLength(18);
  });

  it('rejects any action outside the catalog (§5.1 — never ad hoc)', () => {
    expect(isAuditAction('payment.refunded')).toBe(false);
    expect(isAuditAction('organization.created')).toBe(false);
    expect(isAuditAction('')).toBe(false);
    expect(() => assertValidCapture({ action: 'payment.refunded' } as unknown as AuditCapture)).toThrow(
      /Unknown audit action/,
    );
    // Unknown actions are rejected before a row is ever assembled.
    expect(() => resourceIdOf({ action: 'nope' } as unknown as AuditCapture)).toThrow(
      /Unknown audit action/,
    );
    expect(() => resourceTypeFor('nope' as never)).toThrow(/Unknown audit action/);
  });

  it('derives resource_type from the action — never caller input', () => {
    expect(resourceTypeFor('user.logged_in')).toBe('user');
    expect(resourceTypeFor('member.role_changed')).toBe('member');
    expect(resourceTypeFor('invitation.created')).toBe('invitation');
    expect(resourceTypeFor('payment.succeeded')).toBe('payment');
    expect(resourceTypeFor('refund.created')).toBe('refund');
    expect(resourceTypeFor('api_key.revoked')).toBe('api_key');
    expect(resourceTypeFor('customer.deleted')).toBe('customer');
  });

  it('resolves resource_id per action (every MVP action carries one, §4.2 rule 5)', () => {
    expect(resourceIdOf({ action: 'user.registered', user_id: USER_ID })).toBe(USER_ID);
    expect(
      resourceIdOf({
        action: 'member.removed',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        member_user_id: USER_ID,
        role: 'member',
      }),
    ).toBe(USER_ID);
    expect(
      resourceIdOf({
        action: 'invitation.canceled',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        invitation_id: INVITATION_ID,
        role: 'admin',
      }),
    ).toBe(INVITATION_ID);
    expect(
      resourceIdOf({
        action: 'refund.created',
        organization_id: ORG_ID,
        actor: { type: 'api_key', id: KEY_ID },
        project_id: PROJECT_ID,
        environment: 'live',
        refund_id: REFUND_ID,
        payment_id: PAYMENT_ID,
        amount: '5.00',
        currency: 'usd',
      }),
    ).toBe(REFUND_ID);
    expect(
      resourceIdOf({
        action: 'api_key.revoked',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        api_key_id: API_KEY_ID,
      }),
    ).toBe(API_KEY_ID);
    expect(
      resourceIdOf({
        action: 'customer.deleted',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        customer_id: CUSTOMER_ID,
      }),
    ).toBe(CUSTOMER_ID);
    expect(
      resourceIdOf({
        action: 'payment.succeeded',
        project_id: PROJECT_ID,
        environment: 'test',
        payment_id: PAYMENT_ID,
        amount: '10.00',
        currency: 'usd',
      }),
    ).toBe(PAYMENT_ID);
  });

  it('validates the environment and actor enums server-side (§9)', () => {
    expect(() => assertValidCapture(sessionPayment({ environment: 'staging' }))).toThrow(
      /Unknown audit environment/,
    );
    expect(() => assertValidCapture(sessionPayment({ actor: { type: 'service', id: USER_ID } }))).toThrow(
      /Unknown audit actor type/,
    );
    // A well-formed capture of every scope kind is accepted.
    expect(
      assertValidCapture({
        action: 'payment.succeeded',
        project_id: PROJECT_ID,
        environment: 'live',
        payment_id: PAYMENT_ID,
        amount: '1.00',
        currency: 'usd',
      }),
    ).toBe('payment.succeeded');
    expect(assertValidCapture({ action: 'user.logged_out', user_id: USER_ID })).toBe('user.logged_out');
  });

  it('emits an emitter-owned UUIDv7 id per entry (ADR-0001, §4.2 rule 2)', () => {
    const first = newAuditEntryId();
    const second = newAuditEntryId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(first).not.toBe(second);
  });
});

describe('per-action data allowlist builders (§4.2 rule 7, D13)', () => {
  it('keeps only the allowlisted fields — a payload-shaped object cannot widen them', () => {
    const widened = {
      ...sessionPayment(),
      // Everything a caller would love to smuggle in.
      customer_id: CUSTOMER_ID,
      description: 'invoice for Ada',
      ip: '203.0.113.9',
      user_agent: 'Mozilla/5.0',
      email: 'ada@example.com',
      password: 'hunter2',
      idempotency_key: 'order_123',
      headers: { authorization: 'Bearer sk_live_x' },
      reason: 'goodwill',
    } as unknown as AuditCapture;

    expect(buildAuditData(widened)).toEqual({
      amount: '10.00',
      currency: 'usd',
      request_id: REQUEST_ID,
    });
  });

  it('omits `data` entirely when the action carries no context (§4.2 rule 7)', () => {
    expect(buildAuditData({ action: 'user.logged_in', user_id: USER_ID })).toBeNull();
    expect(
      buildAuditData({
        action: 'api_key.revoked',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        api_key_id: API_KEY_ID,
      }),
    ).toBeNull();
    expect(
      buildAuditData({
        action: 'customer.created',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        customer_id: CUSTOMER_ID,
      }),
    ).toBeNull();
  });

  it('carries `request_id` only when the action was request-driven (§4.2 rule 8)', () => {
    expect(buildAuditData({ action: 'user.registered', user_id: USER_ID, request_id: REQUEST_ID })).toEqual({
      request_id: REQUEST_ID,
    });
    expect(
      buildAuditData({
        action: 'payment.succeeded',
        project_id: PROJECT_ID,
        environment: 'test',
        payment_id: PAYMENT_ID,
        amount: '10.00',
        currency: 'usd',
      }),
    ).toEqual({ amount: '10.00', currency: 'usd' });
    expect(
      buildAuditData({
        action: 'payment.failed',
        project_id: PROJECT_ID,
        environment: 'test',
        payment_id: PAYMENT_ID,
        amount: '10.00',
        currency: 'usd',
        failure_code: 'card_declined',
      }),
    ).toEqual({ amount: '10.00', currency: 'usd', failure_code: 'card_declined' });
  });

  it('records access-control context as bounded scalars only (§5.3)', () => {
    expect(
      buildAuditData({
        action: 'invitation.created',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        invitation_id: INVITATION_ID,
        role: 'admin',
        request_id: REQUEST_ID,
      }),
    ).toEqual({ role: 'admin', request_id: REQUEST_ID });

    expect(
      buildAuditData({
        action: 'member.role_changed',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        member_user_id: USER_ID,
        previous_role: 'member',
        new_role: 'admin',
        request_id: REQUEST_ID,
      }),
    ).toEqual({ previous_role: 'member', new_role: 'admin', request_id: REQUEST_ID });

    expect(
      buildAuditData({
        action: 'member.joined',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        member_user_id: USER_ID,
        role: 'viewer',
        invitation_id: INVITATION_ID,
        request_id: REQUEST_ID,
      }),
    ).toEqual({ role: 'viewer', invitation_id: INVITATION_ID, request_id: REQUEST_ID });

    // The invited email is third-party PII and never recorded (D13).
    const withEmail = {
      action: 'invitation.created',
      organization_id: ORG_ID,
      actor: { type: 'user', id: USER_ID },
      invitation_id: INVITATION_ID,
      role: 'admin',
      email: 'guest@example.com',
      request_id: REQUEST_ID,
    } as unknown as AuditCapture;
    expect(buildAuditData(withEmail)).toEqual({ role: 'admin', request_id: REQUEST_ID });
  });

  it('never echoes a refund reason or changed customer values (D13)', () => {
    expect(
      buildAuditData({
        action: 'refund.created',
        organization_id: ORG_ID,
        actor: { type: 'api_key', id: KEY_ID },
        project_id: PROJECT_ID,
        environment: 'live',
        refund_id: REFUND_ID,
        payment_id: PAYMENT_ID,
        amount: '4.00',
        currency: 'usd',
        request_id: REQUEST_ID,
      } as AuditCapture),
    ).toEqual({ payment_id: PAYMENT_ID, amount: '4.00', currency: 'usd', request_id: REQUEST_ID });

    const updated = {
      action: 'customer.updated',
      organization_id: ORG_ID,
      actor: { type: 'user', id: USER_ID },
      project_id: PROJECT_ID,
      environment: 'test',
      customer_id: CUSTOMER_ID,
      changed: { name: 'Ada Lovelace', email: 'ada@example.com' },
      request_id: REQUEST_ID,
    } as unknown as AuditCapture;
    expect(buildAuditData(updated)).toEqual({ request_id: REQUEST_ID });
  });

  it('rejects an action the builders do not know (exhaustive switch)', () => {
    expect(() => buildAuditData({ action: 'not.an.action' } as unknown as AuditCapture)).toThrow(
      /Unknown audit action/,
    );
  });
});
