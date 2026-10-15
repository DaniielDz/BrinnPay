import {
  API_GLOBAL_PREFIX,
  REQUEST_LOG_METHODS,
  isUnderApiPrefix,
} from '../request-logging/request-log-record';

/**
 * Pure label-shaping helpers for the HTTP metrics of phase 20 (D5(a), §4
 * rule 4). Kept free of Nest/Express lifecycle so every transformation is a
 * unit-testable function of its input, and so the "closed label sets" rule is
 * enforceable in one place.
 */

/** Label value for requests that never matched a route in our table. */
export const UNMATCHED_ROUTE = 'unmatched';

/** The API prefix as a path (`/api/v1`), for template de-prefixing. */
const API_PREFIX_PATH = `/${API_GLOBAL_PREFIX}`;

/** Minimal structural view of a request — what label extraction needs only. */
export interface RouteTemplateSource {
  route?: unknown;
  baseUrl?: unknown;
}

/**
 * The route *template* of a matched request (`/customers/:id`), never the
 * concrete URL. Express stores the mounted template on `req.route.path` and
 * the mount prefix on `req.baseUrl`; together they identify the operation
 * regardless of whether the router was mounted at `/api/v1` or bare (both
 * arrangements exist in this codebase: the app mounts globally, tests mount
 * controllers directly).
 *
 * Unmatched requests collapse into a single `unmatched` series — a raw path
 * here would leak user-controlled strings into the label space and multiply
 * cardinality (D5(a)).
 */
export function routeTemplateOf(request: RouteTemplateSource): string {
  const route = request.route;
  const path = route !== null && typeof route === 'object'
    ? (route as { path?: unknown }).path
    : undefined;
  if (typeof path !== 'string' || path.length === 0) {
    return UNMATCHED_ROUTE;
  }

  // Path-to-regexp metacharacters our own routes never use (`:param` and
  // literal segments only). Express 5's global-prefix catch-all — registered
  // as `/api/v1{/*splat}` — matches every request no route claimed, so without
  // this gate its generated pattern would become a label value for arbitrary
  // scan traffic. It is a fallback, not a template: bucket it as `unmatched`
  // (D5(a), §16: 404s collapse into one low-cardinality group).
  if (/[{}()*?+[\]|!<>]/.test(path)) {
    return UNMATCHED_ROUTE;
  }

  const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  const template = `${baseUrl}${path}`;

  if (template === API_PREFIX_PATH) {
    return '/';
  }
  if (template.startsWith(`${API_PREFIX_PATH}/`)) {
    return template.slice(API_PREFIX_PATH.length);
  }
  return template.startsWith('/') ? template : `/${template}`;
}

/**
 * Normalizes an HTTP method to the label set: the contract's method enum
 * uppercased, anything else folded into `other` (a client inventing `PURGE`
 * must not invent a series — closed labels, D5(a)).
 */
export function normalizeMethodLabel(method: string | undefined): string {
  const value = (method ?? '').toUpperCase();
  return (REQUEST_LOG_METHODS as readonly string[]).includes(value) ? value : 'other';
}

/**
 * Status code to class (`200` → `2xx`), with a defensive `other` for codes
 * outside 1xx–5xx so a broken response object can never emit an open label.
 */
export function statusClassOf(statusCode: number | undefined): string {
  if (typeof statusCode !== 'number' || !Number.isFinite(statusCode)) {
    return 'other';
  }
  const classDigit = Math.floor(statusCode / 100);
  return classDigit >= 1 && classDigit <= 5 ? `${classDigit}xx` : 'other';
}

/**
 * The scope gate shared by every HTTP metric: only requests inside the
 * versioned contract (`/api/v1/...`) are measured. This mirrors, by the same
 * predicate, the rate-limit guard's and the request-log middleware's own
 * exclusions (§5 rule 3): outside `/api/v1` there are health probes, Swagger,
 * and — after phase 20 — the metrics exposition itself, none of which belong
 * in an API latency series.
 */
export function isMetricsScopePath(path: string): boolean {
  return isUnderApiPrefix(path);
}
