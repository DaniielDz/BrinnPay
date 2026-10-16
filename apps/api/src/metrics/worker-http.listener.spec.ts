import { ConfigService } from '@nestjs/config';

import { MetricsService } from './metrics.service';
import { WorkerHttpListener } from './worker-http.listener';

/**
 * The worker's own-port surface (phase 20 D3(a)/D7(a), §8): two routes,
 * closed by construction, same token gate as the API's endpoint, liveness
 * independent of the metrics flag.
 */
describe('WorkerHttpListener (phase 20 D3(a)/D7(a))', () => {
  const token = 'w'.repeat(48);

  function configFor(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      'metrics.workerPort': 0, // ephemeral for tests
      'metrics.path': '/metrics',
      'metrics.scrapeToken': null,
      'metrics.enabled': true,
      ...overrides,
    };
    return { getOrThrow: (key: string) => values[key] } as unknown as ConfigService;
  }

  let listener: WorkerHttpListener;
  let base: string;

  beforeEach(async () => {
    listener = new WorkerHttpListener(configFor(), new MetricsService());
    const port = await listener.start(0);
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await listener.stop();
  });

  it('serves liveness as the same body as the API health controller', async () => {
    const response = await fetch(`${base}/health/live`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('serves the exposition on the configured path when enabled', async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    await expect(response.text()).resolves.toContain('brinnpay_');
  });

  it('ignores a query string when matching routes', async () => {
    const response = await fetch(`${base}/metrics?g=0`);
    expect(response.status).toBe(200);
  });

  it('404s everything else', async () => {
    for (const path of ['/api/v1/customers', '/health/ready', '/']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it('405s a non-scrape verb', async () => {
    const response = await fetch(`${base}/metrics`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('is idempotent on start and safe on double stop', async () => {
    const first = await listener.start(0);
    expect(first).toBe(listener.actualPort);
    await listener.stop();
    await listener.stop();
  });

  it('requires the scrape token when one is configured', async () => {
    const guarded = new WorkerHttpListener(
      configFor({ 'metrics.scrapeToken': token }),
      new MetricsService(),
    );
    const port = await guarded.start(0);
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');

      const authorized = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);

      // Liveness never needs a credential: the compose healthcheck and the
      // scrape credential are independent concerns (D7(a)).
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await guarded.stop();
    }
  });

  it('keeps liveness but 404s the exposition while metrics are disabled', async () => {
    const disabled = new WorkerHttpListener(
      configFor({ 'metrics.enabled': false }),
      new MetricsService(),
    );
    const port = await disabled.start(0);
    try {
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
      const exposition = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(exposition.status).toBe(404);
    } finally {
      await disabled.stop();
    }
  });
});
