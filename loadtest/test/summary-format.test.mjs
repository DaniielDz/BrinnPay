/**
 * Unit tests for the pure summary shaping used by every scenario's
 * `handleSummary` (D1): the bytes written into the committed baseline must
 * be produced by exactly this code path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSummaryFiles,
  buildSummaryPayload,
  formatSummaryText,
  normalizeMetrics,
} from '../lib/summary-format.mjs';

const RAW_METRICS = {
  http_req_duration: { type: 'trend', values: { min: 1, max: 9, avg: 4, med: 3.5, 'p(90)': 7, 'p(95)': 8, 'p(99)': 8.9 } },
  http_reqs: { type: 'counter', values: { count: 120, rate: 2 } },
  http_req_failed: { type: 'rate', values: { passes: 118, fails: 2, rate: 0.0166 } },
  checks: { type: 'rate', values: { passes: 99, fails: 1, rate: 0.99 } },
  s3_payments_list_ms: { type: 'trend', values: { avg: 12, med: 10, 'p(95)': 30, min: 1, max: 60 } },
  vus: { type: 'gauge', values: { value: 10 } },
  broken: { type: 'trend', values: {} },
  junk: 'not-an-object',
};

describe('normalizeMetrics', () => {
  it('keeps typed metrics with finite numeric values only', () => {
    const out = normalizeMetrics(RAW_METRICS);
    assert.deepEqual(Object.keys(out).sort(), [
      'checks',
      'http_req_duration',
      'http_req_failed',
      'http_reqs',
      's3_payments_list_ms',
      'vus',
    ]);
    assert.equal(out.http_req_duration.type, 'trend');
    assert.equal(out.http_req_duration.values['p(95)'], 8);
  });

  it('tolerates missing/garbage input without throwing', () => {
    assert.deepEqual(normalizeMetrics(undefined), {});
    assert.deepEqual(normalizeMetrics(null), {});
    assert.deepEqual(normalizeMetrics({ a: 1 }), {});
  });

  it('drops non-numeric values inside otherwise valid metrics', () => {
    const out = normalizeMetrics({ m: { type: 'gauge', values: { good: 1, bad: 'x', nan: Number.NaN } } });
    assert.deepEqual(out.m.values, { good: 1 });
  });
});

describe('buildSummaryPayload', () => {
  it('orders headline metrics first and carries scenario metadata', () => {
    const payload = buildSummaryPayload(
      { scenario: 's3-payments-read', profile: { vus: 10 }, notes: 'catch-up' },
      { metrics: RAW_METRICS, state: 'some-state' },
    );
    assert.equal(payload.scenario, 's3-payments-read');
    assert.deepEqual(payload.profile, { vus: 10 });
    assert.equal(payload.notes, 'catch-up');
    assert.equal(payload.state, 'some-state');
    const keys = Object.keys(payload.metrics);
    assert.deepEqual(keys.slice(0, 4), ['http_req_duration', 'http_reqs', 'http_req_failed', 'checks']);
    assert.ok(keys.includes('s3_payments_list_ms'), 'custom metrics survive projection');
    assert.ok(!('broken' in payload.metrics) && !('junk' in payload.metrics));
    assert.match(payload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('formatSummaryText', () => {
  it('renders p50/p95/p99 lines for trends and rates as percentages', () => {
    const payload = buildSummaryPayload({ scenario: 'x', profile: {} }, { metrics: RAW_METRICS });
    const text = formatSummaryText(payload);
    const durationLine = text.split('\n').find((line) => line.startsWith('http_req_duration'));
    assert.ok(durationLine.includes('p50=3.5ms'));
    assert.ok(durationLine.includes('p95=8.0ms'));
    assert.ok(durationLine.includes('p99=8.9ms'));
    const failedLine = text.split('\n').find((line) => line.startsWith('http_req_failed'));
    assert.ok(failedLine.includes('rate=1.660%'));
    assert.ok(text.startsWith('scenario: x'));
    assert.ok(text.endsWith('\n'));
  });
});

describe('buildSummaryFiles', () => {
  it('writes <resultsDir>/<scenario>.json plus a stdout text block', () => {
    const files = buildSummaryFiles({ scenario: 's1-auth-session', profile: { vus: 5 } }, { metrics: RAW_METRICS });
    const names = Object.keys(files).sort();
    assert.deepEqual(names, ['/results/s1-auth-session.json', 'stdout']);
    const parsed = JSON.parse(files['/results/s1-auth-session.json']);
    assert.equal(parsed.scenario, 's1-auth-session');
    assert.equal(typeof files.stdout, 'string');
    assert.ok(files.stdout.includes('scenario: s1-auth-session'));
  });

  it('honours an explicit resultsDir (runner per-run subdirectory)', () => {
    const files = buildSummaryFiles(
      { scenario: 's2', profile: {}, resultsDir: '/results/run-20261014' },
      { metrics: RAW_METRICS },
    );
    assert.ok('/results/run-20261014/s2.json' in files);
  });
});
