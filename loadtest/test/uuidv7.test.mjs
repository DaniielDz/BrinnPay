/**
 * Unit tests for the UUIDv7 generator used by the bulk seeder (D9): corpus
 * ids must keep the RFC 9562 shape and the millisecond-time prefix that
 * makes `ORDER BY id ASC` chronological (the cursor contract's ordering
 * assumption).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { uuidv7 } from '../lib/uuidv7.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function timePrefixMillis(uuid) {
  const hex = uuid.replaceAll('-', '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

describe('uuidv7', () => {
  it('produces a lowercase RFC 9562 v7 UUID', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.match(uuidv7(), UUID_RE);
    }
  });

  it('encodes the provided timestamp in the first 48 bits', () => {
    const now = 1_760_000_123_456;
    const uuid = uuidv7(now);
    assert.equal(timePrefixMillis(uuid), now);
  });

  it('orders by time across distinct milliseconds', () => {
    const early = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_800_000_000_000);
    assert.ok(early < later, `${early} should sort before ${later}`);
  });

  it('differs across calls (random tail)', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) seen.add(uuidv7());
    assert.equal(seen.size, 1000);
  });
});
