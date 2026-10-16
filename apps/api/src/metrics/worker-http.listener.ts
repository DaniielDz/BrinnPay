import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server } from 'node:http';

import { isScrapeAuthorized } from './metrics-endpoint.middleware';
import { MetricsService } from './metrics.service';

/**
 * The worker's own HTTP listener (phase 20 D3(a)/D7(a), §8).
 *
 * The worker is a separate process that never boots Nest's HTTP adapter, so
 * it cannot serve `/health/live` or the exposition through `configureApp`.
 * This is a deliberate bare `node:http` server — no framework, two routes,
 * closed by construction:
 *
 * - `GET {metrics.path}` — the Prometheus exposition, when enabled, with the
 *   same bearer-token gate as the API's endpoint (one token, one meaning);
 * - `GET /health/live` — a liveness body identical to the API's, so the
 *   compose healthcheck and any orchestration can treat both processes the
 *   same way. Served **regardless** of the metrics flag: process liveness is
 *   not an observability preference (D7(a)).
 *
 * Nothing else answers: unknown paths and verbs are 404/405, and the listener
 * never touches the database, Redis or the domain layer.
 */
@Injectable()
export class WorkerHttpListener {
  private server: Server | undefined;
  private boundPort: number | undefined;

  private readonly port: number;
  private readonly path: string;
  private readonly scrapeToken: string | null;
  private readonly expositionEnabled: boolean;

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.port = config.getOrThrow<number>('metrics.workerPort');
    this.path = config.getOrThrow<string>('metrics.path');
    this.scrapeToken = config.getOrThrow<string | null>('metrics.scrapeToken');
    this.expositionEnabled = config.getOrThrow<boolean>('metrics.enabled');
  }

  /** The port actually bound after {@link start} — useful with port 0 in tests. */
  get actualPort(): number | undefined {
    return this.boundPort;
  }

  /**
   * Starts listening. Resolves with the bound port (≠ the configured one when
   * `portOverride` is 0, which lets tests and side-by-side runs pick a free
   * port). Refuses to resolve if the port is taken — the caller decides how
   * to react; `worker.ts` logs without crashing, because a metrics listener
   * losing a port race must not take webhook delivery down with it.
   */
  start(portOverride?: number): Promise<number> {
    if (this.server !== undefined) {
      return Promise.resolve(this.boundPort ?? this.port);
    }
    return new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request.method ?? 'GET', request.url ?? '', request.headers, response);
      });
      server.once('error', reject);
      server.listen(portOverride ?? this.port, '0.0.0.0', () => {
        const address = server.address();
        this.boundPort = address !== null && typeof address === 'object' ? address.port : (portOverride ?? this.port);
        this.server = server;
        resolve(this.boundPort);
      });
    });
  }

  /** Stops listening; safe to call when never started or already stopped. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    this.server = undefined;
    this.boundPort = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(
    method: string,
    rawUrl: string,
    headers: Record<string, string | string[] | undefined>,
    response: {
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (body?: string) => void;
    },
  ): void {
    const path = (rawUrl.split('?', 1)[0] ?? '/') || '/';

    if (path === '/health/live') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        response.statusCode = 405;
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = 200;
      response.end(method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
      return;
    }

    if (path === this.path) {
      if (!this.expositionEnabled) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        response.statusCode = 405;
        response.end();
        return;
      }
      if (!isScrapeAuthorized(headers, this.scrapeToken)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        response.statusCode = 401;
        response.end();
        return;
      }
      void this.metrics
        .render()
        .then((body) => {
          response.statusCode = 200;
          response.setHeader('Content-Type', this.metrics.contentType);
          response.end(method === 'HEAD' ? undefined : body);
        })
        .catch(() => {
          response.statusCode = 500;
          response.end();
        });
      return;
    }

    response.statusCode = 404;
    response.end();
  }
}
