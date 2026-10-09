/**
 * Bounded response-schema conformance (phase 17 D5(a), ADR-0035).
 *
 * `docs/openapi.yaml` is the canonical contract (ADR-0012), but until now
 * nothing compared an actual API response against it: Redocly lint proves the
 * *document* is well-formed, the docs-consistency specs prove the *guides*
 * agree with it — neither catches the implementation drifting away from it.
 *
 * This helper validates a response body against the schema the contract
 * documents for one `(operationId, status)` pair. It is deliberately bounded:
 *
 * - the caller states which operation/status pairs it covers (the maintained
 *   allowlist lives in `test/contract-conformance.e2e-spec.ts`); every other
 *   response of every other operation is not validated (D5 confirmed a bounded
 *   scope, not validation of every response of every operation);
 * - `additionalProperties: false` is stripped before compilation so a
 *   legitimately additive response field never fails the build — the goal is
 *   catching drift, not freezing the schema (phase 17 §17);
 * - OpenAPI keywords that are not JSON Schema (`example`, `description`, …)
 *   are tolerated (`strict: false`); formats are validated (Ajv's standard
 *   format set), including `date-time`, `uuid`, `email`, `uri`.
 *
 * Failures are assertion errors with readable messages: a mismatch here is
 * implementation↔contract drift and must fail loudly (D5(a), AC12).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface ConformanceResult {
  valid: boolean;
  errors: string[];
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}

interface OperationObject {
  operationId?: string;
  responses?: Record<string, ResponseObject>;
}

export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Partial<Record<HttpMethod, OperationObject>>>;
  components?: { schemas?: Record<string, unknown> };
}

/** Named root under which the whole document is registered in Ajv. */
const DOCUMENT_ID = 'brinnpay-openapi';

/** Resolves the canonical contract the same way `setupSwagger` does (ADR-0012). */
export function resolveContractPath(): string {
  const candidates = [
    resolve(process.cwd(), process.env.OPENAPI_PATH ?? '../../docs/openapi.yaml'),
    resolve(process.cwd(), 'docs/openapi.yaml'),
    resolve(__dirname, '../../../../docs/openapi.yaml'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `OpenAPI contract not found. Checked: ${candidates.join(', ')}. ` +
        'Run from the API application directory or set OPENAPI_PATH.',
    );
  }
  return found;
}

/** Parses the canonical contract; one parse per process, reused by every test. */
export function loadContractDocument(): OpenApiDocument {
  const document = parse(readFileSync(resolveContractPath(), 'utf8')) as OpenApiDocument;
  if (typeof document?.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    throw new Error(`Expected an OpenAPI 3.x document, got "openapi: ${String(document?.openapi)}".`);
  }
  if (!document.paths || typeof document.paths !== 'object') {
    throw new Error('The contract has no `paths` object.');
  }
  return document;
}

/**
 * Deep-clones the document without `additionalProperties: false` entries.
 * The raw document is left untouched — other suites assert against it as-is.
 */
function withoutClosedObjects<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((item) => withoutClosedObjects(item)) as unknown as T;
  }
  if (node !== null && typeof node === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'additionalProperties' && value === false) continue;
      clone[key] = withoutClosedObjects(value);
    }
    return clone as unknown as T;
  }
  return node;
}

/** Escapes one path segment into a JSON-Pointer fragment (`/` → `~1`). */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Reverses {@link escapePointer}. */
function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.trim(),
  );
}

/**
 * Validates response bodies against the canonical contract for the operation
 * and status pairs a suite explicitly covers.
 */
