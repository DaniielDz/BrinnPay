import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * Canonical contract loader (phase 15 §6, ADR-0030).
 *
 * The embedded API reference is *generated* from `docs/openapi.yaml` — the
 * single source of truth (ADR-0012) — and never hand-written, so no second
 * contract can drift from the API. The file is read once at build/dev time
 * from the repository checkout (the Docker web image copies it and the dev
 * compose mounts it); the reference never fetches it at runtime, which keeps
 * the docs area free of an API/Redis/PostgreSQL dependency (§9.3, §10).
 *
 * Everything below is a *view model*: the raw document is normalized into the
 * shapes the reference component renders. Refs are resolved here so the
 * component never reaches into `any` data.
 */

type Json = Record<string, any>;

const CONTRACT_RELATIVE_PATH = join('docs', 'openapi.yaml');

/** Find `docs/openapi.yaml` by walking up from the working directory. */
function resolveContractPath(): string {
  let current = process.cwd();

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, CONTRACT_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `BrinnPay: ${CONTRACT_RELATIVE_PATH} was not found from ${process.cwd()}. ` +
      'The API reference is generated from the canonical contract file, so the ' +
      'checkout (or container mount) must provide it.',
  );
}

/** Human label for a security scheme, taken from the contract's own fields. */
function securitySchemeLabel(scheme: Json): string {
  if (scheme.type === 'http') {
    const format = scheme.bearerFormat ? ` (${scheme.bearerFormat})` : '';
    return `http ${scheme.scheme}${format}`;
  }
  if (scheme.type === 'apiKey') return `apiKey in ${scheme.in}`;
  return String(scheme.type ?? 'http');
}

export interface ContractParameter {
  name: string;
  where: 'path' | 'query' | 'header';
  required: boolean;
  type: string;
  description: string;
}

export interface ContractResponse {
  status: string;
  description: string;
  headers: readonly string[];
  schemaName?: string;
}

export interface ContractRequestBody {
  required: boolean;
  schemaName: string | null;
  requiredFields: readonly string[];
}

export interface ContractOperation {
  /** `operationId`, also the anchor target. */
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** Security requirements; an empty list means the operation is public. */
  security: readonly string[];
  parameters: readonly ContractParameter[];
  requestBody?: ContractRequestBody;
  responses: readonly ContractResponse[];
}

export interface ContractTag {
  name: string;
  description: string;
  operations: readonly ContractOperation[];
}

export interface ContractSchemaProperty {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enumValues?: readonly string[];
}

export interface ContractSchema {
  name: string;
  description: string;
  type: string;
  enumValues?: readonly string[];
  required: readonly string[];
  properties: readonly ContractSchemaProperty[];
  /** True when `additionalProperties: false` closes the object. */
  closed: boolean;
}

export interface ContractSecurityScheme {
  name: string;
  label: string;
  description: string;
}

export interface ContractView {
  title: string;
  version: string;
  /** The contract's `servers[].url` values, relative as authored. */
  servers: readonly string[];
  securitySchemes: readonly ContractSecurityScheme[];
  tags: readonly ContractTag[];
  operations: readonly ContractOperation[];
  schemas: readonly ContractSchema[];
}

interface ParsedContract {
  document: Json;
}

function parseDocument(): ParsedContract {
  const source = readFileSync(resolveContractPath(), 'utf8');
  return { document: parseYaml(source) as Json };
}

function refName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

function deref(document: Json, node: Json | undefined): Json | undefined {
  if (!node) return undefined;
  if (typeof node.$ref === 'string') {
    const target = node.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<Json | undefined>((acc, key) => (acc ? (acc[key] as Json) : undefined), document);
    return target;
  }
  return node;
}

