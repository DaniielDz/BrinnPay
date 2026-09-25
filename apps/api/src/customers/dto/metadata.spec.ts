import { validate } from 'class-validator';

import { IsFlatStringMap } from './metadata';

class Stub {
  @IsFlatStringMap()
  metadata?: unknown;
}

async function validateMetadata(value: unknown): Promise<boolean> {
  const stub = new Stub();
  stub.metadata = value;
  const errors = await validate(stub);
  return errors.length === 0;
}

describe('metadata flat string-map rule (phase 6 D6)', () => {
  it('accepts an empty map and a small string map', async () => {
    await expect(validateMetadata({})).resolves.toBe(true);
    await expect(validateMetadata({ vip: 'true', tier: 'gold', note: 'prefers email' })).resolves.toBe(true);
  });

  it('rejects non-object values (null, arrays, primitives)', async () => {
    await expect(validateMetadata(null)).resolves.toBe(false);
    // `undefined` is skipped by `@ValidateIf(… !== undefined)` in the DTOs.
    await expect(validateMetadata([])).resolves.toBe(false);
    await expect(validateMetadata('x')).resolves.toBe(false);
    await expect(validateMetadata(42)).resolves.toBe(false);
  });

  it('rejects values that are not strings', async () => {
    await expect(validateMetadata({ flag: true })).resolves.toBe(false);
    await expect(validateMetadata({ count: 7 })).resolves.toBe(false);
    await expect(validateMetadata({ nested: { a: 'b' } })).resolves.toBe(false);
  });

  it('rejects keys longer than 40 characters', async () => {
    await expect(validateMetadata({ [('k'.repeat(41))]: 'v' })).resolves.toBe(false);
    await expect(validateMetadata({ [('k'.repeat(40))]: 'v' })).resolves.toBe(true);
  });

  it('rejects values longer than 500 characters', async () => {
    await expect(validateMetadata({ key: 'v'.repeat(501) })).resolves.toBe(false);
    await expect(validateMetadata({ key: 'v'.repeat(500) })).resolves.toBe(true);
  });

  it('rejects more than 50 entries', async () => {
    const large: Record<string, string> = {};
    for (let i = 0; i < 51; i += 1) large[`k${i}`] = 'v';
    await expect(validateMetadata(large)).resolves.toBe(false);
  });
});