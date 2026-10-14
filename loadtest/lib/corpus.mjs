/**
 * Bulk-corpus SQL builders (phase 19 D9).
 *
 * Direct database seeding is allowed **only** for bulk corpus rows (customers,
 * payments) with contract-valid values — identity, capability and everything
 * security-relevant is created through the public API by `scripts/seed.mjs`.
 * The builders here are pure functions over plain objects so the row shapes
 * can be unit-tested without a database.
 *
 * Column sets match `apps/api/prisma/schema.prisma` exactly:
 *
 * - `customers(id, project_id, environment, email, name, metadata,
 *    created_at, updated_at)`
 * - `payments(id, project_id, environment, customer_id, amount_minor,
 *    currency, status, failure_code, simulation_scenario, description,
 *    created_at, updated_at)`
 *
 * Contract-validity rules enforced here (phase 6 §4.2 / phase 7 §4.2 /
 * phase 16 §4.5):
 *
 * - environment ∈ {test, live}; currency = 'usd'
 * - status ∈ {pending, processing, succeeded, failed}; a `failed` row carries
 *   a catalog `failure_code` and a `decline:<code>` simulation scenario;
 *   `succeeded` rows never carry one
 * - email ≤ 320 chars, name ≤ 200 chars, description ≤ 500 chars
 * - amounts are positive integer minor units (bigint in the column)
 * - ids are UUIDv7 and sort in the same order as `created_at`
 */

import { uuidv7 } from './uuidv7.mjs';

export const ENVIRONMENTS = ['test', 'live'];
export const PAYMENT_STATUSES = ['succeeded', 'failed', 'pending', 'processing'];
export const FAILURE_CODES = ['card_declined', 'insufficient_funds', 'processing_timeout'];

const SAFE_EMAIL_LOCAL_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_EMAIL_DOMAIN_RE = /^[a-z0-9.-]+$/i;

/** Quotes a string as a PostgreSQL string literal ('' doubling). */
export function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Quotes a value that must never be null in the corpus. */
export function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function assertEnvironment(value) {
  if (!ENVIRONMENTS.includes(value)) {
    throw new Error(`environment must be one of ${ENVIRONMENTS.join(', ')}`);
  }
  return value;
}

/** Builds one contract-valid customer row object (not SQL yet). */
export function buildCustomerRow({ id, projectId, environment, email, name, createdAt }) {
  assertEnvironment(projectId ? environment : environment);
  const [, domain] = requireText(email, 'email').split('@');
  if (!domain || !SAFE_EMAIL_LOCAL_RE.test(email.split('@')[0]) || !SAFE_EMAIL_DOMAIN_RE.test(domain)) {
    throw new Error(`email must be a plain placeholder address without quotes: ${email}`);
  }
  if (email.length > 320) throw new Error('email must be at most 320 characters');
  if (name !== null && name !== undefined && name.length > 200) {
    throw new Error('name must be at most 200 characters');
  }
  return {
    id,
    projectId,
    environment,
    email,
    name: name ?? null,
    createdAt,
  };
}

/**
 * Builds one contract-valid payment row object.
 *
 * `status` drives the invariant pair (failure_code, simulationScenario):
 *
 * - succeeded → failure_code null; scenario 'succeed' or null (pre-phase-16
 *   rows are null — the corpus keeps both shapes so list/retrieve stay honest)
 * - failed → a catalog failure_code with `decline:<code>`
 * - pending/processing → no failure code; scenario null (sweep will settle
 *   them with the default-success edge, exactly as an unread created payment)
 */
