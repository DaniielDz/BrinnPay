import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createStats,
  pathKey,
  recordWebhook,
  statsSnapshot,
} from '../scripts/receiver.mjs';

test('pathKey returns the counter object, not the path (regression: 2nd delivery crashed the receiver)', () => {
  const stats = createStats();
  const first = pathKey(stats, '/webhooks/ok/a');
  assert.deepEqual(first, { total: 0, ok: 0, failed: 0 });
  first.total += 1;
  const second = pathKey(stats, '/webhooks/ok/a');
  assert.equal(second, first);
  assert.equal(second.total, 1);
});

test('recordWebhook counts ok deliveries and answers 200', () => {
  const stats = createStats();
  const result = recordWebhook(stats, '/webhooks/ok/a');
  assert.deepEqual(result, { status: 200, failing: false });
  assert.deepEqual(stats, {
    total: 1,
    ok: 1,
    failed: 0,
    paths: { '/webhooks/ok/a': { total: 1, ok: 1, failed: 0 } },
  });
});

test('recordWebhook counts fail-path deliveries per path and answers 500', () => {
  const stats = createStats();
  assert.deepEqual(recordWebhook(stats, '/webhooks/fail/b'), { status: 500, failing: true });
  recordWebhook(stats, '/webhooks/fail/b');
  recordWebhook(stats, '/webhooks/ok/c');
  assert.equal(stats.total, 3);
  assert.equal(stats.failed, 2);
  assert.equal(stats.ok, 1);
  assert.deepEqual(stats.paths, {
    '/webhooks/fail/b': { total: 2, ok: 0, failed: 2 },
    '/webhooks/ok/c': { total: 1, ok: 1, failed: 0 },
  });
});

test('statsSnapshot copies path counters so /stats consumers cannot mutate live state', () => {
  const stats = createStats();
  recordWebhook(stats, '/webhooks/ok/a');
  const snapshot = statsSnapshot(stats);
  snapshot.total = 999;
  snapshot.paths['/webhooks/ok/a'].total = 999;
  assert.equal(stats.total, 1);
  assert.equal(stats.paths['/webhooks/ok/a'].total, 1);
});
