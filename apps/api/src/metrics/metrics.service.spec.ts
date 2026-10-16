import { MetricsService } from './metrics.service';

/**
 * The exposition surface (phase 20 D1(a), M1/M4). These tests assert the
 * registry emits the catalog the runbook, dashboards and alert rules depend
 * on — a renamed metric is a silent alert blind spot, so the names are
 * pinned exactly as specified.
 */
describe('MetricsService (phase 20 M1/M4)', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('renders Prometheus text with the default runtime metrics (M1)', async () => {
    const body = await metrics.render();
    expect(metrics.contentType).toContain('text/plain');
    expect(body).toContain('# TYPE process_cpu_seconds_total counter');
    expect(body).toContain('# TYPE nodejs_heap_size_used_bytes gauge');
    expect(body).toContain('brinnpay_http_requests_total');
  });

  it('emits the HTTP catalog after an observation (M1/M4)', async () => {
    metrics.observeHttpRequest({
      route: '/customers/:id',
      method: 'GET',
      statusClass: '2xx',
      durationSeconds: 0.003,
    });
    metrics.incHttpInFlight();
    metrics.decHttpInFlight();

    const body = await metrics.render();
    expect(body).toContain(
      'brinnpay_http_requests_total{route="/customers/:id",method="GET",status_class="2xx"} 1',
    );
    expect(body).toContain(
      'brinnpay_http_request_duration_seconds_count{route="/customers/:id",method="GET",status_class="2xx"} 1',
    );
    expect(body).toContain('brinnpay_http_requests_in_flight 0');
  });

  it('emits the rate-limit and request-log handover metrics (phase 13 §16, phase 11)', async () => {
    metrics.incThrottledRequest('read', 'ip');
    metrics.incRateLimitWindowExhaustion('read', 'account');
    metrics.setRateLimitDegraded(true);
    metrics.incRateLimitDegradedEpisode();
    metrics.setRateLimitDegraded(false);
    metrics.incRequestLogWrite();
    metrics.incRequestLogWriteFailure();
    metrics.incHttpServerError('/payments/:id');
    metrics.incUnhandledException('/payments/:id');

    const body = await metrics.render();
    expect(body).toContain('brinnpay_rate_limit_throttled_requests_total{class="read",scope="ip"} 1');
    expect(body).toContain(
      'brinnpay_rate_limit_window_exhaustion_total{class="read",scope="account"} 1',
    );
    expect(body).toContain('brinnpay_rate_limit_degraded 0');
    expect(body).toContain('brinnpay_rate_limit_degraded_episodes_total 1');
    expect(body).toContain('brinnpay_request_log_writes_total 1');
    expect(body).toContain('brinnpay_request_log_write_failures_total 1');
    expect(body).toContain('brinnpay_http_server_errors_total{route="/payments/:id"} 1');
    expect(body).toContain('brinnpay_http_unhandled_exceptions_total{route="/payments/:id"} 1');
  });

  it('isolates registries between application contexts (worker vs API)', async () => {
    // Two contexts in one process must never double-count into one series.
    const other = new MetricsService();
    metrics.incRequestLogWrite();
    const body = await other.render();
    expect(body).toContain('brinnpay_request_log_writes_total 0');
    expect(await metrics.render()).toContain('brinnpay_request_log_writes_total 1');
  });
});