export function buildPaymentRow({
  id,
  projectId,
  environment,
  customerId,
  amountMinor,
  currency = 'usd',
  status,
  failureCode = null,
  description = null,
  createdAt,
}) {
  assertEnvironment(environment);
  if (!PAYMENT_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${PAYMENT_STATUSES.join(', ')}`);
  }
  const positiveAmount =
    typeof amountMinor === 'bigint' ? amountMinor > 0n : Number.isInteger(amountMinor) && amountMinor > 0;
  if (!positiveAmount) {
    throw new Error('amountMinor must be a positive integer');
  }
  if (currency !== 'usd') throw new Error('currency must be usd (ADR-0003)');
  if (description !== null && description !== undefined && description.length > 500) {
    throw new Error('description must be at most 500 characters');
  }

  let failure = null;
  let scenario = null;
  if (status === 'failed') {
    const code = failureCode ?? 'card_declined';
    if (!FAILURE_CODES.includes(code)) {
      throw new Error(`failureCode must be one of ${FAILURE_CODES.join(', ')}`);
    }
    failure = code;
    scenario = `decline:${code}`;
  } else if (failureCode !== null) {
    throw new Error('failureCode is only valid on failed payments');
  } else if (status === 'succeeded' && Math.random() < 0.5) {
    scenario = 'succeed';
  }

  return {
    id,
    projectId,
    environment,
    customerId,
    amountMinor,
    currency,
    status,
    failureCode: failure,
    simulationScenario: scenario,
    description: description ?? null,
    createdAt,
  };
}

function tsLiteral(date) {
  return `TIMESTAMPTZ ${sqlString(date.toISOString())}`;
}

/** Renders customer rows as a batched multi-row INSERT. */
export function customerInsertSql(rows) {
  if (rows.length === 0) return '';
  const values = rows
    .map(
      (r) =>
        `(${sqlString(r.id)}, ${sqlString(r.projectId)}, ${sqlString(r.environment)}, ${sqlString(r.email)}, ${
          r.name === null ? 'NULL' : sqlString(r.name)
        }, '{}'::jsonb, ${tsLiteral(r.createdAt)}, ${tsLiteral(r.createdAt)})`,
    )
    .join(',\n    ');
  return `INSERT INTO customers (id, project_id, environment, email, name, metadata, created_at, updated_at)\n    VALUES\n    ${values}\n    ON CONFLICT (id) DO NOTHING;`;
}

/** Renders payment rows as a batched multi-row INSERT. */
export function paymentInsertSql(rows) {
  if (rows.length === 0) return '';
  const values = rows
    .map(
      (r) =>
        `(${sqlString(r.id)}, ${sqlString(r.projectId)}, ${sqlString(r.environment)}, ${sqlString(r.customerId)}, ${r.amountMinor}, ${sqlString(
          r.currency,
        )}, ${sqlString(r.status)}, ${r.failureCode === null ? 'NULL' : sqlString(r.failureCode)}, ${
          r.simulationScenario === null ? 'NULL' : sqlString(r.simulationScenario)
        }, ${r.description === null ? 'NULL' : sqlString(r.description)}, ${tsLiteral(r.createdAt)}, ${tsLiteral(r.createdAt)})`,
    )
    .join(',\n    ');
  return `INSERT INTO payments (id, project_id, environment, customer_id, amount_minor, currency, status, failure_code, simulation_scenario, description, created_at, updated_at)\n    VALUES\n    ${values}\n    ON CONFLICT (id) DO NOTHING;`;
}

/**
 * Builds the full corpus dataset for one project/environment.
 *
 * Everything is terminal except a small tail of fresh `pending` rows (so the
 * advancement sweep has real due work right after seeding without leaving an
 * artificial backlog for the first scenario to inherit).
 */
export function buildCorpus({
  projectId,
  environment,
  customerCount,
  paymentCount,
  customerSampleSize = 50,
  refundableCount = 0,
  now = Date.now(),
  historyDays = 10,
}) {
  if (customerCount < 1) throw new Error('customerCount must be >= 1');
  if (paymentCount < customerCount) {
    // Not a hard contract rule; the corpus simply needs at least one payment
    // per customer for uniform access patterns.
  }

  const customers = [];
  for (let i = 0; i < customerCount; i += 1) {
    const createdAt = new Date(now - Math.floor(((historyDays * 86_400_000) * i) / Math.max(customerCount, 1)));
    customers.push(
      buildCustomerRow({
        id: uuidv7(createdAt.getTime()),
        projectId,
        environment,
        email: `cust-${String(i).padStart(6, '0')}@loadtest.invalid`,
        name: `Loadtest Customer ${i}`,
        createdAt,
      }),
    );
  }

  const payments = [];
  const pendingTail = Math.min(50, paymentCount);
  const refundableIds = [];
  const sampleIds = [];
  for (let i = 0; i < paymentCount; i += 1) {
    const isPendingTail = i >= paymentCount - pendingTail;
    // Pending rows are fresh (due within the sweep horizon shortly after the
    // seed); settled rows spread across the history window.
    const createdAt = isPendingTail
      ? new Date(now - (i % 2) * 500)
      : new Date(now - 5_000 - Math.floor(((historyDays * 86_400_000) * i) / Math.max(paymentCount, 1)));
    const customer = customers[i % customers.length];
    const status = isPendingTail
      ? 'pending'
      : i % 17 === 0
        ? 'failed'
        : 'succeeded';
    const row = buildPaymentRow({
      id: uuidv7(createdAt.getTime()),
      projectId,
      environment,
      customerId: customer.id,
      amountMinor: BigInt(500 + ((i * 137) % 49_500)),
      status,
      description: i % 3 === 0 ? `Loadtest corpus payment ${i}` : null,
      createdAt,
    });
    payments.push(row);
    if (status === 'succeeded' && sampleIds.length < customerSampleSize) {
      sampleIds.push(row.id);
    }
    if (status === 'succeeded' && refundableIds.length < refundableCount) {
      refundableIds.push(row.id);
    }
  }

  return { customers, payments, samplePaymentIds: sampleIds, refundablePaymentIds: refundableIds };
}
