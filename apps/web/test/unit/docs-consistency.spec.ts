import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  BASE_ERROR_CODES,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_OPERATION_SCOPES,
  IDEMPOTENCY_RETENTION_HOURS,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_HEADERS,
  RATE_LIMIT_SCOPES,
  REQUEST_LOG_RETENTION_DAYS,
  WEBHOOK_EVENT_RETENTION_DAYS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRYABLE_STATUSES,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_SCHEME,
  WEBHOOK_SIGNED_MESSAGE,
} from '../../lib/docs/facts';

/**
 * Consistency protection (phase 15 §9.2 / D8, §12 AC10).
 *
 * Every fact published through `lib/docs/facts.ts` is compared with the
 * canonical artifact that owns it — `docs/api-conventions.md`,
 * `docs/openapi.yaml` or the API's error-code constant. Either side drifting
 * fails this suite instead of silently publishing a wrong number.
 *
 * The canonical files are read from the repository checkout, never from the
 * web app's own copy, so a hand edit of a guide cannot launder itself.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..', '..');

const conventions = readFileSync(join(repoRoot, 'docs', 'api-conventions.md'), 'utf8');
const openapiText = readFileSync(join(repoRoot, 'docs', 'openapi.yaml'), 'utf8');
const errorCodeSource = readFileSync(
  join(repoRoot, 'apps', 'api', 'src', 'common', 'errors', 'error-code.ts'),
  'utf8',
);
const document = parseYaml(openapiText) as Record<string, any>;

/** Slice of the conventions document between two headings. */
function section(markdown: string, from: string, to: string): string {
  const start = markdown.indexOf(from);
  const end = markdown.indexOf(to);
  expect(start, `missing marker ${from}`).toBeGreaterThan(-1);
  expect(end, `missing marker ${to}`).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

/** Split a markdown table section into cells (separator rows dropped). */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .filter((line) => !/^\|[\s:-]+\|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

/** Remove markdown code spans from a cell. */
function plain(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

interface ClassRow {
  name: string;
  operations: string;
  limit: number;
  windowSeconds: number;
  scopes: string[];
}

/** Parse the `Class | Operations | 10 / 900 s | Scopes` rows of either source. */
function classRows(rows: string[][]): ClassRow[] {
  return rows.flatMap((cells) => {
    if (cells.length < 4) return [];
    const match = cells[2].match(/^(\d+) \/ (\d+) s$/);
    if (!match) return [];
    return [
      {
        name: plain(cells[0]),
        operations: plain(cells[1]),
        limit: Number(match[1]),
        windowSeconds: Number(match[2]),
        scopes: plain(cells[3])
          .split(',')
          .map((scope) => scope.trim()),
      },
    ];
  });
}

/** Parse the `Scope | Discriminator | Applies to` rows. */
function scopeRows(rows: string[][]): { scope: string; discriminator: string; appliesTo: string }[] {
  return rows.flatMap((cells) => {
    if (cells.length < 3 || !cells[0].startsWith('`')) return [];
    return [{ scope: plain(cells[0]), discriminator: plain(cells[1]), appliesTo: plain(cells[2]) }];
  });
}

/** Parse the `Header | On | Meaning` rows. */
function headerRows(rows: string[][]): { header: string; on: string; meaning: string }[] {
  return rows.flatMap((cells) => {
    if (cells.length < 3 || !cells[0].startsWith('`')) return [];
    return [{ header: plain(cells[0]), on: plain(cells[1]), meaning: plain(cells[2]) }];
  });
}

/** The published retry schedule, formatted the way both sources write it. */
function publishedSchedule(): string {
  return WEBHOOK_RETRY_SCHEDULE_SECONDS.map((seconds) => {
    if (seconds === 0) return '0 s';
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${seconds / 60} min`;
    return `${seconds / 3600} h`;
  }).join(', ');
}

describe('D8 — rate-limit defaults (api-conventions §10 vs openapi info.description)', () => {
  it('matches the operation-class table in api-conventions.md §10.2', () => {
    const canonical = classRows(tableRows(section(conventions, '### 10.2', '### 10.3')));
    expect(canonical).toHaveLength(RATE_LIMIT_CLASSES.length);
    expect(canonical).toEqual([...RATE_LIMIT_CLASSES]);
  });

  it('matches the operation-class table in openapi.yaml info.description', () => {
    const description: string = document.info.description;
    const block = section(description, '**Operation classes and defaults**', '**Excluded');
    const canonical = classRows(tableRows(block));
    expect(canonical).toHaveLength(RATE_LIMIT_CLASSES.length);
    expect(canonical).toEqual([...RATE_LIMIT_CLASSES]);
  });

  it('matches the budget scopes in api-conventions.md §10.1', () => {
    const canonical = scopeRows(tableRows(section(conventions, '### 10.1', '### 10.2')));
    expect(canonical).toEqual([...RATE_LIMIT_SCOPES]);
  });

  it('matches the response headers in api-conventions.md §10.4', () => {
    const canonical = headerRows(tableRows(section(conventions, '### 10.4', '### 10.5')));
    expect(canonical).toEqual([...RATE_LIMIT_HEADERS]);
  });

  it('publishes only the Q1-approved sections (§10.1–10.5) as facts', () => {
    // The operator-only sections must not leak into the published fact set.
    const names = RATE_LIMIT_CLASSES.map((row) => row.name).join(' ');
    expect(names).not.toMatch(/redis|proxy|fail[-_ ]?mode/i);
    expect(section(conventions, '### 10.6', '### 10.8')).toContain('Redis unavailability');
    expect(openapiText).toContain('RATE_LIMIT_FAIL_MODE');
  });
});

describe('D8 — idempotency retention and key bounds', () => {
  it('agrees with the 24-hour window in both canonical sources', () => {
    expect(IDEMPOTENCY_RETENTION_HOURS).toBe(24);
    expect(conventions).toContain(`After ${IDEMPOTENCY_RETENTION_HOURS} hours`);
    expect(conventions).toContain(`The ${IDEMPOTENCY_RETENTION_HOURS}-hour retention window`);
    expect(openapiText).toContain(`${IDEMPOTENCY_RETENTION_HOURS}-hour retention window`);
    expect(openapiText).toContain(`within the ${IDEMPOTENCY_RETENTION_HOURS}-hour retention window`);
  });

  it('agrees with the header bounds declared by the contract', () => {
    const parameter = document.components.parameters.IdempotencyKey;
    expect(parameter.schema.minLength).toBe(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(parameter.schema.maxLength).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  it('names only operation scopes that exist in the contract', () => {
    const operationIds = new Set<string>();
    for (const pathItem of Object.values(document.paths as Record<string, any>)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const operation = pathItem?.[method];
        if (operation?.operationId) operationIds.add(String(operation.operationId));
      }
    }
    for (const scope of IDEMPOTENCY_OPERATION_SCOPES) {
      expect(operationIds.has(scope)).toBe(true);
      expect(conventions).toContain(`\`${scope}\``);
    }
  });
});

