/**
 * Local webhook receiver for phase 19 load runs (D1).
 *
 * Runs as a throwaway `node:22-alpine` container on the load-test compose
 * network (started by `scripts/run.mjs`), registered as the webhook
 * destination for every endpoint the seeder creates:
 *
 * - `POST /webhooks/**` → `500` when the path contains `/fail/` (the
 *   failing-destination driver behind S5's pending-delivery pileup and the
 *   cross-project retry fairness probe), `200` otherwise;
 * - `GET /stats` → JSON counters (`total`, `ok`, `failed`, per-path
 *   counts) consumed by the runner's sampler — the worker-plane evidence
 *   for the baseline/findings artifacts;
 * - `GET /health` → `200` for readiness checks.
 *
 * Deliberate properties (§8 rule 3 — the receiver is evidence collection,
 * not a control):
 *
 * - request bodies are drained and **never logged, never echoed**: webhook
 *   payloads contain tenant data, and the signing secret never appears here;
 * - no authentication of its own: it exists only to answer with a status
 *   code, and it binds within the compose network (published on localhost
 *   for the sampler only).
 *
 * In-memory counters reset with the container — the runner starts a fresh
 * receiver per run, so `/stats` always describes the current run alone.
 *
 * The counting logic is exported (and the server only starts under a
 * main-module guard) so `test/receiver.test.mjs` can pin it: a per-path
 * counter bug once made every second delivery to a path crash the process.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.RECEIVER_PORT ?? 4090);

/** Fresh counters for the whole run. */
export function createStats() {
  return {
    total: 0,
    ok: 0,
    failed: 0,
    paths: {},
  };
}

/** Path → per-path counters (bounded: endpoints are seeded, not user input).
 *  Returns the counter *object* (not the path) so callers can mutate it —
 *  returning the path string broke on the second request to a path. */
export function pathKey(stats, pathname) {
  if (!(pathname in stats.paths)) {
    stats.paths[pathname] = { total: 0, ok: 0, failed: 0 };
  }
  return stats.paths[pathname];
}

/** Count a delivered webhook and answer the status code the worker sees. */
export function recordWebhook(stats, pathname) {
  const failing = pathname.includes('/fail/');
  const status = failing ? 500 : 200;

  stats.total += 1;
  const perPath = pathKey(stats, pathname);
  perPath.total += 1;
  if (failing) {
    stats.failed += 1;
    perPath.failed += 1;
  } else {
    stats.ok += 1;
    perPath.ok += 1;
  }
  return { status, failing };
}

/** JSON-serializable snapshot for `/stats` (copies path counters so a
 *  consumer of the snapshot can never mutate live state). */
export function statsSnapshot(stats) {
  const paths = {};
  for (const [pathname, counter] of Object.entries(stats.paths)) {
    paths[pathname] = { ...counter };
  }
  return { ...stats, paths };
}

function drain(req) {
  // Discard the payload without retaining or logging it (§8: no PII in logs).
  req.on('data', () => {});
  req.on('end', () => {});
  req.resume();
}

export function createReceiverServer(stats = createStats(), port = PORT) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/health')) {
      const body =
        pathname === '/health'
          ? JSON.stringify({ status: 'ok' })
          : JSON.stringify(statsSnapshot(stats));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method !== 'POST' || !pathname.startsWith('/webhooks/')) {
      drain(req);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }

    drain(req);
    const { status, failing } = recordWebhook(stats, pathname);

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(failing ? '{"error":"forced_failure"}' : '{"ok":true}');
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const stats = createStats();
  const server = createReceiverServer(stats);

  server.listen(PORT, '0.0.0.0', () => {
    // Operational line only: no payload data, no headers, no secrets.
    console.log(`loadtest receiver listening on :${PORT}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
}
