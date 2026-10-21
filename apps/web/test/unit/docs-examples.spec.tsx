import type { ComponentType } from 'react';

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from '@testing-library/react';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import AuthenticationPage from '../../app/(public)/docs/authentication/page';
import ErrorsPage from '../../app/(public)/docs/errors/page';
import IdempotencyPage from '../../app/(public)/docs/idempotency/page';
import PaymentsPage from '../../app/(public)/docs/payments/page';
import QuickstartPage from '../../app/(public)/docs/quickstart/page';
import RateLimitsPage from '../../app/(public)/docs/rate-limits/page';
import RefundsPage from '../../app/(public)/docs/refunds/page';
import WebhooksPage from '../../app/(public)/docs/webhooks/page';
import * as examples from '../../lib/docs/examples';
import { WEBHOOK_SIGNATURE_SCHEME, WEBHOOK_SIGNED_MESSAGE } from '../../lib/docs/facts';

/**
 * Examples hygiene and contract conformance (phase 15 §7, §11.3, §13.1).
 *
 * Two guarantees:
 *  1. nothing in the published docs — examples, guide copy or these tests —
 *     carries a real-looking credential; only the documented placeholder
 *     patterns are allowed;
 *  2. the signature example is a known vector: the documented
 *     `t=…,v1=…` scheme over `${t}.${rawBody}` verifies with HMAC-SHA256,
 *     and every cURL request shown targets a path the contract declares.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..', '..');
const webRoot = join(repoRoot, 'apps', 'web');

const openapiText = readFileSync(join(repoRoot, 'docs', 'openapi.yaml'), 'utf8');
const document = parseYaml(openapiText) as Record<string, any>;

interface CodeExampleLike {
  label: string;
  language: string;
  code: string;
}

function isCodeExample(value: unknown): value is CodeExampleLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CodeExampleLike).code === 'string' &&
    typeof (value as CodeExampleLike).label === 'string'
  );
}

const codeExamples = Object.values(examples).filter(isCodeExample);

/** Every source file whose text is published (or tested) in the docs area. */
function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => join(dir, entry))
    .filter((file) => /\.(ts|tsx)$/.test(file) && statSync(file).isFile());
}

const docsTestFiles = [...filesUnder(join(webRoot, 'test', 'unit')), ...filesUnder(join(webRoot, 'test', 'e2e'))]
  .filter((file) => /\/docs-.*\.spec\.(ts|tsx)$/.test(file))
  .concat(join(webRoot, 'test', 'e2e', 'home.smoke.spec.tsx'));

const corpus = [
  ...filesUnder(join(webRoot, 'app', '(public)', 'docs')),
  ...filesUnder(join(webRoot, 'lib', 'docs')),
  ...docsTestFiles,
];

const corpusText = corpus.map((file) => ({
  file: file.slice(webRoot.length + 1),
  text: readFileSync(file, 'utf8'),
}));

/** Patterns that would indicate real or reconstructable credential material. */
const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'API key material', pattern: /sk_(?:live|test)_[A-Za-z0-9]{6,}/ },
  { name: 'JSON Web Token', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'webhook secret', pattern: /whsec_[A-Za-z0-9]{6,}/ },
  { name: 'AWS access key id', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Documented placeholder forms a credential may take (§7, §11.3). */
const ALLOWED_TOKEN = /^(?:sk_test_…|sk_live_…|sk_test_\.+|sk_live_\.+|<[^<>]+>|\$[A-Z][A-Z0-9_]*)$/;
const ALLOWED_HOST = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|example\.(?:com|org|net))$/;

