/**
 * Unit coverage for the phase 17 D5(a) conformance helper (AC1: new tooling is
 * itself tested). The helper is pure logic over the canonical contract file, so
 * it belongs to the unit layer — no application, no database.
 */
import { uuidv7 } from '../../src/common/uuid/uuid';
import { ContractConformance, loadContractDocument, resolveContractPath } from './conformance';

/** A contract-conforming `Payment` response body (phase 7 §4.2). */
function paymentBody() {
  return {
    id: uuidv7(),
    project_id: uuidv7(),
    environment: 'test',
    customer_id: uuidv7(),
    amount: '10.00',
    currency: 'usd',
    status: 'pending',
    failure_code: null,
    description: null,
    created_at: '2026-10-09T10:00:00.000Z',
    updated_at: '2026-10-09T10:00:00.000Z',
  };
}

/** A contract-conforming `ErrorEnvelope` (phase 1 §7.6). */
function errorBody(code = 'NOT_FOUND') {
  return { error: { code, message: 'Payment not found.', request_id: 'req_0192f2a0' } };
}

describe('contract conformance helper (phase 17 D5(a))', () => {
  const conformance = new ContractConformance(loadContractDocument());

  it('loads the canonical OpenAPI 3.x contract from docs/openapi.yaml (ADR-0012)', () => {
    expect(resolveContractPath()).toMatch(/docs\/openapi\.yaml$/);
    const document = loadContractDocument();
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it('resolves $ref chains: a Payment body validates against payments.create 201', () => {
    // Payment.$ref → Environment/MoneyAmount are followed through the document.
    const result = conformance.validate('payments.create', 201, paymentBody());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a body that violates the documented schema, naming the paths', () => {
    const bad = { ...paymentBody(), status: 'settled', amount: '-5.00' };
    const result = conformance.validate('payments.create', 201, bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('/status');
    expect(result.errors.join('\n')).toContain('/amount');
  });

  it('rejects a body missing a required field', () => {
    const withoutId: Record<string, unknown> = { ...paymentBody() };
    delete withoutId.id;
    const result = conformance.validate('payments.create', 201, withoutId);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('id');
  });

  it('validates the error envelope through the shared components/responses $ref', () => {
    // 404 is documented as `$ref: #/components/responses/NotFound`, so this
    // exercises the pointer walk across a reference node.
    expect(conformance.validate('payments.retrieve', 404, errorBody()).valid).toBe(true);
    const bad = { error: { message: 'no code here' } };
    const result = conformance.validate('payments.retrieve', 404, bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('/error');
  });

  it('allows additive response fields even where the contract says additionalProperties: false', () => {
    // D5 posture: catch drift, do not freeze the schema (phase 17 §17).
    const additive = { ...paymentBody(), future_field: 'added-by-a-newer-api' };
    expect(conformance.validate('payments.create', 201, additive).valid).toBe(true);
    // The raw document still carries the closed marker — only the compiled
    // copy strips it.
    const raw = JSON.stringify(loadContractDocument().components?.schemas?.WebhookEvent ?? {});
    expect(raw).toContain('additionalProperties');
  });

  it('fails loudly for an operation id the contract does not declare', () => {
    expect(() => conformance.validate('payments.teleport', 201, {})).toThrow(
      /not an operation of docs\/openapi\.yaml/,
    );
  });

  it('fails loudly for a status the operation does not document', () => {
    expect(() => conformance.validate('payments.create', 418, {})).toThrow(
      /documents no 418 response/,
    );
  });

  it('assert() throws with the failing paths when the body drifts', () => {
    expect(() => conformance.assert('payments.create', 201, { id: 1 })).toThrow(
      /does not match docs\/openapi\.yaml/,
    );
    expect(() => conformance.assert('payments.create', 201, paymentBody())).not.toThrow();
  });

  it('knows the operations of the contract (allowlist universe)', () => {
    expect(conformance.hasOperation('payments.create')).toBe(true);
    expect(conformance.hasOperation('payments.teleport')).toBe(false);
  });
});
