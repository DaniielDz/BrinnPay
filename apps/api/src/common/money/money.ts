import { ApiError } from '../errors/api-error';

/**
 * Money handling (phase 7 §4.8, ADR-0002/ADR-0003).
 *
 * The single currency/money helper module of the API: amounts are decimal
 * strings at the boundary (the contract's `MoneyAmount`) and integer minor
 * units internally (Prisma `BigInt` → PostgreSQL `bigint`). No code path
 * operates on floating-point money; `BigInt` is converted to the decimal
 * string before any JSON serialization (`JSON.stringify(BigInt)` throws).
 */

/** The contract's `MoneyAmount` pattern (`^[0-9]+(\.[0-9]{1,2})?$`). */
export const MONEY_AMOUNT_REGEX = /^[0-9]+(\.[0-9]{1,2})?$/;

/** USD only in the MVP (ADR-0003); the field is kept for forward
 *  compatibility. */
export const USD_CURRENCY = 'usd';

export function isUsd(currency: string): boolean {
  return currency === USD_CURRENCY;
}

/**
 * Parses a decimal-string amount (e.g. `"10.00"`) into integer minor units
 * (`1000n`). Format violations (contract `MoneyAmount`), zero, and negative
 * values are rejected as a 400 `VALIDATION_ERROR` with a field error on
 * `amount` (D7). Leading zeros in the whole part are accepted (`"010.5"` →
 * `1050n`); no upper bound in the MVP (BigInt storage, format-bounded input).
 */
export function parseAmountMinor(value: string): bigint {
  if (typeof value !== 'string' || !MONEY_AMOUNT_REGEX.test(value)) {
    throw amountValidation('Amount must match the format ^[0-9]+(\\.[0-9]{1,2})?$');
  }

  const [whole = '0', fraction = ''] = value.split('.');
  const wholeMinor = BigInt(whole) * 100n;
  const fractionMinor = BigInt(fraction.padEnd(2, '0') || '0');
  const minor = wholeMinor + fractionMinor;

  if (minor <= 0n) {
    throw amountValidation('Amount must be greater than zero');
  }
  return minor;
}

/** Formats integer minor units (USD scale 2) as a decimal string
 *  (`1000n` → `"10.00"`). Never serializes raw `BigInt`. */
export function formatAmountMinor(amountMinor: bigint): string {
  const whole = amountMinor / 100n;
  const fraction = amountMinor % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

function amountValidation(message: string): ApiError {
  return ApiError.validation({
    fields: [{ field: 'amount', errors: [message] }],
  });
}