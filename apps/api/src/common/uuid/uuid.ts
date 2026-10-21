import { randomBytes } from 'node:crypto';

/** Index of the version-nibble byte and the variant-nibble byte. */
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;

export function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Returns a UUIDv7 string (RFC 9562). The first 48 bits carry the current
 * Unix epoch in milliseconds; the remaining bits are random. Version (0111)
 * and variant (10) bits are set per the RFC. IDs are generated in application
 * code and stored in PostgreSQL `uuid` columns (ADR-0001).
 */
export function uuidv7(nowMillis: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit big-endian millisecond timestamp across bytes 0..5.
  bytes[0] = Math.floor(nowMillis / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(nowMillis / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(nowMillis / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(nowMillis / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(nowMillis / 2 ** 8) & 0xff;
  bytes[5] = nowMillis & 0xff;

  // Version 7: 0b0111 in the version field (bits 12–15 of the 4th group).
  bytes[VERSION_BYTE_INDEX] = (bytes[VERSION_BYTE_INDEX] & 0x0f) | 0x70;

  // Variant: 0b10xx in the most significant bits of the 5th group.
  bytes[VARIANT_BYTE_INDEX] = (bytes[VARIANT_BYTE_INDEX] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byteToHex).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}