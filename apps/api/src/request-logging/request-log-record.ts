import { isEnvironment, type Environment } from '../projects/environment';

/**
 * Request-log record assembly (phase 11 §4.2, D6/D7).
 *
 * Pure, dependency-free and side-effect free: the capture path builds one
 * explicit field allowlist projection of a finished request. It never reads a
 * header, a body, or the contents of a query string — the only query parameter
 * that participates is a *validated* `environment` (D1), and only its value is
 * kept. Nothing else can widen what is stored: the table has no column for it.
 *
 * Excluded surfaces (D7 §5.3) return `null`, so "record this request?" is a
 * single decision made here rather than a condition scattered through the
 * middleware.
 */

/**
 * The global API prefix (`bootstrap.ts` → `setGlobalPrefix`). The capture rule
 * is "requests under `/api/v1`" (D7), so this constant is the single source of
 * truth for both the router and the recorder.
 */
export const API_GLOBAL_PREFIX = 'api/v1';

/** The contract's `method` enum, verbatim (`docs/openapi.yaml` → `RequestLog`). */
export const REQUEST_LOG_METHODS = [
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
  'OPTIONS',
  'HEAD',
] as const;

export type RequestLogMethod = (typeof REQUEST_LOG_METHODS)[number];

/** Aligned with the contract's URL bound (`webhook_endpoints.url` is 2048). */
export const MAX_REQUEST_LOG_PATH_LENGTH = 2048;

/**
 * The tenant/actor scope of one record. Every column is optional: a public or
 * unauthenticated request legitimately has no scope at all (§4.2 rule 5).
 */
export interface RequestLogScope {
  project_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  environment: Environment | null;
}

/**
 * The persisted record — exactly the contract's `RequestLog` projection and
 * nothing more (§4.2 rule 4; the D1 `environment` included). Field names are
 * the API's `snake_case`; the Prisma mapping lives in
 * `request-log-store.service.ts`, so the allowlist is enforced at both ends.
 */
export interface RequestLogRecord extends RequestLogScope {
  id: string;
  request_id: string;
  method: RequestLogMethod;
  path: string;
  status_code: number;
  duration_ms: number;
  created_at: Date;
}

/**
 * The slice of the request a record may read. Declared loosely (everything is
 * `unknown`) so assembly performs explicit, checked reads on whatever the
 * caller passes: a payload-shaped object can never leak into a column by
 * accident, and no field outside the allowlist is ever looked at.
 */
export interface RequestLogRequestContext {
  authUser?: unknown;
  project?: unknown;
  organizationMembership?: unknown;
  apiKey?: unknown;
  query?: unknown;
}

export interface RequestLogCaptureInput {
  /** Server-assigned ingress id (phase 1 §7.7); never a client-supplied one. */
  requestId: string;
  /** HTTP method as received. */
  method: string;
  /** The full request target as received (path and, possibly, query string). */
  rawUrl: string;
  /**
   * Whether this is a CORS preflight, decided by the middleware from the
   * request headers (D7). Headers are read only to make this decision — no
   * header value is ever part of a record.
   */
  preflight: boolean;
  /** Response status once the response has completed. */
  statusCode: number;
  /** Monotonic ingress → response-completion duration, in whole milliseconds. */
  durationMs: number;
  /** Wall clock at response completion; doubles as the row's `created_at`. */
  now: Date;
  /** UUIDv7 row id supplied by the caller (ADR-0001). */
  id: string;
  /** The request whose guards resolved the scope. */
  request: RequestLogRequestContext;
}

