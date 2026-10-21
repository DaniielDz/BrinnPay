import { uuidv7 } from './uuid';

describe('uuidv7', () => {
  it('returns a parseable, correctly-formatted UUID', () => {
    const value = uuidv7();
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('sets the UUIDv7 version and variant bits', () => {
    const value = uuidv7();
    const hex = value.replace(/-/g, '');
    // Version field (chars 12-15 of the hex string) must be '7'.
    expect(hex.slice(12, 16)).toMatch(/^7[0-9a-f]{3}$/);
    // Variant field (first char of the fourth group) must be 8, 9, a or b.
    expect(hex.slice(16, 17)).toMatch(/^[89ab]$/);
  });

  it('embeds the provided timestamp as the 48-bit prefix', () => {
    const now = Date.now();
    const value = uuidv7(now);
    const hex = value.replace(/-/g, '');
    const prefix = BigInt(`0x${hex.slice(0, 12)}`);
    expect(Number(prefix)).toBe(now);
  });

  it('produces distinct values across calls', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).not.toBe(b);
  });
});