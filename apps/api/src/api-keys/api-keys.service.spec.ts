import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashApiKey } from './api-key-crypto';
import { ApiKeysService } from './api-keys.service';

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma error ${code}`, {
    code,
    clientVersion: '7.10.0',
  });
}

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const KEY_ID = '0192f2a0-0000-7000-8000-00000000000c';

function keyRow(overrides: Partial<{
  id: string;
  projectId: string;
  environment: string;
  keyHash: string;
  revokedAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? KEY_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    environment: overrides.environment ?? 'test',
    keyHash: overrides.keyHash ?? 'hash',
    revokedAt: overrides.revokedAt ?? null,
    createdAt: new Date(),
  };
}

describe('ApiKeysService (phase 5 §4.2, D4/D5)', () => {
  let service: ApiKeysService;
  let prisma: {
    apiKey: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      apiKey: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    service = new ApiKeysService(prisma as unknown as PrismaService);
  });

  describe('list (§4.2, D5)', () => {
    it('returns project-wide keys (both environments) with contract metadata', async () => {
      prisma.apiKey.findMany.mockResolvedValue([
        keyRow({ id: 'k-1', environment: 'test' }),
        keyRow({ id: 'k-2', environment: 'live', revokedAt: new Date() }),
      ]);

      const page = await service.list(PROJECT_ID);

      expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: PROJECT_ID }, take: 21 }),
      );
      expect(page.data).toHaveLength(2);
      expect(page.data[0]).toEqual({
        id: 'k-1',
        project_id: PROJECT_ID,
        environment: 'test',
        created_at: expect.any(Date),
        revoked_at: null,
      });
      // Never the plaintext (or its hash) in the list payload.
      expect(JSON.stringify(page.data)).not.toContain('sk_');
      expect(JSON.stringify(page.data)).not.toContain('keyHash');
    });

    it('includes revoked keys in the listing with a past revoked_at', async () => {
      const revokedAt = new Date('2026-09-22T10:00:00.000Z');
      prisma.apiKey.findMany.mockResolvedValue([keyRow({ revokedAt })]);

      const page = await service.list(PROJECT_ID);

      expect(page.data[0].revoked_at).toEqual(revokedAt);
    });

    it('paginates with limit+1 and reports has_more/next_cursor', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => keyRow({ id: `k-${i + 1}` }));
      prisma.apiKey.findMany.mockResolvedValue(rows);

      const page = await service.list(PROJECT_ID, 20);

      expect(page.data).toHaveLength(20);
      expect(page.has_more).toBe(true);
      expect(page.next_cursor).toBe('k-20');
    });
  });

  describe('create (§4.2, ADR-0006, D5)', () => {
    it('stores only the SHA-256 hash and returns the plaintext exactly once', async () => {
      prisma.apiKey.create.mockImplementation(async ({ data }: { data: { keyHash: string; projectId: string; environment: string } }) => ({
        id: KEY_ID,
        projectId: data.projectId as string,
        environment: data.environment as string,
        keyHash: data.keyHash,
        revokedAt: null,
        createdAt: new Date(),
      }));

      const result = await service.create(PROJECT_ID, 'live');

      const { key, ...meta } = result;
      expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
      expect(meta).toEqual({
        id: KEY_ID,
        project_id: PROJECT_ID,
        environment: 'live',
        created_at: expect.any(Date),
      });

      // The stored hash matches the returned plaintext — and nothing else
      // persists the credential.
      const createCall = prisma.apiKey.create.mock.calls[0][0] as {
        data: { keyHash: string };
      };
      expect(createCall.data.keyHash).toBe(hashApiKey(key));
      expect(createCall.data).not.toHaveProperty('key');
    });

    it('creates a test-scoped key when environment=test', async () => {
      prisma.apiKey.create.mockImplementation(async ({ data }: { data: { environment: string } }) => ({
        id: KEY_ID,
        projectId: PROJECT_ID,
        environment: data.environment,
        revokedAt: null,
        createdAt: new Date(),
      }));

      const result = await service.create(PROJECT_ID, 'test');

      expect(result.key.startsWith('sk_test_')).toBe(true);
      expect(result.environment).toBe('test');
    });
  });

  describe('revoke (§4.2, D5)', () => {
    it('revokes an active key by setting revoked_at', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: null }));
      prisma.apiKey.update.mockResolvedValue(keyRow({ revokedAt: new Date() }));

      await expect(service.revoke(PROJECT_ID, KEY_ID)).resolves.toBeUndefined();

      expect(prisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: KEY_ID },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('is idempotent: revoking an already-revoked key is a no-op (no update)', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: new Date() }));

      await expect(service.revoke(PROJECT_ID, KEY_ID)).resolves.toBeUndefined();
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    });

    it.each(['not-a-uuid', ''])('rejects a malformed api_key_id (%s) with 404 without querying', async (id) => {
      await expect(service.revoke(PROJECT_ID, id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown key with 404', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(service.revoke(PROJECT_ID, KEY_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('rejects a cross-project key with the same 404 (no disclosure)', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(keyRow({ projectId: '0192f2a0-0000-7000-8000-0000000000ff' }));

      await expect(service.revoke(PROJECT_ID, KEY_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the key is deleted between the read and the update (P2025)', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: null }));
      prisma.apiKey.update.mockRejectedValue(knownError('P2025'));

      await expect(service.revoke(PROJECT_ID, KEY_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });
});