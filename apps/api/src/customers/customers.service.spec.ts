import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CustomersScope } from './customers-scope';
import { CustomersService } from './customers.service';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const CUSTOMER_ID = '0192f2a0-0000-7000-8000-00000000000c';

function sessionScope(projectId: string = PROJECT_ID): CustomersScope {
  return {
    mode: 'session',
    project: { project_id: projectId, organization_id: 'org-1' },
    project_id: projectId,
  };
}

function apiKeyScope(environment: 'test' | 'live' = 'test', projectId: string = PROJECT_ID): CustomersScope {
  return {
    mode: 'api_key',
    key: { key_id: 'key-1', project_id: projectId, environment },
    project_id: projectId,
    environment,
  };
}

function customerRow(overrides: Partial<{
  id: string;
  projectId: string;
  environment: string;
  email: string;
  name: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? CUSTOMER_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    environment: overrides.environment ?? 'test',
    email: overrides.email ?? 'ada@example.com',
    name: overrides.name ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-09-10T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-09-10T00:00:00.000Z'),
  };
}

describe('CustomersService (phase 6 §4.2, D1/D2/D3/D6/D7)', () => {
  let service: CustomersService;
  let prisma: {
    customer: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      customer: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    };
    service = new CustomersService(prisma as unknown as PrismaService);
  });

  describe('list (§4.2, D2)', () => {
    it('session mode: requires an explicit environment (400 VALIDATION_ERROR)', async () => {
      await expect(service.list(sessionScope(), {})).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });

    it('session mode: lists within the project+environment (never mixed)', async () => {
      prisma.customer.findMany.mockResolvedValue([customerRow()]);

      await service.list(sessionScope(), { environment: 'live' });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: PROJECT_ID, environment: 'live' },
          take: 21,
        }),
      );
    });

    it('api-key mode: derives the environment from the key and refuses a conflicting explicit one (422)', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.list(apiKeyScope('live'), { environment: 'live' });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: PROJECT_ID, environment: 'live' } }),
      );

      await expect(service.list(apiKeyScope('live'), { environment: 'test' })).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
      });
      expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
    });

    it('composes the search term (case-insensitive substring on email/name, D3)', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.list(sessionScope(), { environment: 'test', search: '  ADA  ' });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { email: { contains: 'ADA', mode: 'insensitive' } },
              { name: { contains: 'ADA', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('ignores an empty/whitespace-only search term', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.list(sessionScope(), { environment: 'test', search: '   ' });

      const calledWith = prisma.customer.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(calledWith.where.OR).toBeUndefined();
    });

    it('paginates with limit+1 and reports has_more/next_cursor', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => customerRow({ id: `c-${i + 1}` }));
      prisma.customer.findMany.mockResolvedValue(rows);

      const page = await service.list(sessionScope(), { environment: 'test', limit: 20 });

      expect(page.data).toHaveLength(20);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).toBe('c-20');
    });

    it('resumes after a cursor with id > cursor', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.list(sessionScope(), { environment: 'test', cursor: 'c-1' });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { gt: 'c-1' } }) }),
      );
    });

    it('projects the contract shape (snake_case, metadata defaults to {})', async () => {
      prisma.customer.findMany.mockResolvedValue([customerRow()]);

      const page = await service.list(sessionScope(), { environment: 'test' });

      expect(page.data[0]).toEqual({
        id: CUSTOMER_ID,
        project_id: PROJECT_ID,
        environment: 'test',
        email: 'ada@example.com',
        name: null,
        metadata: {},
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      });
    });
  });

  describe('create (§4.2, D1/D2/D6)', () => {
    it('normalizes email (trim + lowercase), trims name, defaults metadata to {}', async () => {
      prisma.customer.create.mockImplementation(
        async ({ data }: { data: { email: string; name: string | null; metadata: unknown } }) => ({
          id: CUSTOMER_ID,
          projectId: PROJECT_ID,
          environment: 'test',
          email: data.email,
          name: data.name,
          metadata: data.metadata,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      const result = await service.create(sessionScope(), {
        environment: 'test',
        email: '  ADA@Example.COM  ',
        name: '  Ada Lovelace  ',
      });

      expect(prisma.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: PROJECT_ID,
            environment: 'test',
            email: 'ada@example.com',
            name: 'Ada Lovelace',
            metadata: {},
          }),
        }),
      );
      expect(result.email).toBe('ada@example.com');
      expect(result.metadata).toEqual({});
    });

    it('api-key mode: rejects a body environment that does not match the key (422)', async () => {
      await expect(service.create(apiKeyScope('live'), { environment: 'test', email: 'a@b.co' })).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
      });
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it('accepts the keyed environment in api-key mode', async () => {
      prisma.customer.create.mockImplementation(async ({ data }: { data: { email: string } }) => ({
        id: CUSTOMER_ID,
        projectId: PROJECT_ID,
        environment: 'live',
        email: data.email,
        name: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const result = await service.create(apiKeyScope('live'), { environment: 'live', email: 'a@b.co' });

      expect(result.environment).toBe('live');
    });

    it('rejects blank or over-long names with VALIDATION_ERROR before writing', async () => {
      await expect(
        service.create(sessionScope(), { environment: 'test', email: 'a@b.co', name: '   ' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(
        service.create(sessionScope(), { environment: 'test', email: 'a@b.co', name: 'x'.repeat(201) }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });
  });

  describe('retrieve (§4.2)', () => {
    it('session mode: returns the scoped customer', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());

      const result = await service.retrieve(sessionScope(), CUSTOMER_ID);

      expect(prisma.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_ID, projectId: PROJECT_ID } }),
      );
      expect(result.project_id).toBe(PROJECT_ID);
    });

    it('api-key mode: cross-environment customers are 404 (non-disclosure)', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.retrieve(apiKeyScope('live'), CUSTOMER_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_ID, projectId: PROJECT_ID, environment: 'live' } }),
      );
    });

    it('a malformed customer_id is a 404 without querying the DB', async () => {
      await expect(service.retrieve(sessionScope(), 'not-a-uuid')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown customer', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.retrieve(sessionScope(), CUSTOMER_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('update (§4.2, D6/D7)', () => {
    it('changes provided fields only and advances updated_at', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      prisma.customer.update.mockImplementation(
        async ({ data }: { data: { email: string; name: string; updatedAt: Date } }) => ({
          id: CUSTOMER_ID,
          projectId: PROJECT_ID,
          environment: 'test',
          email: data.email,
          name: data.name,
          metadata: {},
          createdAt: new Date('2026-09-10T00:00:00.000Z'),
          updatedAt: data.updatedAt,
        }),
      );

      await service.update(
        sessionScope(),
        CUSTOMER_ID,
        { email: '  GRACE@Example.com  ', name: '  Grace Hopper  ' },
      );

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CUSTOMER_ID },
          data: expect.objectContaining({
            email: 'grace@example.com',
            name: 'Grace Hopper',
            updatedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('replaces the metadata map wholesale (D6) and only touches updated_at', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow({ metadata: { vip: 'true' } }));
      prisma.customer.update.mockImplementation(async ({ data }: { data: { metadata: unknown } }) => ({
        id: CUSTOMER_ID,
        projectId: PROJECT_ID,
        environment: 'test',
        email: 'ada@example.com',
        name: null,
        metadata: data.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const result = await service.update(sessionScope(), CUSTOMER_ID, { metadata: { tier: 'gold' } });

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ metadata: { tier: 'gold' } }) }),
      );
      expect(result.metadata).toEqual({ tier: 'gold' });
    });

    it('a no-op patch (equal values) returns the current state without writing (updated_at stable)', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow({ name: 'Ada' }));

      const result = await service.update(sessionScope(), CUSTOMER_ID, { name: 'Ada' });

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(result.name).toBe('Ada');
    });

    it('a patch with no fields is a no-op returning the current state', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow({ name: 'Ada' }));

      const result = await service.update(sessionScope(), CUSTOMER_ID, {});

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(result.name).toBe('Ada');
    });

    it('rejects a blank name with VALIDATION_ERROR', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());

      await expect(service.update(sessionScope(), CUSTOMER_ID, { name: '   ' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown or cross-project customer', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.update(sessionScope(), CUSTOMER_ID, { name: 'Ada' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('returns 404 when the customer disappears between read and update (P2025)', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      prisma.customer.update.mockRejectedValue(knownError('P2025'));

      await expect(service.update(sessionScope(), CUSTOMER_ID, { name: 'Ada' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('delete (§4.2)', () => {
    it('hard-deletes the scoped customer row', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      prisma.customer.delete.mockResolvedValue(customerRow());

      await expect(service.delete(sessionScope(), CUSTOMER_ID)).resolves.toBeUndefined();
      expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: CUSTOMER_ID } });
    });

    it('returns 404 for an unknown customer without deleting', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.delete(sessionScope(), CUSTOMER_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.customer.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the customer disappears between read and delete (P2025)', async () => {
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      prisma.customer.delete.mockRejectedValue(knownError('P2025'));

      await expect(service.delete(sessionScope(), CUSTOMER_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });
});