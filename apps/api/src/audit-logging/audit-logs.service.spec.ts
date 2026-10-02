import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService, type AuditLogEntryResponse } from './audit-logs.service';

const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const OTHER_ORG_ID = '0192f2a0-0000-7000-8000-00000000000b';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000c';

interface Row {
  id: string;
  organizationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  environment: string | null;
  data: unknown;
  createdAt: Date;
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    organizationId: ORG_ID,
    actorType: 'user',
    actorId: '0192f2a0-0000-7000-8000-00000000000d',
    action: 'customer.created',
    resourceType: 'customer',
    resourceId: '0192f2a0-0000-7000-8000-00000000000e',
    projectId: PROJECT_ID,
    environment: 'test',
    data: { request_id: 'req_x' },
    createdAt: new Date('2026-10-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AuditLogsService (phase 12 §4.3, D10–D12)', () => {
  let prisma: { auditLogEntry: { findMany: jest.Mock } };
  let service: AuditLogsService;

  beforeEach(() => {
    prisma = { auditLogEntry: { findMany: jest.fn() } };
    service = new AuditLogsService(prisma as unknown as PrismaService);
  });

  it('selects strictly by the guard-resolved organization, ordered ascending by id (D10, §9)', async () => {
    prisma.auditLogEntry.findMany.mockResolvedValue([]);

    await service.list(ORG_ID, {});

    expect(prisma.auditLogEntry.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { id: 'asc' },
      take: 21, // DEFAULT_LIST_LIMIT + 1 — `has_more` without a second query
    });
  });

  it('applies only the shared limit/cursor pagination — no filter surface beyond it (D11)', async () => {
    prisma.auditLogEntry.findMany.mockResolvedValue([]);

    await service.list(ORG_ID, { limit: 5, cursor: '0192f2a0-0000-7000-8000-0000000000ff' });

    expect(prisma.auditLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, id: { gt: '0192f2a0-0000-7000-8000-0000000000ff' } },
        take: 6,
      }),
    );
  });

  it('pages with `next_cursor`/`has_more` from a single query (shared cursor pattern)', async () => {
    const full = Array.from({ length: 6 }, (_, index) => row(`0192f2a0-0000-7000-8000-00000000010${index}`));
    prisma.auditLogEntry.findMany.mockResolvedValueOnce(full);

    const page = await service.list(ORG_ID, { limit: 5 });

    expect(page.has_more).toBe(true);
    expect(page.data).toHaveLength(5);
    expect(page.next_cursor).toBe('0192f2a0-0000-7000-8000-000000000104');

    prisma.auditLogEntry.findMany.mockResolvedValueOnce(full.slice(0, 3));
    const tail = await service.list(ORG_ID, { limit: 5 });
    expect(tail).toEqual({ data: expect.any(Array), next_cursor: null, has_more: false });
    expect(tail.data).toHaveLength(3);
  });

  it('projects the contracted field set — D6 fields are always present, `data` only when it holds context', async () => {
    prisma.auditLogEntry.findMany.mockResolvedValueOnce([
      row('0192f2a0-0000-7000-8000-000000000110'),
      row('0192f2a0-0000-7000-8000-000000000111', {
        action: 'payment.succeeded',
        resourceType: 'payment',
        projectId: null,
        environment: null,
        data: null,
      }),
      row('0192f2a0-0000-7000-8000-000000000112', { data: [] }),
    ]);

    const page = await service.list(ORG_ID, {});
    const [first, withoutContext, arrayData] = page.data as AuditLogEntryResponse[];

    expect(Object.keys(first).sort()).toEqual(
      [
        'action',
        'actor_id',
        'actor_type',
        'created_at',
        'data',
        'environment',
        'id',
        'organization_id',
        'project_id',
        'resource_id',
        'resource_type',
      ].sort(),
    );
    expect(first.project_id).toBe(PROJECT_ID);
    expect(first.environment).toBe('test');
    expect(first.data).toEqual({ request_id: 'req_x' });

    // D6: project/environment are explicit columns of the contract — null, not absent.
    expect(withoutContext).toHaveProperty('project_id', null);
    expect(withoutContext).toHaveProperty('environment', null);
    expect(withoutContext).not.toHaveProperty('data');

    // A non-object `data` (unreachable through the write path) is dropped, not echoed.
    expect(arrayData).not.toHaveProperty('data');
  });

  it('never leaks a row of another organization — the filter is mandatory, not a hint', async () => {
    prisma.auditLogEntry.findMany.mockResolvedValue([
      row('0192f2a0-0000-7000-8000-000000000113'),
    ]);

    const page = await service.list(ORG_ID, {});
    const where = (prisma.auditLogEntry.findMany.mock.calls[0][0] as { where: { organizationId: string } })
      .where;
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.organizationId).not.toBe(OTHER_ORG_ID);
    expect(page.data.every((entry) => entry.organization_id === ORG_ID)).toBe(true);
  });
});
