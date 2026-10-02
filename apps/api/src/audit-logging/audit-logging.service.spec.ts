import { Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from './audit-logging.service';
import type { AuditCapture } from './audit-actions';

const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const OTHER_ORG_ID = '0192f2a0-0000-7000-8000-00000000000b';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000c';
const USER_ID = '0192f2a0-0000-7000-8000-00000000000d';
const KEY_ID = '0192f2a0-0000-7000-8000-00000000000e';
const PAYMENT_ID = '0192f2a0-0000-7000-8000-00000000000f';
const REQUEST_ID = 'req_0192f2a0000070008000000000000001';

interface InsertArgs {
  data: Array<Record<string, unknown>>;
  skipDuplicates?: boolean;
}

function txDouble() {
  return {
    organizationMember: { findMany: jest.fn() },
    auditLogEntry: { findFirst: jest.fn(), createMany: jest.fn() },
  };
}

describe('AuditLoggingService (phase 12 §4.1/§5.6/§6.2)', () => {
  let service: AuditLoggingService;
  let prisma: ReturnType<typeof txDouble>;
  let tx: ReturnType<typeof txDouble>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    prisma = txDouble();
    tx = txDouble();
    prisma.auditLogEntry.createMany.mockResolvedValue({ count: 1 });
    tx.auditLogEntry.createMany.mockResolvedValue({ count: 1 });
    tx.organizationMember.findMany.mockResolvedValue([]);
    prisma.organizationMember.findMany.mockResolvedValue([]);
    service = new AuditLoggingService(prisma as unknown as PrismaService);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  /** The `createMany` argument object of each call on the given handle. */
  const inserts = (handle: ReturnType<typeof txDouble>): InsertArgs[] =>
    handle.auditLogEntry.createMany.mock.calls.map((call) => call[0] as InsertArgs);

  /** The rows of the n-th `createMany` call on the given handle. */
  const rows = (handle: ReturnType<typeof txDouble>, n = 0): Array<Record<string, unknown>> =>
    inserts(handle)[n].data;

  // -------------------------------------------------------------------------
  // Scope resolution (§5.6)
  // -------------------------------------------------------------------------

  it('single-organization action: exactly one row for the verified organization', async () => {
    await service.record(tx as never, {
      action: 'payment.created',
      organization_id: ORG_ID,
      actor: { type: 'api_key', id: KEY_ID },
      project_id: PROJECT_ID,
      environment: 'live',
      payment_id: PAYMENT_ID,
      amount: '10.00',
      currency: 'usd',
      request_id: REQUEST_ID,
    });

    const args = inserts(tx);
    expect(args).toHaveLength(1);
    expect(args[0].skipDuplicates).toBe(true);
    expect(args[0].data).toHaveLength(1);
    expect(args[0].data[0]).toMatchObject({
      organizationId: ORG_ID,
      actorType: 'api_key',
      actorId: KEY_ID,
      action: 'payment.created',
      resourceType: 'payment',
      resourceId: PAYMENT_ID,
      projectId: PROJECT_ID,
      environment: 'live',
      data: { amount: '10.00', currency: 'usd', request_id: REQUEST_ID },
    });
    // Emitter-owned identity: a UUIDv7 id and an explicit timestamp (§4.2 rule 2).
    expect(args[0].data[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(args[0].data[0].createdAt).toBeInstanceOf(Date);
    // No platform-global row: organization scope is never null (§4.2 rule 3).
    expect(args[0].data[0].organizationId).not.toBeNull();
  });

  it('auth fan-out: one row per membership at event time — 0, 1 and N (D4)', async () => {
    // Zero memberships → no rows rather than an invalid row.
    tx.organizationMember.findMany.mockResolvedValueOnce([]);
    await service.record(tx as never, { action: 'user.logged_out', user_id: USER_ID, request_id: REQUEST_ID });
    expect(inserts(tx)).toHaveLength(0);

    // One membership (the ADR-0010 default organization, typically).
    tx.organizationMember.findMany.mockResolvedValueOnce([{ organizationId: ORG_ID }]);
    await service.record(tx as never, { action: 'user.registered', user_id: USER_ID, request_id: REQUEST_ID });
    expect(tx.organizationMember.findMany).toHaveBeenLastCalledWith({
      where: { userId: USER_ID },
      select: { organizationId: true },
    });
    expect(rows(tx, 0)).toHaveLength(1);
    expect(rows(tx, 0)[0]).toMatchObject({
      organizationId: ORG_ID,
      actorType: 'user',
      actorId: USER_ID,
      resourceType: 'user',
      resourceId: USER_ID,
      projectId: null,
      environment: null,
    });

    // Several memberships → one row each, same actor and resource.
    tx.organizationMember.findMany.mockResolvedValueOnce([
      { organizationId: ORG_ID },
      { organizationId: OTHER_ORG_ID },
    ]);
    await service.record(tx as never, { action: 'user.logged_in', user_id: USER_ID, request_id: REQUEST_ID });
    const fanOut = rows(tx, 1);
    expect(fanOut).toHaveLength(2);
    expect(fanOut.map((row) => row.organizationId)).toEqual([ORG_ID, OTHER_ORG_ID]);
  });

  it("background terminal transition: attributed to the payment's original creator (D5/AC6)", async () => {
    tx.auditLogEntry.findFirst.mockResolvedValue({
      organizationId: ORG_ID,
      actorType: 'api_key',
      actorId: KEY_ID,
    });

    await service.record(tx as never, {
      action: 'payment.succeeded',
      project_id: PROJECT_ID,
      environment: 'test',
      payment_id: PAYMENT_ID,
      amount: '10.00',
      currency: 'usd',
    });

    // The origin is read from the `payment.created` entry of the same payment.
    expect(tx.auditLogEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: 'payment.created',
          resourceType: 'payment',
          resourceId: PAYMENT_ID,
        },
      }),
    );
    const row = rows(tx)[0];
    expect(row).toMatchObject({
      organizationId: ORG_ID,
      actorType: 'api_key',
      actorId: KEY_ID,
      action: 'payment.succeeded',
      projectId: PROJECT_ID,
      environment: 'test',
    });
    // Background edges carry no request correlation (AC6).
    expect(row.data).toEqual({ amount: '10.00', currency: 'usd' });
    expect(row.data).not.toHaveProperty('request_id');
  });

  it('background terminal transition with no origin entry: skipped, never misattributed', async () => {
    tx.auditLogEntry.findFirst.mockResolvedValue(null);

    await service.record(tx as never, {
      action: 'payment.succeeded',
      project_id: PROJECT_ID,
      environment: 'test',
      payment_id: PAYMENT_ID,
      amount: '10.00',
      currency: 'usd',
    });

    expect(inserts(tx)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.succeeded', error_class: 'MissingPaymentCreatedEntry' }),
      expect.any(String),
    );
  });

  // -------------------------------------------------------------------------
  // Write semantics (D7) and exactly-once (§4.2 rule 2)
  // -------------------------------------------------------------------------

  it('record is fail-closed: an insert failure propagates so the caller rolls back (AC4)', async () => {
    tx.auditLogEntry.createMany.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.record(tx as never, {
        action: 'customer.created',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        customer_id: PAYMENT_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toThrow('connection lost');
    // The failure detail never carries the entry payload (§9).
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer.created',
        organization_id: ORG_ID,
        error_class: 'Error',
      }),
      expect.any(String),
    );
  });

  it('record rejects an unknown action before any row is built (fail-closed)', async () => {
    await expect(
      service.record(tx as never, { action: 'payment.refunded' } as unknown as AuditCapture),
    ).rejects.toThrow(/Unknown audit action/);
    expect(tx.auditLogEntry.createMany).not.toHaveBeenCalled();
  });

  it('omits `data` from the insert when the allowlist produced nothing', async () => {
    tx.organizationMember.findMany.mockResolvedValue([{ organizationId: ORG_ID }]);
    await service.record(tx as never, { action: 'user.registered', user_id: USER_ID, request_id: REQUEST_ID });
    await service.record(tx as never, { action: 'user.logged_in', user_id: USER_ID });

    expect(rows(tx, 0)[0]).toHaveProperty('data', { request_id: REQUEST_ID });
    expect(rows(tx, 1)[0]).not.toHaveProperty('data');
  });

  it("captureAuth writes on the capability's own connection, never through the caller tx", async () => {
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: ORG_ID }]);

    await service.captureAuth({ action: 'user.login_failed', user_id: USER_ID, request_id: REQUEST_ID });

    expect(prisma.auditLogEntry.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(tx.auditLogEntry.createMany).not.toHaveBeenCalled();
    expect(rows(prisma)[0]).toMatchObject({
      action: 'user.login_failed',
      organizationId: ORG_ID,
      resourceId: USER_ID,
      actorId: USER_ID,
      projectId: null,
      environment: null,
    });
  });

  it('captureAuth never throws: a failed write is logged (action + org + error class) and dropped (§6.2)', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: ORG_ID }]);
    prisma.auditLogEntry.createMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.captureAuth({ action: 'user.logged_in', user_id: USER_ID, request_id: REQUEST_ID }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.logged_in',
        organization_id: ORG_ID,
        error_class: 'Error',
      }),
      expect.any(String),
    );
    // The payload itself is never logged (§9).
    expect(JSON.stringify(warn.mock.calls)).not.toContain(USER_ID);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(REQUEST_ID);
  });

  it('captureAuth keeps a partial fan-out: independent inserts, failures dropped per organization (§6.2)', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([
      { organizationId: ORG_ID },
      { organizationId: OTHER_ORG_ID },
    ]);
    prisma.auditLogEntry.createMany
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      service.captureAuth({ action: 'user.logged_out', user_id: USER_ID, request_id: REQUEST_ID }),
    ).resolves.toBeUndefined();

    expect(prisma.auditLogEntry.createMany).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG_ID, error_class: 'Error' }),
      expect.any(String),
    );
  });

  it('captureAuth drops a non-authentication capture instead of failing the caller', async () => {
    await expect(
      service.captureAuth({
        action: 'payment.created',
        organization_id: ORG_ID,
        actor: { type: 'user', id: USER_ID },
        project_id: PROJECT_ID,
        environment: 'test',
        payment_id: PAYMENT_ID,
        amount: '1.00',
        currency: 'usd',
      } as AuditCapture),
    ).resolves.toBeUndefined();

    expect(prisma.auditLogEntry.createMany).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.created', error_class: 'InvalidCapture' }),
      expect.any(String),
    );
  });

  it('writes only the typed row shape — no free-form fields reach the insert (§9)', async () => {
    tx.organizationMember.findMany.mockResolvedValue([{ organizationId: ORG_ID }]);
    await service.record(tx as never, {
      action: 'member.removed',
      organization_id: ORG_ID,
      actor: { type: 'user', id: USER_ID },
      member_user_id: KEY_ID,
      role: 'admin',
      request_id: REQUEST_ID,
    });

    const row = rows(tx)[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        'action',
        'actorId',
        'actorType',
        'createdAt',
        'data',
        'environment',
        'id',
        'organizationId',
        'projectId',
        'resourceId',
        'resourceType',
      ].sort(),
    );
  });
});
