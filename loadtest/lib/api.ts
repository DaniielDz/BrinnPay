/**
 * Thin HTTP client for the k6 scenarios.
 *
 * Centralises the parts every scenario must get right:
 *
 * - bearer auth (session token or API key) through `Authorization`;
 * - `Idempotency-Key` support for write paths (phase 7 §4.4);
 * - `http.expectedStatuses(...)` response callbacks so expected non-2xx
 *   outcomes (404/409/422/429) are *observations*, not `http_req_failed`
 *   noise — failures then mean transport errors or contract breaches only;
 * - a stable `name` tag per call so summaries stay scenario-scoped.
 *
 * The returned shape is a structural subset of k6's `RefinedResponse`,
 * narrowed once here to keep scenario code free of k6 type gymnastics.
 */

import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { BASE_URL, RATE_LIMIT_HEADERS } from './config.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  timings: { duration: number };
  json<T = unknown>(): T;
}

export interface CallOptions {
  /**
   * Operation label. Sent as the custom `op` request tag (usable in
   * thresholds later) and attached to `durationMetric` when one is given.
   *
   * k6 2.x removed the legacy `name` request param — per-operation latency
   * therefore goes through explicit custom `Trend` metrics instead of
   * `http_req_duration{name=…}` sub-metrics (probed against grafana/k6:2.3.0).
   */
  name: string;
  /** Bearer credential: session token or `sk_...` API key. */
  token?: string;
  /** Statuses treated as observations (kept out of `http_req_failed`). */
  expected?: number[];
  headers?: Record<string, string>;
  /** Adds `Idempotency-Key: <value>` (unique per logical write). */
  idempotencyKey?: string;
  /** When set, the response duration is recorded on this trend (ms). */
  durationMetric?: Trend;
}

export interface ApiClient {
  get(path: string, opts: CallOptions): ApiResponse;
  post(path: string, body: unknown | null, opts: CallOptions): ApiResponse;
  patch(path: string, body: unknown | null, opts: CallOptions): ApiResponse;
  del(path: string, opts: CallOptions): ApiResponse;
}

/** Appends a query string, skipping empty/undefined values. */
export function apiUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const base = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return base;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length > 0 ? `${base}?${pairs.join('&')}` : base;
}

function buildHeaders(opts: CallOptions, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  return headers;
}

function invoke(method: HttpMethod, url: string, body: string | null, opts: CallOptions): ApiResponse {
  const headers = buildHeaders(opts, body !== null);
  const params: Record<string, unknown> = { tags: { op: opts.name }, headers };
  if (opts.expected && opts.expected.length > 0) {
    params.responseCallback = http.expectedStatuses(...opts.expected);
  }

  let raw;
  switch (method) {
    case 'GET':
      raw = http.get(url, params);
      break;
    case 'POST':
      raw = http.post(url, body ?? '', params);
      break;
    case 'PATCH':
      raw = http.patch(url, body ?? '', params);
      break;
    case 'PUT':
      raw = http.put(url, body ?? '', params);
      break;
    case 'DELETE':
      raw = http.del(url, undefined, params);
      break;
    default:
      throw new Error(`unsupported method: ${method}`);
  }
  if (opts.durationMetric) {
    opts.durationMetric.add(raw.timings.duration, { op: opts.name });
  }
  return raw as unknown as ApiResponse;
}

function request(method: HttpMethod, path: string, body: unknown | null, opts: CallOptions): ApiResponse {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  return invoke(method, apiUrl(path), payload, opts);
}

export function createClient(): ApiClient {
  return {
    get: (path, opts) => request('GET', path, null, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    del: (path, opts) => request('DELETE', path, null, opts),
  };
}

/** Case-insensitive header lookup (k6 preserves the wire casing). */
export function header(res: ApiResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(res.headers)) {
    if (key.toLowerCase() === lower) return res.headers[key];
  }
  return undefined;
}

/** True when the response carries any of the rate-limit headers (F6). */
export function hasRateLimitHeaders(res: ApiResponse): boolean {
  return RATE_LIMIT_HEADERS.some((name) => header(res, name) !== undefined);
}
