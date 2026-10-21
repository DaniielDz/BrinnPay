import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

import { REQUEST_LOG_METHODS } from '../request-logging/request-log-record';
import type { RateLimitClass, RateLimitScope } from '../rate-limiting/rate-limit-classes';

/**
 * In-process metrics registry and instrumentation surface (phase 20, M1/M4).
 *
 * One registry per application context (API process or worker process),
 * registered **once at boot** — never per request (§16). Every counter, gauge
 * and histogram of the bounded v1 catalog (D8) lives here or, for the
 * worker-only M5 signals, is registered against {@link registry} by
 * `WorkerMetricsService`, which the API process never loads.
 *
 * Label policy (D5(a), §4 rule 4): labels are constructed exclusively from
 * closed sets — route templates (finite, server-defined), the contract's
 * method enum, status classes, rate-limit classes/scopes, delivery outcomes
 * and sweep pass names. No path value, header, body, identity or free text
 * ever becomes a label value; this service never sees a request at all, only
 * the already-sanitized strings its callers pass in.
 *
 * Exposition is the Prometheus text format (D1(a)) via the official
 * `@prometheus-io/client` — the maintained successor of `prom-client`, same
 * repository (`prometheus/client_js`). Default runtime metrics (memory, event
 * loop, process CPU/uptime) are collected into the same registry, as M1
 * requires.
 */

/** Closed status-class label set (§4 rule 4): five classes plus a fallback. */
export const HTTP_STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'] as const;
export type HttpStatusClass = (typeof HTTP_STATUS_CLASSES)[number];

/** Closed method label set: the contract enum plus a fallback for the rest. */
export const HTTP_METHOD_LABELS = [...REQUEST_LOG_METHODS, 'other'] as const;