describe('D8 — base error codes', () => {
  it('equals the API ErrorCode constant', () => {
    const block = errorCodeSource.match(/export const ErrorCode = \{([\s\S]*?)\} as const;/)?.[1];
    expect(block, 'ErrorCode constant not found').toBeTruthy();

    const canonical = [...(block ?? '').matchAll(/^\s*([A-Z_]+): '([A-Z_]+)',/gm)].map(
      (match) => match[2],
    );
    expect(canonical.length).toBeGreaterThan(0);
    for (const match of (block ?? '').matchAll(/^\s*([A-Z_]+): '([A-Z_]+)',/gm)) {
      expect(match[1], 'key and value must name the same code').toBe(match[2]);
    }
    expect([...BASE_ERROR_CODES]).toEqual(canonical);
  });

  it('includes every general code listed in api-conventions.md §6', () => {
    const errorSection = section(conventions, '## 6. Errors', '## 7. Request IDs');
    const enumerateFrom = errorSection.indexOf('General codes include');
    const enumerateTo = errorSection.indexOf('domain phases add', enumerateFrom);
    expect(enumerateFrom).toBeGreaterThan(-1);
    expect(enumerateTo).toBeGreaterThan(enumerateFrom);

    const listed = [...errorSection.slice(enumerateFrom, enumerateTo).matchAll(/`([A-Z_]+)`/g)].map(
      (match) => match[1],
    );
    expect(listed.length).toBeGreaterThan(0);
    for (const code of listed) expect(BASE_ERROR_CODES).toContain(code);

    // §6 enumerates six general codes; the two codes it does not enumerate are
    // still base codes of `ErrorCode` and are published by the guide.
    expect([...BASE_ERROR_CODES].filter((code) => !listed.includes(code))).toEqual([
      'BUSINESS_RULE_VIOLATION',
      'INTERNAL_ERROR',
    ]);

    // A representative domain code is documented as an example, not as a base code.
    expect(errorSection).toContain('`PAYMENT_ALREADY_REFUNDED`');
    expect(BASE_ERROR_CODES).not.toContain('PAYMENT_ALREADY_REFUNDED');
  });
});

describe('D8 — webhook delivery facts (openapi webhooks operations)', () => {
  const deliveries = document.paths['/projects/{project_id}/webhook-endpoints/{endpoint_id}/deliveries'];
  const description: string = deliveries.get.description;

  it('states the five-attempt ladder exactly as published', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(description).toMatch(/up to five attempts total/);
    expect(description).toContain(publishedSchedule());
    expect(publishedSchedule()).toBe('0 s, 30 s, 2 min, 10 min, 1 h');
  });

  it('states the retryable statuses and the terminal 3xx rule', () => {
    expect(description).toContain(WEBHOOK_RETRYABLE_STATUSES.slice(0, 3).join(', '));
    expect(description).toContain(WEBHOOK_RETRYABLE_STATUSES[3]);
    expect(description).toMatch(/every 3xx are terminal/);
    expect(description).toMatch(/Redirects are never followed/);
  });

  it('states the signature header, value scheme and signed message', () => {
    expect(description).toContain(WEBHOOK_SIGNATURE_HEADER);
    // The published scheme names the digest; the contract writes it out.
    expect(WEBHOOK_SIGNATURE_SCHEME).toBe('t=<unix-seconds>,v1=<lowercase-hex>');
    expect(description).toContain(`${WEBHOOK_SIGNATURE_SCHEME.slice(0, -1)} HMAC-SHA256>`);
    expect(description).toContain(WEBHOOK_SIGNED_MESSAGE);
    expect(description).toMatch(/exact bytes transmitted/);
  });

  it('keeps the closed event catalog in sync with the contract schema', () => {
    expect(document.components.schemas.WebhookEventType.enum).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(description).toMatch(/deduplicate by envelope/);
  });

  it('agrees with the 30-day event and request-log retention', () => {
    expect(WEBHOOK_EVENT_RETENTION_DAYS).toBe(30);
    expect(REQUEST_LOG_RETENTION_DAYS).toBe(30);

    const events: string = document.paths['/projects/{project_id}/webhook-events'].get.description;
    expect(events).toContain(`default ${WEBHOOK_EVENT_RETENTION_DAYS} days`);
    expect(events).toMatch(/404 on replay/);

    const logs: string = document.paths['/projects/{project_id}/logs/requests'].get.description;
    expect(logs).toContain(`default **${REQUEST_LOG_RETENTION_DAYS} days**`);
  });
});
