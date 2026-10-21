/**
 * Pure summary shaping shared by every scenario (D1).
 *
 * k6's `handleSummary(data)` receives the full metric tree; this module
 * projects it into the committed per-run artifacts:
 *
 * - `<results>/<scenario>.json` — machine-readable: scenario id, generation
 *   timestamp, profile, and every metric's type/values verbatim;
 * - a stdout text block with the headline figures (p50/p95/p99 durations,
 *   request rate, failure rate, check rate) that the runner captures into
 *   `docs/performance-baseline.md`.
 *
 * No thresholds are invented here (D3: measure first, set SLOs later) —
 * thresholds live in each scenario's `options`.
 */

/** One metric entry as k6 hands it to `handleSummary`. */
export function normalizeMetrics(metrics) {
  const out = {};
  if (!metrics || typeof metrics !== 'object') return out;
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric || typeof metric !== 'object') continue;
    const values = metric.values;
    if (!values || typeof values !== 'object') continue;
    const numeric = {};
    let hasNumber = false;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        numeric[key] = value;
        hasNumber = true;
      }
    }
    if (!hasNumber) continue;
    out[name] = { type: metric.type ?? 'unknown', values: numeric };
  }
  return out;
}

function fmt(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function ms(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${fmt(value, 1)}ms` : '-';
}

function lineFor(name, metric) {
  const v = metric.values;
  switch (metric.type) {
    case 'trend': {
      const p50 = v['med'] ?? v['p(50)'];
      const p95 = v['p(95)'];
      const p99 = v['p(99)'];
      return `${name.padEnd(34)} p50=${ms(p50)} p95=${ms(p95)} p99=${ms(p99)} avg=${ms(v.avg)} min=${ms(v.min)} max=${ms(v.max)}`;
    }
    case 'rate': {
      const pct = typeof v.rate === 'number' ? `${fmt(v.rate * 100, 3)}%` : '-';
      const passes = v.passes ?? 0;
      const fails = v.fails ?? 0;
      return `${name.padEnd(34)} rate=${pct} passes=${passes} fails=${fails}`;
    }
    case 'counter': {
      const count = v.count ?? v.value ?? 0;
      return `${name.padEnd(34)} count=${fmt(count, 0)}`;
    }
    default:
      return `${name.padEnd(34)} ${JSON.stringify(v)}`;
  }
}

const PRIORITY = [
  'http_req_duration',
  'http_reqs',
  'http_req_failed',
  'http_req_waiting',
  'checks',
  'iterations',
  'iterations_failed',
  'vus',
  'vus_max',
];

/**
 * Projects raw k6 summary data into the committed payload.
 *
 * @param {object} meta - `{ scenario, profile, notes }` from the scenario file.
 * @param {object} data - k6 `handleSummary` data.
 * @returns machine-readable payload object.
 */
export function buildSummaryPayload(meta, data) {
  const metrics = normalizeMetrics(data?.metrics);
  const ordered = {};
  for (const name of PRIORITY) {
    if (metrics[name]) ordered[name] = metrics[name];
  }
  for (const [name, metric] of Object.entries(metrics)) {
    if (!ordered[name]) ordered[name] = metric;
  }
  return {
    scenario: meta.scenario ?? 'unknown',
    generated_at: new Date().toISOString(),
    profile: meta.profile ?? {},
    notes: meta.notes ?? null,
    state: data?.state ?? null,
    metrics: ordered,
  };
}

/** Human-readable block the runner appends to the baseline doc. */
export function formatSummaryText(payload) {
  const lines = [];
  lines.push(`scenario: ${payload.scenario}`);
  lines.push(`profile: ${JSON.stringify(payload.profile)}`);
  lines.push(`generated_at: ${payload.generated_at}`);
  const metrics = payload.metrics ?? {};
  for (const [name, metric] of Object.entries(metrics)) {
    lines.push(lineFor(name, metric));
  }
  if (payload.notes) lines.push(`notes: ${payload.notes}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Returns the `{ filename: contents }` map for `handleSummary`.
 *
 * Filesystem writes go under `meta.resultsDir` (supplied k6-side by
 * `writeSummary` from `K6_RESULTS_DIR` — this module stays free of k6
 * globals so Node unit tests exercise the exact production path), falling
 * back to `/results`: the runner mounts `loadtest/results` there for
 * containerized k6. Stdout always carries the text form, which the runner
 * captures into `SUMMARY.txt`.
 */
export function buildSummaryFiles(meta, data) {
  const payload = buildSummaryPayload(meta, data);
  const rawBase = (meta && typeof meta.resultsDir === 'string' && meta.resultsDir) || '/results';
  const base = `${rawBase.replace(/\/+$/, '')}/${payload.scenario}`;
  return {
    [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
    stdout: formatSummaryText(payload),
  };
}