/** Closed delivery-outcome label set (M5: attempted/succeeded/failed/retry). */
export const DELIVERY_OUTCOMES = ['delivered', 'failed', 'retry', 'skipped'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Closed sweep-pass label set (M5): the four worker passes, nothing else. */
export const SWEEP_PASSES = ['reconciliation', 'requeue', 'advancement', 'retention'] as const;
export type SweepPass = (typeof SWEEP_PASSES)[number];

/** Closed queue-state label set (M5): BullMQ's four watched states. */
export const QUEUE_STATES = ['wait', 'delayed', 'active', 'failed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/**
 * Latency buckets in seconds (phase 20 §6 M1). Prometheus's standard ladder:
 * sub-millisecond to ten seconds, which covers the Phase 19 baseline's
 * med/p95 band (single-digit ms) and its worst pathological case (>50 s) as
 * an overflow bucket. Buckets describe the distribution; they are not targets
 * or SLOs (F10, §4 rule 8).
 */
export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface HttpRequestObservation {
  /** Route template (`/customers/:id`) or `unmatched` — never a raw URL. */
  route: string;
  method: string;
  statusClass: HttpStatusClass | string;
  durationSeconds: number;
}

@Injectable()
export class MetricsService {
  readonly registry: Registry;

  private readonly httpRequests: Counter<'route' | 'method' | 'status_class'>;
  private readonly httpDuration: Histogram<'route' | 'method' | 'status_class'>;
  private readonly httpInFlight: Gauge<string>;
  private readonly httpServerErrors: Counter<'route'>;
  private readonly unhandledExceptions: Counter<'route'>;
  private readonly throttledRequests: Counter<'class' | 'scope'>;
  private readonly windowExhaustions: Counter<'class' | 'scope'>;
  private readonly rateLimitDegraded: Gauge<string>;
  private readonly degradedEpisodes: Counter<string>;
  private readonly requestLogWrites: Counter<string>;
  private readonly requestLogWriteFailures: Counter<string>;

  constructor() {
    // A private registry — never the library's global default — so two
    // application contexts in one test process can never double-count into a
    // shared series, and shutting one down cannot disturb the other.
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];

    this.httpRequests = new Counter({
      name: 'brinnpay_http_requests_total',
      help: 'API requests under /api/v1 by route template, method and status class.',
      labelNames: ['route', 'method', 'status_class'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'brinnpay_http_request_duration_seconds',
      help: 'API request duration in seconds by route template, method and status class.',
      labelNames: ['route', 'method', 'status_class'],
      buckets: HTTP_DURATION_BUCKETS,
      registers,
    });
    this.httpInFlight = new Gauge({
      name: 'brinnpay_http_requests_in_flight',
      help: 'API requests currently being processed.',
      registers,
    });
    this.httpServerErrors = new Counter({
      name: 'brinnpay_http_server_errors_total',
      help: 'API responses with a 5xx status by route template.',
      labelNames: ['route'],
      registers,
    });
    this.unhandledExceptions = new Counter({
      name: 'brinnpay_http_unhandled_exceptions_total',
      help: 'Unhandled (non-HTTP) exceptions rendered as 500 by route template.',
      labelNames: ['route'],
      registers,
    });
    this.throttledRequests = new Counter({
      name: 'brinnpay_rate_limit_throttled_requests_total',
      help: 'Requests rejected with 429, by rate-limit class and bucket scope (phase 13 §16).',
      labelNames: ['class', 'scope'],
      registers,
    });
    this.windowExhaustions = new Counter({
      name: 'brinnpay_rate_limit_window_exhaustion_total',
      help: 'Window-exhaustion events: the request that consumed the last unit of a bucket, by class and scope.',
      labelNames: ['class', 'scope'],
      registers,
    });
    this.rateLimitDegraded = new Gauge({
      name: 'brinnpay_rate_limit_degraded',
      help: 'Rate limiting is currently degraded (1) or healthy (0): Redis unreachable, bounded fallback active.',
      registers,
    });
    this.degradedEpisodes = new Counter({
      name: 'brinnpay_rate_limit_degraded_episodes_total',
      help: 'Transitions of the rate limiter into its degraded posture.',
      registers,
    });
    this.requestLogWrites = new Counter({
      name: 'brinnpay_request_log_writes_total',
      help: 'Request-log write attempts (log-ingestion rate proxy; phase 11, ADR-0039 PR-3/PR-5).',
      registers,
    });
    this.requestLogWriteFailures = new Counter({
      name: 'brinnpay_request_log_write_failures_total',
      help: 'Request-log writes that failed and were dropped (best-effort by design).',
      registers,
    });
  }

  /** The Prometheus content type of this registry's exposition format. */
  get contentType(): string {
    return this.registry.contentType;
  }

  /** Renders the full exposition (default metrics + catalog). */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  // --- HTTP API (M1/M4) -----------------------------------------------------

  observeHttpRequest(observation: HttpRequestObservation): void {
    const labels = {
      route: observation.route,
      method: observation.method,
      status_class: observation.statusClass,
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, Math.max(0, observation.durationSeconds));
  }

  incHttpInFlight(): void {
    this.httpInFlight.inc();
  }

  decHttpInFlight(): void {
    this.httpInFlight.dec();
  }

  incHttpServerError(route: string): void {
    this.httpServerErrors.inc({ route });
  }

  incUnhandledException(route: string): void {
    this.unhandledExceptions.inc({ route });
  }

  // --- Rate limiting (phase 13 §16 handover) --------------------------------

  incThrottledRequest(routeClass: RateLimitClass, scope: RateLimitScope): void {
    this.throttledRequests.inc({ class: routeClass, scope });
  }

  incRateLimitWindowExhaustion(routeClass: RateLimitClass, scope: RateLimitScope): void {
    this.windowExhaustions.inc({ class: routeClass, scope });
  }

  /** Idempotent state switch; the caller decides what a transition is. */
  setRateLimitDegraded(degraded: boolean): void {
    this.rateLimitDegraded.set(degraded ? 1 : 0);
  }

  incRateLimitDegradedEpisode(): void {
    this.degradedEpisodes.inc();
  }

  // --- Request logs (phase 11 handover, ADR-0039 PR-3/PR-5) -----------------

  incRequestLogWrite(): void {
    this.requestLogWrites.inc();
  }

  incRequestLogWriteFailure(): void {
    this.requestLogWriteFailures.inc();
  }
}