/** Type of a schema node, rendered as the contract writes it. */
function schemaType(document: Json, schema: Json | undefined): string {
  if (!schema) return '';
  const resolved = deref(document, schema);
  if (!resolved) return '';

  if (typeof resolved.type === 'string') {
    return resolved.format ? `${resolved.type} <${resolved.format}>` : resolved.type;
  }
  if (Array.isArray(resolved.type)) return resolved.type.join(' | ');
  if (resolved.enum) return 'enum';
  if (resolved.properties) return 'object';
  if (resolved.items) return 'array';
  if (resolved.oneOf) return 'oneOf';
  if (resolved.allOf) return 'allOf';
  return '';
}

function schemaEnum(document: Json, schema: Json | undefined): string[] | undefined {
  if (!schema) return undefined;
  const resolved = deref(document, schema);
  if (!resolved?.enum) return undefined;
  return (resolved.enum as unknown[]).map(String);
}

function descriptionOf(node: Json | undefined): string {
  if (!node) return '';
  if (typeof node.description === 'string') return node.description;
  return '';
}

function buildParameter(document: Json, raw: Json): ContractParameter {
  const parameter = deref(document, raw) ?? {};
  return {
    name: String(parameter.name ?? ''),
    where: (parameter.in as ContractParameter['where']) ?? 'query',
    required: Boolean(parameter.required),
    type: schemaType(document, parameter.schema as Json | undefined),
    description: descriptionOf(parameter),
  };
}

function buildResponse(document: Json, status: string, raw: Json): ContractResponse {
  const response = deref(document, raw) ?? {};
  const headers = Object.keys((response.headers as Json | undefined) ?? {});
  const content = (response.content as Json | undefined) ?? {};
  const json = content['application/json'] as Json | undefined;
  const schema = json?.schema as Json | undefined;
  const resolvedSchema = deref(document, schema);

  const built: ContractResponse = {
    status,
    description: descriptionOf(response),
    headers,
  };
  if (typeof schema?.$ref === 'string') built.schemaName = refName(schema.$ref);
  else if (resolvedSchema?.title) built.schemaName = String(resolvedSchema.title);
  return built;
}

function buildRequestBody(document: Json, raw: Json | undefined): ContractRequestBody | undefined {
  if (!raw) return undefined;
  const body = deref(document, raw);
  if (!body) return undefined;

  const content = (body.content as Json | undefined) ?? {};
  const json = content['application/json'] as Json | undefined;
  const schemaRef = json?.schema as Json | undefined;
  const schema = deref(document, schemaRef);

  return {
    required: Boolean(body.required),
    schemaName: typeof schemaRef?.$ref === 'string' ? refName(schemaRef.$ref) : null,
    requiredFields: ((schema?.required as string[] | undefined) ?? []).slice(),
  };
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function buildOperations(document: Json): ContractOperation[] {
  const paths = (document.paths as Json) ?? {};
  const operations: ContractOperation[] = [];

  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = (pathItemRaw as Json) ?? {};

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Json | undefined;
      if (!operation) continue;

      const security = ((operation.security as Json[] | undefined) ?? []).flatMap((requirement) =>
        Object.keys(requirement ?? {}),
      );

      const parameters = ((operation.parameters as Json[] | undefined) ?? []).map((parameter) =>
        buildParameter(document, parameter),
      );

      const responses: ContractResponse[] = [];
      for (const [status, response] of Object.entries((operation.responses as Json) ?? {})) {
        responses.push(buildResponse(document, status, (response as Json) ?? {}));
      }
      responses.sort((a, b) => Number(a.status) - Number(b.status));

      operations.push({
        id: String(operation.operationId),
        method: method.toUpperCase(),
        path,
        tag: String((operation.tags as string[] | undefined)?.[0] ?? 'other'),
        summary: String(operation.summary ?? ''),
        description: descriptionOf(operation),
        security,
        parameters,
        requestBody: buildRequestBody(document, operation.requestBody as Json | undefined),
        responses,
      });
    }
  }

  return operations;
}