describe('examples hygiene (§11.3, §13.1)', () => {
  it('contains no real-looking credential in published docs or docs tests', () => {
    for (const { file, text } of corpusText) {
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        expect(text, `${file}: unexpected ${name}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps every password-shaped value a placeholder', () => {
    for (const { file, text } of corpusText) {
      for (const match of text.matchAll(/['"]?password['"]?\s*[:=]\s*(['"])([^'"]+)\1/gi)) {
        expect(match[2], `${file}: password must be a placeholder`).toMatch(/^<[^<>]+>$/);
      }
    }
  });

  it('keeps every bearer credential a documented placeholder', () => {
    for (const { file, text } of corpusText) {
      for (const match of text.matchAll(/Bearer\s+([A-Za-z0-9._~+/=-]{10,})/g)) {
        expect(match[1], `${file}: bearer credential must be a placeholder`).toMatch(ALLOWED_TOKEN);
      }
    }
  });

  it('never hardcodes an environment hostname (§7)', () => {
    for (const { file, text } of corpusText) {
      for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        expect(match[1], `${file}: unexpected host`).toMatch(ALLOWED_HOST);
      }
    }
  });

  it('renders guide and contract content through React only (§11.5)', () => {
    for (const { file, text } of corpusText) {
      for (const line of text.split('\n')) {
        // Comments may state that the API is never used; usage may not appear.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        expect(line, `${file}: HTML must not be injected`).not.toMatch(
          /dangerouslySetInnerHTML\s*[:=]/,
        );
        expect(line, `${file}: innerHTML must not be assigned`).not.toMatch(/\binnerHTML\s*=/);
      }
    }
  });

  it('uses the documented placeholder patterns, so the check is not vacuous', () => {
    const all = corpusText.map(({ text }) => text).join('\n');
    expect(all).toContain('sk_test_...');
    expect(all).toContain('<your-api-origin>');
    expect(all).toContain('<your-signing-secret>');
    expect(all).toContain('<your-access-token>');
    expect(all).toMatch(/<your_[a-z_]+>/);
    expect(all).not.toMatch(FORBIDDEN_PATTERNS[0].pattern);
  });
});

describe('signature verification example (§7, §13.1 known vector)', () => {
  const { secret, timestamp, rawBody } = examples.SIGNATURE_VECTOR;
  const signedMessage = `${timestamp}.${rawBody}`;
  const digest = createHmac('sha256', secret).update(signedMessage).digest('hex');
  const header = `t=${timestamp},v1=${digest}`;

  it('signs exactly `${t}.${rawBody}` with HMAC-SHA256', () => {
    expect(WEBHOOK_SIGNED_MESSAGE).toBe('${t}.${rawBody}');
    expect(signedMessage).toBe(
      WEBHOOK_SIGNED_MESSAGE.replace('${t}', String(timestamp)).replace('${rawBody}', rawBody),
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('formats the header as the published scheme', () => {
    expect(WEBHOOK_SIGNATURE_SCHEME).toBe('t=<unix-seconds>,v1=<lowercase-hex>');
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('verifies through the documented algorithm', () => {
    // Re-implement §5.9: parse the header, recompute over the raw body.
    const parts = Object.fromEntries(
      header.split(',').map((piece) => piece.split('=').map((value) => value.trim())),
    );
    const recomputed = createHmac('sha256', secret)
      .update(`${parts.t}.${rawBody}`)
      .digest('hex');
    expect(Number(parts.t)).toBe(timestamp);
    expect(parts.v1).toBe(recomputed);
  });

  it('ships copy-paste implementations of that scheme in both languages', () => {
    expect(examples.VERIFY_SIGNATURE_JS.code).toContain("createHmac('sha256', secret)");
    expect(examples.VERIFY_SIGNATURE_JS.code).toContain('update(`${timestamp}.${rawBody}`)');
    expect(examples.VERIFY_SIGNATURE_JS.code).toContain('timingSafeEqual');
    // A too-old `t` must be rejected (§5.9 tolerance window).
    expect(examples.VERIFY_SIGNATURE_JS.code).toContain('toleranceSeconds = 300');

    expect(examples.VERIFY_SIGNATURE_PY.code).toContain(
      'hmac.new(secret.encode(), signed_message,',
    );
    expect(examples.VERIFY_SIGNATURE_PY.code).toContain('f"{timestamp}.".encode() + raw_body');
    expect(examples.VERIFY_SIGNATURE_PY.code).toContain('hmac.compare_digest');
    expect(examples.VERIFY_SIGNATURE_PY.code).toContain('tolerance_seconds: int = 300');
  });
});

describe('cURL examples follow the canonical contract (§7, §12 AC8)', () => {
  const pathParameters: [RegExp, string][] = [
    [/\$PROJECT_ID|<your_project_id>/g, '{project_id}'],
    [/\$CUSTOMER_ID|<your_customer_id>/g, '{customer_id}'],
    [/\$PAYMENT_ID|<your_payment_id>/g, '{payment_id}'],
    [/\$ENDPOINT_ID|<your_endpoint_id>/g, '{endpoint_id}'],
    [/\$EVENT_ID|<your_event_id>/g, '{event_id}'],
  ];

  const requests = codeExamples.flatMap((example) =>
    example.code
      .split('\n')
      .filter((line) => /^\s*curl\s/.test(line))
      .map((line) => {
        const url = line.match(/\$BRINNPAY([^"\s]*)/)?.[1];
        if (!url) return null;
        const method = (line.match(/-X\s+([A-Za-z]+)/)?.[1] ?? 'GET').toUpperCase();
        let path = url.split('?')[0];
        for (const [pattern, replacement] of pathParameters) path = path.replace(pattern, replacement);
        return { example: example.label, method, path };
      })
      .filter((request): request is { example: string; method: string; path: string } =>
        Boolean(request),
    ),
  );

  it('targets declared paths with declared methods', () => {
    expect(requests.length).toBeGreaterThan(10);
    for (const request of requests) {
      const pathItem = document.paths[request.path];
      expect(pathItem, `${request.example}: undocumented path ${request.path}`).toBeTruthy();
      expect(
        pathItem[request.method.toLowerCase()],
        `${request.example}: ${request.method} ${request.path} is not in the contract`,
      ).toBeTruthy();
    }
  });

  it('shows the cURL flow of every guided flow that makes an API call (§7)', () => {
    const curlFlows: [string, ComponentType][] = [
      ['quickstart', QuickstartPage],
      ['authentication', AuthenticationPage],
      ['payments', PaymentsPage],
      ['refunds', RefundsPage],
      ['idempotency', IdempotencyPage],
      ['webhooks', WebhooksPage],
      ['errors', ErrorsPage],
      ['rate limits', RateLimitsPage],
    ];

    for (const [flow, Page] of curlFlows) {
      const { container, unmount } = render(<Page />);
      const captions = Array.from(container.querySelectorAll('figcaption')).map(
        (node) => node.textContent ?? '',
      );
      expect(
        captions.some((caption) => caption.startsWith('cURL')),
        `${flow}: cURL example missing`,
      ).toBe(true);
      unmount();
    }
  });

  it('shows registration, inspection and replay on the webhooks guide', () => {
    const { container, unmount } = render(<WebhooksPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('webhook-endpoints"');
    expect(text).toContain('/deliveries?limit=10');
    expect(text).toContain('/replay');
    unmount();
  });

  it('shows the D3 language set for the core flows', () => {
    const coreFlow = (labels: string[]) => {
      expect(labels).toEqual(expect.arrayContaining(['cURL', 'JavaScript (fetch)', 'Python (requests)']));
    };

    coreFlow([
      examples.CREATE_PAYMENT_CURL.label,
      examples.CREATE_PAYMENT_JS.label,
      examples.CREATE_PAYMENT_PY.label,
    ]);
    coreFlow([
      examples.CREATE_REFUND_CURL.label,
      examples.CREATE_REFUND_JS.label,
      examples.CREATE_REFUND_PY.label,
    ]);
    coreFlow([
      examples.RETRY_AFTER_429_CURL.label,
      examples.RETRY_AFTER_429_JS.label,
      examples.RETRY_AFTER_429_PY.label,
    ]);

    // Signature verification is a local computation, not an API call: cURL does
    // not apply, but both scripted languages are required.
    expect(examples.VERIFY_SIGNATURE_JS.label).toBe('JavaScript (Node)');
    expect(examples.VERIFY_SIGNATURE_PY.label).toBe('Python');
  });
});
