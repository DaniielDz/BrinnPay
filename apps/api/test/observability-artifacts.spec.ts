import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

/**
 * Phase 20 artifact tests (AC3/AC4/AC8/§8 rule 8): the committed monitoring
 * artifacts must parse, must reference only documented local endpoints, must
 * carry exactly the four committed alert rules, and must be free of secrets
 * and PII. This is the CI validator for artifacts that have no cheaper
 * validator (§9): YAML/JSON structure, rule catalog, and a leakage sweep.
 *
 * These are pure file reads — no application boot — so they live in the unit
 * layer (`test/` specs) and run in every `pnpm test`.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MONITORING = path.join(REPO_ROOT, 'monitoring');

const read = (relative: string): string => readFileSync(path.join(MONITORING, relative), 'utf8');
const readJson = <T>(relative: string): T => JSON.parse(read(relative)) as T;

/** Every committed file under monitoring/, recursively (for the hygiene sweep). */
function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

interface PrometheusConfig {
  global?: { scrape_interval?: string };
  alerting?: { alertmanagers?: { static_configs?: { targets?: string[] }[] }[] };
  rule_files?: string[];
  scrape_configs?: {
    job_name: string;
    metrics_path?: string;
    authorization?: { type?: string; credentials?: string; credentials_file?: string };
    static_configs?: { targets?: string[]; labels?: Record<string, string> }[];
  }[];
}

interface AlertRuleGroup {
  name: string;
  rules: {
    alert: string;
    expr: string;
    for: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  }[];
}

interface AlertmanagerConfig {
  route?: { receiver?: string };
  receivers?: { name: string; webhook_configs?: { url?: string }[] }[];
}