export class ContractConformance {
  private readonly ajv: Ajv2020;
  private readonly operations = new Map<string, { path: string; method: HttpMethod }>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly document: OpenApiDocument) {
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation?.operationId) continue;
        this.operations.set(operation.operationId, { path, method: method as HttpMethod });
      }
    }

    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.ajv.addSchema(withoutClosedObjects(document), DOCUMENT_ID);
  }

  /** Operation ids present in the contract (the allowlist's universe). */
  hasOperation(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  /**
   * Validates `body` as the documented JSON response of
   * `(operationId, status)`. Throws when the pair itself is not documented —
   * a silent "nothing to check" would be a false green (rule 5).
   */
  validate(operationId: string, status: number, body: unknown): ConformanceResult {
    const validator = this.validatorFor(operationId, status);
    const valid = validator(body) as boolean;
    return { valid, errors: valid ? [] : formatErrors(validator.errors) };
  }

  /** Asserting wrapper: drift throws with the failing paths spelled out. */
  assert(operationId: string, status: number, body: unknown): void {
    const result = this.validate(operationId, status, body);
    if (result.valid) return;
    throw new Error(
      `Response of ${operationId} (HTTP ${status}) does not match docs/openapi.yaml:\n` +
        result.errors.map((error) => `  - ${error}`).join('\n'),
    );
  }

  private validatorFor(operationId: string, status: number): ValidateFunction {
    const cacheKey = `${operationId}:${status}`;
    const cached = this.validators.get(cacheKey);
    if (cached) return cached;

    const located = this.operations.get(operationId);
    if (!located) {
      throw new Error(
        `"${operationId}" is not an operation of docs/openapi.yaml; the conformance ` +
          'allowlist only accepts operation ids the canonical contract declares.',
      );
    }

    const operation = this.document.paths[located.path][located.method]!;
    const responses = operation.responses ?? {};
    const response = responses[String(status)];
    if (!response) {
      throw new Error(
        `${operationId} documents no ${status} response (documented: ` +
          `${Object.keys(responses).sort().join(', ')}).`,
      );
    }

    const pointer = this.locateSchemaPointer(
      `#/paths/${escapePointer(located.path)}/${located.method}` +
        `/responses/${escapePointer(String(status))}/content/${escapePointer('application/json')}/schema`,
    );
    const validator = this.ajv.compile({ $ref: `${DOCUMENT_ID}${pointer}` });
    this.validators.set(cacheKey, validator);
    return validator;
  }

  /**
   * Resolves a JSON pointer against the document, following `$ref` nodes, and
   * returns the pointer to the final (possibly dereferenced) location.
   */
  private locateSchemaPointer(pointer: string): string {
    let node: unknown = this.document;
    let resolved = '#';
    const segments = pointer.slice(2).split('/'); // strip the leading `#/`

    for (const segment of segments) {
      // Follow reference nodes (with a cycle guard) before descending.
      const seen = new Set<string>();
      while (
        node !== null &&
        typeof node === 'object' &&
        typeof (node as { $ref?: unknown }).$ref === 'string'
      ) {
        const ref = (node as { $ref: string }).$ref;
        if (!ref.startsWith('#/')) {
          throw new Error(`Only internal contract references are supported, got "${ref}".`);
        }
        if (seen.has(ref)) {
          throw new Error(`Circular contract reference while resolving ${pointer}: ${ref}`);
        }
        seen.add(ref);
        node = this.dereference(ref);
        resolved = ref;
      }

      // Pointer segments are escaped (`~1` for `/`); object keys are raw.
      const key = unescapePointer(segment);
      if (node === null || typeof node !== 'object' || !(key in (node as object))) {
        throw new Error(
          `docs/openapi.yaml has no schema at ${resolved}/${key} ` +
            'required by the conformance allowlist.',
        );
      }
      node = (node as Record<string, unknown>)[key];
      resolved = `${resolved}/${segment}`;
    }

    return resolved;
  }

  /** Reads an internal `#/...` pointer out of the raw document. */
  private dereference(pointer: string): unknown {
    let node: unknown = this.document;
    for (const segment of pointer.slice(2).split('/')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[unescapePointer(segment)];
    }
    return node;
  }
}

let shared: ContractConformance | undefined;

/** Process-wide conformance instance (one parse, one Ajv compilation pass). */
export function getConformance(): ContractConformance {
  shared ??= new ContractConformance(loadContractDocument());
  return shared;
}
