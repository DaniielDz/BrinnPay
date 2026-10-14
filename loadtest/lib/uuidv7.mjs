/**
 * UUIDv7 generator (RFC 9562) for the load-test seeder.
 *
 * Port of `apps/api/src/common/uuid/uuid.ts` — kept byte-for-byte equivalent
 * so corpus rows use exactly the identifier shape the API generates (the
 * cursor contract orders lists by id ascending, which is chronological only
 * because the first 48 bits carry the millisecond timestamp).
 *
 * Node-side only (uses `node:crypto`); k6 scenarios never import this file.
 */
import { randomBytes } from 'node:crypto';

const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;

function byteToHex(value) {
  return value.toString(16).padStart(2, '0');
}

/**
 * Returns a UUIDv7 string. `nowMillis` is injectable so a seeded corpus can
 * carry historical timestamps whose ids sort in the same order.
 */
export function uuidv7(nowMillis = Date.now()) {
  const bytes = randomBytes(16);

  bytes[0] = Math.floor(nowMillis / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(nowMillis / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(nowMillis / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(nowMillis / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(nowMillis / 2 ** 8) & 0xff;
  bytes[5] = nowMillis & 0xff;

  bytes[VERSION_BYTE_INDEX] = (bytes[VERSION_BYTE_INDEX] & 0x0f) | 0x70;
  bytes[VARIANT_BYTE_INDEX] = (bytes[VARIANT_BYTE_INDEX] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byteToHex).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
