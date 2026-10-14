/**
 * Unit tests for the bulk-corpus builders (phase 19 §7 / D9): direct
 * seeding is allowed only for corpus rows with **contract-valid values**,
 * so every invariant the API enforces at the boundary is asserted here —
 * the SQL builders are the last gate before the database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCorpus,
  buildCustomerRow,
  buildPaymentRow,
  customerInsertSql,
  paymentInsertSql,
  sqlString,
} from '../lib/corpus.mjs';

const PROJECT = '11111111-1111-7111-8111-111111111111';
const CUSTOMER = '22222222-2222-7222-8222-222222222222';

function customer(overrides = {}) {
  return buildCustomerRow({
    id: '33333333-3333-7333-8333-333333333333',
    projectId: PROJECT,
    environment: 'test',
    email: 'cust-000001@loadtest.invalid',
    name: 'Loadtest Customer 1',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  });
}

function payment(overrides = {}) {
  return buildPaymentRow({
    id: '44444444-4444-7444-8444-444444444444',
    projectId: PROJECT,
    environment: 'test',
    customerId: CUSTOMER,
    amountMinor: 1234n,
    status: 'succeeded',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  });
}

describe('sqlString', () => {
  it('doubles single quotes (PostgreSQL literal escaping)', () => {
    assert.equal(sqlString("O'Brien"), "'O''Brien'");
    assert.equal(sqlString('plain'), "'plain'");
  });
});

describe('buildCustomerRow', () => {
  it('accepts a contract-valid placeholder customer', () => {
    const row = customer();
    assert.equal(row.environment, 'test');
    assert.equal(row.name, 'Loadtest Customer 1');
  });

  it('rejects invalid environments', () => {
    assert.throws(() => customer({ environment: 'staging' }), /environment/);
  });

  it('rejects emails with quotes or missing domain (SQL/contract safety)', () => {
    assert.throws(() => customer({ email: "a'b@loadtest.invalid" }), /placeholder/);
    assert.throws(() => customer({ email: 'nodomain' }), /placeholder/);
  });

  it('enforces contract bounds (email ≤ 320, name ≤ 200)', () => {
    assert.throws(() => customer({ email: `${'a'.repeat(320)}@loadtest.invalid` }), /320/);
    assert.throws(() => customer({ name: 'n'.repeat(201) }), /200/);
  });
});

describe('buildPaymentRow', () => {
  it('succeeded rows never carry a failure code', () => {
    const row = payment();
    assert.equal(row.failureCode, null);
    assert.ok(row.simulationScenario === null || row.simulationScenario === 'succeed');
  });

  it('failed rows pair a catalog code with decline:<code>', () => {
    const row = payment({ status: 'failed' });
    assert.equal(row.failureCode, 'card_declined');
    assert.equal(row.simulationScenario, 'decline:card_declined');
    const custom = payment({ status: 'failed', failureCode: 'insufficient_funds' });
    assert.equal(custom.simulationScenario, 'decline:insufficient_funds');
  });

  it('rejects off-catalog statuses and failure codes', () => {
    assert.throws(() => payment({ status: 'refunded' }), /status/);
    assert.throws(() => payment({ status: 'failed', failureCode: 'stolen_card' }), /failureCode/);
    assert.throws(() => payment({ status: 'succeeded', failureCode: 'card_declined' }), /only valid on failed/);
  });

  it('rejects non-positive or non-integer amounts and non-usd currency', () => {
    assert.throws(() => payment({ amountMinor: 0n }), /positive/);
    assert.throws(() => payment({ amountMinor: -5n }), /positive/);
    assert.throws(() => payment({ amountMinor: 12.5 }), /positive/);
    assert.throws(() => payment({ currency: 'eur' }), /usd/);
  });

  it('bounds the description (≤ 500)', () => {
    assert.throws(() => payment({ description: 'd'.repeat(501) }), /500/);
  });
});

describe('insert SQL', () => {
  it('escapes hostile content (every single quote doubles — one SQL literal)', () => {
    const hostile = "evil'); DROP TABLE users;--";
    const row = customer({ email: 'safe@loadtest.invalid', name: hostile });
    const sql = customerInsertSql([row]);
    assert.ok(sql.includes("'evil''); DROP TABLE users;--'"), 'name is one fully escaped literal');
    assert.ok(sql.includes('ON CONFLICT (id) DO NOTHING'));
    // The value only ever appears as a parameter — the INSERT column list and
    // VALUES keywords are untouched by it.
    assert.match(sql, /^INSERT INTO customers \(id, project_id, environment, email, name, metadata, created_at, updated_at\)\n/);
  });

  it('renders nullable fields as NULL and amounts as bigint literals', () => {
    const sql = paymentInsertSql([payment({ description: null })]);
    assert.ok(sql.includes(', NULL,'));
    assert.ok(sql.includes(', 1234,'));
    assert.ok(sql.includes("'usd'"));
  });

  it('returns an empty string for an empty batch', () => {
    assert.equal(customerInsertSql([]), '');
    assert.equal(paymentInsertSql([]), '');
  });
});

describe('buildCorpus', () => {
  const now = Date.UTC(2026, 9, 14);
  const corpus = buildCorpus({
    projectId: PROJECT,
    environment: 'test',
    customerCount: 60,
    paymentCount: 400,
    customerSampleSize: 10,
    refundableCount: Number.MAX_SAFE_INTEGER,
    now,
  });

  it('produces the requested volumes', () => {
    assert.equal(corpus.customers.length, 60);
    assert.equal(corpus.payments.length, 400);
  });

  it('keeps every payment contract-valid', () => {
    for (const row of corpus.payments) {
      assert.ok(['pending', 'processing', 'succeeded', 'failed'].includes(row.status));
      assert.equal(row.environment, 'test');
      if (row.status === 'failed') {
        assert.equal(row.simulationScenario, `decline:${row.failureCode}`);
      } else {
        assert.equal(row.failureCode, null);
      }
      assert.ok(row.amountMinor > 0n);
    }
  });

  it('leaves only a small fresh open tail for the sweep (≤ 50)', () => {
    const open = corpus.payments.filter((p) => p.status === 'pending' || p.status === 'processing');
    assert.ok(open.length > 0 && open.length <= 50, `open tail was ${open.length}`);
  });

  it('samples and refundable pools contain succeeded payments only', () => {
    const byId = new Map(corpus.payments.map((p) => [p.id, p]));
    assert.equal(corpus.samplePaymentIds.length, 10);
    for (const id of corpus.samplePaymentIds) assert.equal(byId.get(id).status, 'succeeded');
    assert.ok(corpus.refundablePaymentIds.length > 0);
    for (const id of corpus.refundablePaymentIds) assert.equal(byId.get(id).status, 'succeeded');
  });

  it('spreads created_at across the history window with aligned uuidv7 ids', () => {
    const times = corpus.payments.map((p) => p.createdAt.getTime());
    const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    assert.ok(spanDays > 8, `expected ~10 days of history, got ${spanDays.toFixed(1)}`);
    for (const p of corpus.payments) {
      const prefix = Number.parseInt(p.id.replaceAll('-', '').slice(0, 12), 16);
      assert.equal(prefix, p.createdAt.getTime());
    }
  });

  it('uses unique ids across customers and payments', () => {
    const ids = [...corpus.customers, ...corpus.payments].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
