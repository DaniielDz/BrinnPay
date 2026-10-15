#!/usr/bin/env node
/**
 * BrinnPay local alert receiver (Phase 20 D6(a)).
 *
 * A zero-dependency HTTP sink for Alertmanager webhooks: prints each firing
 * or resolved alert batch as one NDJSON line to stdout, so
 * `docker compose logs -f alert-receiver` is the local notification channel.
 *
 * Deliberately minimal: no storage, no auth (it is only reachable on the
 * compose network), no PII — Alertmanager payloads already carry only the
 * alert labels/annotations defined in monitoring/prometheus/alerts.yml.
 */

import http from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/alerts") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
      // One NDJSON line per received batch: timestamp + compact alert summary.
      process.stdout.write(
        `${JSON.stringify({
          received_at: new Date().toISOString(),
          status: body?.status ?? "unknown",
          alerts: alerts.map((alert) => ({
            status: alert?.status ?? "unknown",
            name: alert?.labels?.alertname ?? "unknown",
            severity: alert?.labels?.severity ?? "unknown",
            summary: alert?.annotations?.summary ?? "",
            startsAt: alert?.startsAt ?? null,
            endsAt: alert?.endsAt ?? null,
          })),
        })}\n`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: alerts.length }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : PORT;
  process.stdout.write(
    `${JSON.stringify({
      event: "alert-receiver.listening",
      port: boundPort,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