function buildSchemas(document: Json): ContractSchema[] {
  const schemas = ((document.components as Json)?.schemas as Json) ?? {};

  return Object.entries(schemas).map(([name, raw]) => {
    const schema = (raw as Json) ?? {};
    const properties = (schema.properties as Json | undefined) ?? {};
    const required = new Set<string>(((schema.required as string[] | undefined) ?? []).slice());

    return {
      name,
      description: descriptionOf(schema),
      type: schemaType(document, schema),
      enumValues: schemaEnum(document, schema),
      required: Array.from(required),
      properties: Object.entries(properties).map(([propertyName, propertyRaw]) => {
        const property = (propertyRaw as Json) ?? {};
        const built: ContractSchemaProperty = {
          name: propertyName,
          type: schemaType(document, property),
          required: required.has(propertyName),
          description: descriptionOf(property),
        };
        const enumValues = schemaEnum(document, property);
        if (enumValues) built.enumValues = enumValues;
        return built;
      }),
      closed: schema.additionalProperties === false,
    };
  });
}

function buildView(document: Json): ContractView {
  const info = (document.info as Json) ?? {};
  const servers = ((document.servers as Json[]) ?? []).map((server) => String(server.url ?? ''));
  const securitySchemes = (((document.components as Json)?.securitySchemes as Json) ?? {});

  const operations = buildOperations(document);
  const declaredTags = ((document.tags as Json[]) ?? []).map((tag) => ({
    name: String(tag.name),
    description: descriptionOf(tag),
  }));

  const tags: ContractTag[] = declaredTags.map((tag) => ({
    name: tag.name,
    description: tag.description,
    operations: operations.filter((operation) => operation.tag === tag.name),
  }));

  const knownTags = new Set(tags.map((tag) => tag.name));
  const untagged = operations.filter((operation) => !knownTags.has(operation.tag));
  if (untagged.length > 0) {
    tags.push({ name: 'other', description: '', operations: untagged });
  }

  return {
    title: String(info.title ?? 'BrinnPay API'),
    version: String(info.version ?? ''),
    servers,
    securitySchemes: Object.entries(securitySchemes).map(([name, scheme]) => ({
      name,
      label: securitySchemeLabel(scheme as Json),
      description: descriptionOf(scheme as Json),
    })),
    tags,
    operations,
    schemas: buildSchemas(document),
  };
}

let cached: ContractView | null = null;

/**
 * Loads and normalizes the canonical contract. Read once per process; the
 * page that consumes it is static, so there is nothing to revalidate.
 */
export function loadContract(): ContractView {
  if (!cached) cached = buildView(parseDocument().document);
  return cached;
}

/**
 * Base URL presented by the reference (§6). The contract declares the
 * *relative* server `/api/v1`, so the reference either shows the configured
 * API origin (when `NEXT_PUBLIC_API_BASE_URL` is set) or an explicit
 * placeholder with a prefixing instruction — never a wrong absolute host.
 */
export function resolveApiBaseUrl(): { value: string; configured: boolean } {
  const raw = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').trim();
  if (!raw) return { value: '<your-api-origin>/api/v1', configured: false };

  const normalized = raw.replace(/\/+$/, '');
  return {
    value: normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`,
    configured: true,
  };
}

/**
 * The API's Swagger UI (Phase 2 D5) is linked as the secondary reference
 * path (§6). It lives on the API origin, so the same configured-origin rule
 * applies: a real link when the origin is configured, an instruction
 * otherwise — never a wrong absolute host.
 */
export function resolveSwaggerUrl(): { value: string; configured: boolean } {
  const { value, configured } = resolveApiBaseUrl();
  if (!configured) return { value: '<your-api-origin>/docs', configured: false };
  return { value: `${value.replace(/\/api\/v1$/, '')}/docs`, configured: true };
}

/** Re-exported for tests that need to locate the canonical file. */
export function contractPath(): string {
  return resolve(resolveContractPath());
}
