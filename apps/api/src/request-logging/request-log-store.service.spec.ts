import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import type { RequestLogRecord } from './request-log-record';
import {
  provideRequestLogRetentionPolicy,
  RequestLogStoreService,
  REQUEST_LOG_RETENTION_POLICY,
} from './request-log-store.service';

/** Mirrors the store's batch constants so the paging assertions track them. */
const CLEANUP_BATCH = 500;
const CLEANUP_MAX_PAGES = 20;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function record(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    request_id: `req_${'a'.repeat(32)}`,
    project_id: '11111111-1111-4111-8111-111111111111',
    organization_id: '22222222-2222-4222-8222-222222222222',
    user_id: null,
    api_key_id: null,
    environment: 'test',
    method: 'GET',
    path: '/api/v1/customers',
    status_code: 200,
    duration_ms: 12,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('request-log retention policy (phase 11 D5)', () => {
  it('defaults to 30 days with an hourly pass', () => {
    const policy = provideRequestLogRetentionPolicy({ get: () => undefined } as never);
    expect(policy.retentionMs).toBe(RETENTION_MS);
    expect(policy.cleanupIntervalMs).toBe(3_600_000);
  });

  it('reads the window and cadence from configuration', () => {
    const values: Record<string, number> = {
      'requestLogging.retentionDays': 7,
      'requestLogging.cleanupIntervalMs': 900_000,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService;

    expect(provideRequestLogRetentionPolicy(config)).toEqual({
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 900_000,
    });
  });
});

describe('RequestLogStoreService', () => {
  let service: RequestLogStoreService;
  let prisma: { requestLog: { create: jest.Mock; findMany: jest.Mock; deleteMany: jest.Mock } };
  let logError: jest.Mock;
  let logWarn: jest.Mock;

  beforeEach(async () => {
    prisma = {
      requestLog: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestLogStoreService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: REQUEST_LOG_RETENTION_POLICY,
          useValue: { retentionMs: RETENTION_MS, cleanupIntervalMs: 3_600_000 },
        },
      ],
    }).compile();

    service = moduleRef.get(RequestLogStoreService);
    // Capture the private logger rather than the process logger: the assertion
    // is about *what* is written to a log line, not about the transport.
    logError = jest.fn();
    logWarn = jest.fn();
    Object.assign(service as unknown as { logger: unknown }, {
      logger: { error: logError, warn: logWarn, log: jest.fn() },
    });
  });

  describe('write (phase 11 §5.2, D3)', () => {
    it('maps the snake_case allowlist onto the Prisma columns', async () => {
      await service.write(record());

      expect(prisma.requestLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.requestLog.create).toHaveBeenCalledWith({
        data: {
          id: '55555555-5555-4555-8555-555555555555',
          requestId: `req_${'a'.repeat(32)}`,
          projectId: '11111111-1111-4111-8111-111111111111',
          organizationId: '22222222-2222-4222-8222-222222222222',
          userId: null,
          apiKeyId: null,
          environment: 'test',
          method: 'GET',
          path: '/api/v1/customers',
          statusCode: 200,
          durationMs: 12,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      });
      // The mapping is the second half of the allowlist: it must write nothing
      // beyond the columns above.
      expect(Object.keys((prisma.requestLog.create.mock.calls[0] as [{ data: object }])[0].data).sort()).toEqual([
        'apiKeyId',
        'createdAt',
        'durationMs',
        'environment',
        'id',
        'method',
        'organizationId',
        'path',
        'projectId',
        'requestId',
        'statusCode',
        'userId',
      ]);
    });

    it('never throws when the store is unavailable', async () => {
      prisma.requestLog.create.mockRejectedValue(new Error('connection terminated'));

      await expect(service.write(record())).resolves.toBeUndefined();
    });

    it('logs the request id and the error class only — never the message or the payload', async () => {
      // The message is where a database or validation error can echo a value
      // back (a Prisma frame, a unique-violation detail), so §8 allows the
      // *class* through and nothing else.
      prisma.requestLog.create.mockRejectedValue(new Error('value card_number=4242424242424242 rejected'));
      const payload = record({ path: '/api/v1/payments/SECRET-ROUTE' });

      await service.write(payload);

      expect(logError).toHaveBeenCalledTimes(1);
      const [context, message] = logError.mock.calls[0] as [Record<string, unknown>, string];
      expect(context).toEqual({ request_id: payload.request_id, reason: 'Error' });
      expect(message).toMatch(/dropped/i);
      // §8: no column value, no message, no body, no header ever reaches a log line.
      const logged = JSON.stringify(logError.mock.calls);
      expect(logged).not.toContain('4242424242424242');
      expect(logged).not.toContain('SECRET-ROUTE');
      expect(logged).not.toContain(payload.project_id);
      expect(logged).not.toContain(payload.id);
    });
  });

  describe('cleanupExpired (phase 11 D5)', () => {
    it('deletes only the rows past the retention window, by id', async () => {
      const now = new Date('2026-10-01T12:00:00.000Z');
      prisma.requestLog.findMany.mockResolvedValue([{ id: 'log_1' }, { id: 'log_2' }]);
      prisma.requestLog.deleteMany.mockResolvedValue({ count: 2 });

      await expect(service.cleanupExpired(now)).resolves.toBe(2);

      const cutoff = new Date(now.getTime() - RETENTION_MS);
      expect(prisma.requestLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
        }),
      );
      expect(prisma.requestLog.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['log_1', 'log_2'] } },
      });
    });

    it('pages through a backlog instead of deleting it in one statement', async () => {
      const fullPage = Array.from({ length: CLEANUP_BATCH }, (_, index) => ({ id: `log_${index}` }));
      prisma.requestLog.findMany
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([{ id: 'log_last' }]);
      prisma.requestLog.deleteMany.mockImplementation(
        async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }),
      );

      await expect(service.cleanupExpired()).resolves.toBe(CLEANUP_BATCH + 1);
      expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(2);
    });

    it('stops at the page ceiling so a huge backlog carries over to the next pass', async () => {
      prisma.requestLog.findMany.mockResolvedValue(
        Array.from({ length: CLEANUP_BATCH }, (_, index) => ({ id: `log_${index}` })),
      );
      prisma.requestLog.deleteMany.mockResolvedValue({ count: CLEANUP_BATCH });

      await expect(service.cleanupExpired()).resolves.toBe(CLEANUP_BATCH * CLEANUP_MAX_PAGES);
      expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(CLEANUP_MAX_PAGES);
    });

    it('reports zero when nothing has expired', async () => {
      await expect(service.cleanupExpired()).resolves.toBe(0);
      expect(prisma.requestLog.deleteMany).not.toHaveBeenCalled();
    });

    it('keeps readiness-independent semantics: a failure logs and returns the honest count', async () => {
      const fullPage = Array.from({ length: CLEANUP_BATCH }, (_, index) => ({ id: `log_${index}` }));
      prisma.requestLog.findMany
        .mockResolvedValueOnce(fullPage)
        .mockRejectedValueOnce(new Error('deadlock detected'));
      prisma.requestLog.deleteMany.mockResolvedValue({ count: CLEANUP_BATCH });

      // The first page really was deleted, so the count must not claim zero and
      // the failure must not escape the pass.
      await expect(service.cleanupExpired()).resolves.toBe(CLEANUP_BATCH);
      expect(logWarn).toHaveBeenCalledTimes(1);
      const [context] = logWarn.mock.calls[0] as [Record<string, unknown>];
      expect(context).toEqual({ reason: 'Error', removed: CLEANUP_BATCH });
    });
  });
});