describe('monitoring artifacts (Phase 20)', () => {
  it('prometheus.yml parses and scrapes only documented local targets (AC3/AC11)', () => {
    const config = parse(read('prometheus/prometheus.yml')) as PrometheusConfig;

    expect(config.global?.scrape_interval).toBe('15s');
    expect(config.rule_files).toEqual(['/etc/prometheus/alerts.yml']);

    const jobs = config.scrape_configs ?? [];
    const byName = new Map(jobs.map((job) => [job.job_name, job]));

    expect(byName.has('brinnpay-api')).toBe(true);
    expect(byName.get('brinnpay-api')?.metrics_path).toBe('/metrics');
    expect(byName.get('brinnpay-api')?.static_configs?.[0]?.targets).toEqual(['api:3000']);
    // D4(a): the scrape carries the optional bearer token through a
    // container-local credentials file written at container start from
    // METRICS_SCRAPE_TOKEN — Prometheus itself does not expand ${VARS} in its
    // config (it would send the literal text), so a committed placeholder
    // here would silently disable token auth.
    for (const job of ['brinnpay-api', 'brinnpay-worker']) {
      expect(byName.get(job)?.authorization?.type).toBe('Bearer');
      expect(byName.get(job)?.authorization?.credentials_file).toBe(
        '/tmp/brinnpay_scrape_token',
      );
      expect(byName.get(job)?.authorization?.credentials).toBeUndefined();
    }

    expect(byName.get('brinnpay-worker')?.static_configs?.[0]?.targets).toEqual(['worker:9464']);
    expect(byName.get('postgres')?.static_configs?.[0]?.targets).toEqual(['postgres-exporter:9187']);
    expect(byName.get('redis')?.static_configs?.[0]?.targets).toEqual(['redis-exporter:9121']);

    // Committed artifacts reference only compose-network or loopback names.
    const allowedHosts = new Set([
      'api:3000',
      'worker:9464',
      'postgres-exporter:9187',
      'redis-exporter:9121',
      'localhost:9090',
      'alertmanager:9093',
    ]);
    for (const job of jobs) {
      for (const config_ of job.static_configs ?? []) {
        for (const target of config_.targets ?? []) {
          expect(allowedHosts).toContain(target);
        }
      }
    }
    const alertTargets = (config.alerting?.alertmanagers ?? []).flatMap(
      (manager) => manager.static_configs?.flatMap((c) => c.targets ?? []) ?? [],
    );
    expect(alertTargets).toEqual(['alertmanager:9093']);
  });

  it('alerts.yml carries exactly the four committed rules over the shipped catalog (D6(a), AC4)', () => {
    const groups = parse(read('prometheus/alerts.yml')) as { groups: AlertRuleGroup[] };
    const rules = groups.groups.flatMap((group) => group.rules);

    expect(rules).toHaveLength(4);
    const names = rules.map((rule) => rule.alert).sort();
    expect(names).toEqual([
      'BrinnPayApiErrorRateHigh',
      'BrinnPayDeliveryQueueLag',
      'BrinnPayRateLimitDegraded',
      'BrinnPayRequestLogWriteAnomaly',
    ]);

    const byName = new Map(rules.map((rule) => [rule.alert, rule]));

    // Every rule fires on a metric this phase actually ships (closed catalog).
    expect(byName.get('BrinnPayApiErrorRateHigh')?.expr).toContain(
      'brinnpay_http_requests_total',
    );
    expect(byName.get('BrinnPayRateLimitDegraded')?.expr).toContain(
      'brinnpay_rate_limit_degraded',
    );
    expect(byName.get('BrinnPayDeliveryQueueLag')?.expr).toContain(
      'brinnpay_delivery_oldest_pending_age_seconds',
    );
    expect(byName.get('BrinnPayRequestLogWriteAnomaly')?.expr).toContain(
      'brinnpay_request_log_writes_total',
    );

    for (const rule of rules) {
      // Guardrails with a duration, never instant flaps (§4 rule 8).
      expect(rule.for).toMatch(/^\d+m$/);
      expect(rule.labels?.severity).toBe('warning');
      // Every rule is framed by its precedent — a baseline number, a trigger
      // register, or a prior-phase handover — never as an invented product SLO.
      expect(rule.annotations?.description ?? '').toMatch(
        /baseline|ADR-00\d\d|guardrail|handover/i,
      );
      expect(rule.annotations?.summary ?? '').not.toMatch(/SLO|SLA|target of/i);
    }
  });

  it('alertmanager.yml routes every alert to the local receiver, with no external target (D6(a))', () => {
    const config = parse(read('alertmanager/alertmanager.yml')) as AlertmanagerConfig;

    expect(config.route?.receiver).toBe('alert-receiver');
    const receivers = config.receivers ?? [];
    expect(receivers).toHaveLength(1);
    expect(receivers[0].name).toBe('alert-receiver');
    expect(receivers[0].webhook_configs?.[0]?.url).toBe('http://alert-receiver:8080/alerts');

    // No email, no SaaS, no paging — D6(a) is rules-only with local notify.
    const serialized = read('alertmanager/alertmanager.yml');
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/https?:\/\/(?!alert-receiver)/);
  });

  it('grafana provisioning pins the datasource UID the dashboards reference (AC3)', () => {
    const datasource = parse(
      read('grafana/provisioning/datasources/prometheus.yml'),
    ) as { datasources?: { uid?: string; url?: string }[] };
    expect(datasource.datasources?.[0]?.uid).toBe('prometheus');
    expect(datasource.datasources?.[0]?.url).toBe('http://prometheus:9090');

    const provider = parse(
      read('grafana/provisioning/dashboards/dashboards.yml'),
    ) as { providers?: { options?: { path?: string } }[] };
    expect(provider.providers?.[0]?.options?.path).toBe('/var/lib/grafana/dashboards');
  });

  it('every dashboard parses, uses the provisioned datasource, and panels the M3 minimum set (AC3)', () => {
    const dir = path.join(MONITORING, 'grafana', 'dashboards');
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    expect(files.sort()).toEqual(['api.json', 'infrastructure.json', 'worker.json']);

    interface Panel {
      type: string;
      title: string;
      datasource?: { uid?: string };
      targets?: { expr?: string }[];
    }
    interface Dashboard {
      title: string;
      uid?: string;
      panels: Panel[];
    }

    const dashboards = files.map((file) =>
      readJson<Dashboard>(path.join('grafana', 'dashboards', file)),
    );

    // M3 minimum coverage, distributed across the three dashboards.
    const allExprs = dashboards
      .flatMap((dashboard) => dashboard.panels)
      .flatMap((panel) => panel.targets ?? [])
      .map((target) => target.expr ?? '')
      .join('\n');
    for (const signal of [
      'brinnpay_http_requests_total',
      'brinnpay_rate_limit_throttled_requests_total',
      'brinnpay_rate_limit_degraded',
      'brinnpay_request_log_writes_total',
      'brinnpay_queue_jobs',
      'brinnpay_delivery_oldest_pending_age_seconds',
      'brinnpay_worker_sweep_duration_seconds',
      'pg_stat_activity_count',
      'redis_connected_clients',
    ]) {
      expect(allExprs).toContain(signal);
    }

    for (const dashboard of dashboards) {
      expect(dashboard.uid).toBeTruthy();
      expect(dashboard.panels.length).toBeGreaterThan(0);
      for (const panel of dashboard.panels) {
        // Datasource by the provisioned UID — no hand-wired URLs in panels.
        expect(panel.datasource?.uid).toBe('prometheus');
      }
      // Written as if public: no credentials, no PII, no non-local hostnames
      // beyond the compose service names the queries target.
      const serialized = JSON.stringify(dashboard);
      expect(serialized).not.toMatch(/password|secret|token|authorization/i);
      expect(serialized).not.toContain('example.com');
      expect(serialized).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    }
  });

  it('the monitoring tree carries no secret-shaped material (§8 rule 8)', () => {
    const files = listFiles(MONITORING);
    expect(files.length).toBeGreaterThan(5);

    // Secret-shaped patterns that must never appear in committed artifacts.
    // The base64-blob pattern is scoped to base64 *with* padding or a
    // header/credential context so markdown prose (URL-free base64 alphabet
    // runs like "docker compose --profile monitoring") is not a false hit.
    const forbidden = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /AKIA[0-9A-Z]{16}/,
      /gh[pousr]_[A-Za-z0-9]{20,}/,
      /sk_live_[A-Za-z0-9]{16,}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/=]{32,}['"]/i,
      /[A-Za-z0-9+/]{60,}={1,2}/,
    ];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect({ file, match: pattern.exec(content)?.[0] ?? null }).toEqual({ file, match: null });
      }
    }
  });
});
