import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import type { RequestLogListQueryDto } from './dto/request-log-list-query.dto';
import { RequestLogsService } from './request-logs.service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = `req_${'d'.repeat(32)}`;
const CURSOR = '99999999-9999-4999-8999-999999999999';

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    organizationId: '22222222-2222-4222-8222-222222222222',
    userId: null,
    apiKeyId: null,
    environment: 'test',
    method: 'GET',
    path: '/api/v1/customers',
    statusCode: 200,
    durationMs: 12,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('RequestLogsService.list (phase 11 §4.3, D1/D4/D8)', () => {
  let service: RequestLogsService;
  let prisma: { requestLog: { findMany: jest.Mock } };
  let findMany: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn().mockResolvedValue([]);
    prisma = { requestLog: { findMany } };

    const moduleRef = await Test.createTestingModule({
      providers: [RequestLogsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(RequestLogsService);
  });

  function query(overrides: Partial<RequestLogListQueryDto> = {}): RequestLogListQueryDto {
    return { ...overrides };
  }

  it('scopes to the authorized project, ascending by id, reading one extra row (D4)', async () => {
    await service.list(PROJECT_ID, query());

    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT_ID },
      orderBy: { id: 'asc' },
      take: 21,
    });
  });

  it('applies the optional environment filter as equality (D1)', async () => {
    await service.list(PROJECT_ID, query({ environment: 'live' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID, environment: 'live' },
      }),
    );
  });

  it('applies the exact request-id filter inside the project (D8)', async () => {
    await service.list(PROJECT_ID, query({ request_id: REQUEST_ID }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID, requestId: REQUEST_ID },
      }),
    );
  });

  it('combines both filters with the cursor', async () => {
    await service.list(PROJECT_ID, query({ environment: 'test', request_id: REQUEST_ID, cursor: CURSOR }));

    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: PROJECT_ID,
        environment: 'test',
        requestId: REQUEST_ID,
        id: { gt: CURSOR },
      },
      orderBy: { id: 'asc' },
      take: 21,
    });
  });

  it('honours an explicit limit at the shared boundary', async () => {
    await service.list(PROJECT_ID, query({ limit: 2 }));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it('builds a page and reports has_more from the extra row', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    await expect(service.list(PROJECT_ID, query({ limit: 1 }))).resolves.toEqual({
      data: [expect.objectContaining({ id: 'a' })],
      next_cursor: 'a',
      has_more: true,
    });

    findMany.mockResolvedValue([row({ id: 'a' })]);
    await expect(service.list(PROJECT_ID, query({ limit: 1 }))).resolves.toEqual({
      data: [expect.objectContaining({ id: 'a' })],
      next_cursor: null,
      has_more: false,
    });
  });

  it('returns the contracted snake_case projection and nothing else (AC6)', async () => {
    findMany.mockResolvedValue([row()]);

    const page = await service.list(PROJECT_ID, query());
    const [record] = page.data;

    expect(Object.keys(record).sort()).toEqual([
      'api_key_id',
      'created_at',
      'duration_ms',
      'environment',
      'id',
      'method',
      'organization_id',
      'path',
      'project_id',
      'request_id',
      'status_code',
      'user_id',
    ]);
    expect(record).toMatchObject({
      request_id: REQUEST_ID,
      project_id: PROJECT_ID,
      user_id: null,
      method: 'GET',
      path: '/api/v1/customers',
      status_code: 200,
      duration_ms: 12,
    });
  });

  it('omits duration_ms when the row carries no measurement (contract: optional)', async () => {
    findMany.mockResolvedValue([row({ durationMs: null })]);

    const page = await service.list(PROJECT_ID, query());
    expect(page.data[0]).not.toHaveProperty('duration_ms');
    expect(page.data[0]).toMatchObject({ status_code: 200 });
  });

  it('never asks Prisma for a column outside the projection', async () => {
    findMany.mockResolvedValue([row()]);

    await service.list(PROJECT_ID, query({ environment: 'test', request_id: REQUEST_ID, cursor: CURSOR }));

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('select');
    expect(args).not.toHaveProperty('include');
  });
});
