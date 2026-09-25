import { ApiError } from '../errors/api-error';
import { formatAmountMinor, isUsd, parseAmountMinor } from './money';

describe('money helper (phase 7 §4.8, ADR-0002/ADR-0003, D7/D8)', () => {
  describe('parseAmountMinor — decimal string → integer minor units', () => {
    it.each([
      ['10', 1000n],
      ['10.00', 1000n],
      ['10.5', 1050n],
      ['10.50', 1050n],
      ['0.01', 1n],
      ['010.5', 1050n],
      ['1'.repeat(500), BigInt('1'.repeat(500)) * 100n],
    ] as const)('parses "%s" → %s', (input, expected) => {
      expect(parseAmountMinor(input)).toBe(expected);
    });

    it('rejects zero and negative amounts (strictly positive, D7)', () => {
      for (const input of ['0', '0.00', '0.0', '-5', '-0.01', '00.00']) {
        expect(() => parseAmountMinor(input)).toThrow(ApiError);
        expect(() => parseAmountMinor(input)).toThrowError(
          expect.objectContaining({
            code: 'VALIDATION_ERROR',
            details: { fields: [{ field: 'amount', errors: expect.any(Array) }] },
          }),
        );
      }
    });

    it.each(['10.001', '.50', '10.', '10,00', '1e3', ' 10', '10 ', 'abc', ''])(
      'rejects malformed / scale-violating value "%s"',
      (input) => {
        expect(() => parseAmountMinor(input)).toThrow(ApiError);
      },
    );
  });

  describe('formatAmountMinor — integer minor units → decimal string', () => {
    it.each([
      [1000n, '10.00'],
      [5n, '0.05'],
      [100n, '1.00'],
      [1n, '0.01'],
      [1000000000000000000n, '10000000000000000.00'],
    ] as const)('formats %s → "%s"', (minor, expected) => {
      expect(formatAmountMinor(minor)).toBe(expected);
    });

    it('round-trips parse → format', () => {
      for (const input of ['0.01', '10.00', '1234.56', '99999.99']) {
        expect(formatAmountMinor(parseAmountMinor(input))).toBe(input);
      }
    });
  });

  describe('currency (ADR-0003)', () => {
    it('accepts usd only', () => {
      expect(isUsd('usd')).toBe(true);
      expect(isUsd('eur')).toBe(false);
      expect(isUsd('USD')).toBe(false);
    });
  });
});