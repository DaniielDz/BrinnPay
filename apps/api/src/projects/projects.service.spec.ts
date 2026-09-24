import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from './projects.service';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

const USER_ID = '0192f2a0-0000-7000-8000-000000000008';
const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';

function user(overrides: Partial<{ id: string; email: string; name: string | null }> = {}) {
  return {
    id: overrides.id ?? USER_ID,
    email: overrides.email ?? 'owner@example.com',
    name: overrides.name ?? null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
  };
}

function membershipRow(role: string = 'admin', userId: string = USER_ID) {
  return {
    id: 'member-1',
    organizationId: ORG_ID,
    userId,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function projectRow(overrides: Partial<{
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? PROJECT_ID,
    organizationId: overrides.organizationId ?? ORG_ID,
    name: overrides.name ?? 'Payments API',
    createdAt: overrides.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-09-01T00:00:00.000Z'),
  };
}

describe('ProjectsService (phase 5 §4.2, D2/D3/D6)', () => {
  let service: ProjectsService;
  let prisma: {
    project: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    organizationMember: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      project: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      organizationMember: { findUnique: jest.fn() },
    };
    service = new ProjectsService(prisma as unknown as PrismaService);
  });

  describe('list (§4.2)', () => {
    it('lists projects across the caller’s memberships, scoped by member relation', async () => {
      prisma.project.findMany.mockResolvedValue([projectRow()]);

      const page = await service.listForUser(USER_ID);

      expect(prisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organization: { members: { some: { userId: USER_ID } } },
          },
          take: 21,
        }),
      );
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id: PROJECT_ID,
        organization_id: ORG_ID,
        name: 'Payments API',
        // D6: both environments are always derived — never stored.
        environments: ['test', 'live'],
      });
      expect(page.has_more).toBe(false);
      expect(page.next_cursor).toBeNull();
    });

    it('paginates with limit+1 and reports has_more/next_cursor', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => projectRow({ id: `p-${i + 1}` }));
      prisma.project.findMany.mockResolvedValue(rows);

      const page = await service.listForUser(USER_ID, 20);

      expect(page.data).toHaveLength(20);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).toBe('p-20');
    });

    it('resumes after a cursor with id > cursor', async () => {
      prisma.project.findMany.mockResolvedValue([projectRow({ id: 'p-2' })]);

      await service.listForUser(USER_ID, 20, 'p-1');

      expect(prisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { gt: 'p-1' } }) }),
      );
    });
  });

  describe('create (§4.2, D3)', () => {
    it('creates the project trimmed, with both environments always derived', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(membershipRow('admin'));
      prisma.project.create.mockImplementation(async ({ data }: { data: { name: string; organizationId: string } }) => ({
        id: PROJECT_ID,
        organizationId: data.organizationId as string,
        name: data.name,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const result = await service.create(user(), ORG_ID, '  Payments API  ');

      expect(prisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Payments API', organizationId: ORG_ID }),
        }),
      );
      expect(result.name).toBe('Payments API');
      expect(result.environments).toEqual(['test', 'live']);
    });

    it('rejects a non-member target organization with 404 (invisible org)', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(service.create(user(), ORG_ID, 'Payments API')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('rejects a member without projects.create with 403', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(membershipRow('viewer'));

      await expect(service.create(user(), ORG_ID, 'Payments API')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('rejects a blank or over-long name with VALIDATION_ERROR before writing', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(membershipRow('admin'));

      await expect(service.create(user(), ORG_ID, '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(service.create(user(), ORG_ID, 'x'.repeat(201))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prisma.project.create).not.toHaveBeenCalled();
    });
  });

  describe('retrieve (§4.2)', () => {
    it('returns the project with derived environments', async () => {
      prisma.project.findUnique.mockResolvedValue(projectRow());

      const result = await service.retrieve(PROJECT_ID);

      expect(result.environments).toEqual(['test', 'live']);
      expect(prisma.project.findUnique).toHaveBeenCalledWith({ where: { id: PROJECT_ID } });
    });

    it('returns 404 for an unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(service.retrieve(PROJECT_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('update (§4.2)', () => {
    it('renames the project and advances updated_at', async () => {
      prisma.project.update.mockResolvedValue(projectRow({ name: 'Checkout API', updatedAt: new Date() }));

      await service.update(PROJECT_ID, '  Checkout API  ');

      expect(prisma.project.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROJECT_ID },
          data: expect.objectContaining({ name: 'Checkout API' }),
        }),
      );
    });

    it('is a no-op when no field is provided (returns the current state)', async () => {
      prisma.project.findUnique.mockResolvedValue(projectRow());

      const result = await service.update(PROJECT_ID);

      expect(result.name).toBe('Payments API');
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('rejects a blank name with VALIDATION_ERROR', async () => {
      expect(prisma.project.findUnique).not.toHaveBeenCalled();

      await expect(service.update(PROJECT_ID, '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the project disappears between guard and update (P2025)', async () => {
      prisma.project.update.mockRejectedValue(knownError('P2025'));

      await expect(service.update(PROJECT_ID, 'Checkout API')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('delete (§4.2, D7)', () => {
    it('deletes the project row (DB cascades tenant rows: api_keys)', async () => {
      prisma.project.delete.mockResolvedValue(projectRow());

      await expect(service.delete(PROJECT_ID)).resolves.toBeUndefined();
      expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: PROJECT_ID } });
    });

    it('returns 404 when the project was removed between guard and delete (P2025)', async () => {
      prisma.project.delete.mockRejectedValue(knownError('P2025'));

      await expect(service.delete(PROJECT_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });
});