/** Reads one string column from a context object; anything else is "unknown". */
function readString(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * The pathname of a raw request target, without its query string (D6).
 * `originalUrl` is used because Express may rewrite `url` while dispatching
 * into a mounted router; `originalUrl` is always the target the client sent.
 */
export function requestPathOf(rawUrl: string): string {
  const withoutQuery = rawUrl.split('?', 1)[0] ?? '';
  return withoutQuery.length > 0 ? withoutQuery : '/';
}

/** D7: is this path part of the API surface the contract documents? */
export function isUnderApiPrefix(path: string): boolean {
  const prefix = `/${API_GLOBAL_PREFIX}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * D7: a CORS preflight is browser machinery, not an API call. It is only
 * recognised as a preflight when it is an `OPTIONS` request carrying
 * `Access-Control-Request-Method` — a real `OPTIONS` on an API route is a
 * member of the contract's method enum and is recorded like any other request.
 */
export function isCorsPreflight(
  method: string,
  headers: Record<string, unknown> | undefined,
): boolean {
  if (method.toUpperCase() !== 'OPTIONS') return false;
  return headers !== undefined && 'access-control-request-method' in headers;
}

/** Path with any query string removed and bounded to the stored column size. */
export function sanitizePath(rawUrl: string): string {
  const path = requestPathOf(rawUrl);
  return path.length > MAX_REQUEST_LOG_PATH_LENGTH
    ? path.slice(0, MAX_REQUEST_LOG_PATH_LENGTH)
    : path;
}

export function isRequestLogMethod(method: string): method is RequestLogMethod {
  return (REQUEST_LOG_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Session-mode environment (D1). A session request carries an environment either
 * as a validated query parameter or — for creates and updates — inside a body,
 * which this phase must never read (§14). Only the query parameter participates,
 * and only after `isEnvironment` has accepted it against the same closed catalog
 * the DTOs validate against, so an unvalidated value never reaches a record.
 */
function sessionQueryEnvironment(query: unknown): Environment | null {
  if (typeof query !== 'object' || query === null) return null;
  const raw = (query as Record<string, unknown>).environment;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return isEnvironment(raw) ? raw : null;
}

/**
 * Resolves the scope columns from the context the guards already attached
 * (§4.2 rule 5, §14 — no re-querying). Each column stays `null` when it was not
 * resolved before the response was produced:
 *
 * - **API-key mode** → the key's project, organization and environment (that
 *   guard attaches no `project` in API-key mode, so the key is the authority);
 * - **session, project route** → resolved project/membership plus the caller;
 * - **session, organization route** → membership plus the caller, project null;
 * - **session, auth route** (`/auth/*`) → the caller only;
 * - **401 / nothing resolved** → every column null.
 */
export function resolveRequestLogScope(request: RequestLogRequestContext): RequestLogScope {
  const keyEnvironment = readString(request.apiKey, 'environment');
  const projectId =
    readString(request.project, 'project_id') ?? readString(request.apiKey, 'project_id');

  return {
    project_id: projectId,
    organization_id:
      readString(request.project, 'organization_id') ??
      readString(request.organizationMembership, 'organization_id') ??
      readString(request.apiKey, 'organization_id'),
    user_id: readString(request.authUser, 'id'),
    api_key_id: readString(request.apiKey, 'key_id'),
    environment:
      keyEnvironment !== null
        ? isEnvironment(keyEnvironment)
          ? keyEnvironment
          : null
        : // Session environment belongs to the project-scoped surface only: the
          // rule-5 table gives organization, auth and rejected requests a null
          // environment, and those routes do not declare the parameter (an
          // undeclared `?environment=` is rejected by the validation pipe long
          // before a record exists).
          projectId !== null
          ? sessionQueryEnvironment(request.query)
          : null,
  };
}

/**
 * Builds the record for one finished request, or returns `null` when the
 * request must not be persisted (D7).
 *
 * Returning a record is an allowlist decision, never a redaction step: the
 * object literal below *is* the stored shape, so no rejected field can survive
 * into the row by construction.
 */
export function buildRequestLogRecord(input: RequestLogCaptureInput): RequestLogRecord | null {
  const path = requestPathOf(input.rawUrl);
  if (!isUnderApiPrefix(path) || input.preflight) return null;
  if (!isRequestLogMethod(input.method)) {
    // The contract's method enum is closed; a method outside it (TRACE, …) has
    // no representable record, so it is not persisted rather than coerced.
    return null;
  }

  const scope = resolveRequestLogScope(input.request);

  return {
    id: input.id,
    request_id: input.requestId,
    project_id: scope.project_id,
    organization_id: scope.organization_id,
    user_id: scope.user_id,
    api_key_id: scope.api_key_id,
    environment: scope.environment,
    method: input.method.toUpperCase() as RequestLogMethod,
    path: sanitizePath(input.rawUrl),
    status_code: input.statusCode,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    created_at: input.now,
  };
}
