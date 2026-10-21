import type { ComponentType } from 'react';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import ApiKeysPage from '../../app/(public)/docs/api-keys/page';
import AuthenticationPage from '../../app/(public)/docs/authentication/page';
import EnvironmentsPage from '../../app/(public)/docs/environments/page';
import ErrorsPage from '../../app/(public)/docs/errors/page';
import IdempotencyPage from '../../app/(public)/docs/idempotency/page';
import LocalDevelopmentPage from '../../app/(public)/docs/local-development/page';
import LogsPage from '../../app/(public)/docs/logs/page';
import PaymentsPage from '../../app/(public)/docs/payments/page';
import QuickstartPage from '../../app/(public)/docs/quickstart/page';
import RateLimitsPage from '../../app/(public)/docs/rate-limits/page';
import RefundsPage from '../../app/(public)/docs/refunds/page';
import SandboxPage from '../../app/(public)/docs/sandbox/page';
import WebhooksPage from '../../app/(public)/docs/webhooks/page';
import { RATE_LIMIT_CLASSES, WEBHOOK_RETRY_SCHEDULE_SECONDS } from '../../lib/docs/facts';

/**
 * Phase 15 §5 / §12 AC4: one focused group per guide, asserting the required
 * content of that guide's specification section. Every test renders its own
 * page (RTL cleanup unmounts between tests), and assertions target facts and
 * copy — never styling internals (phase 14 rule).
 */

interface RenderedGuide {
  container: HTMLElement;
  text: string;
}

/** Renders one guide page and exposes its DOM node and visible text. */
function renderGuide(Page: ComponentType): RenderedGuide {
  const { container } = render(<Page />);
  return { container, text: container.textContent ?? '' };
}

/** Captions of the code blocks a guide renders, e.g. `cURL` or `JavaScript (fetch)`. */
function codeLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('figcaption')).map(
    (caption) => caption.textContent ?? '',
  );
}

describe('quickstart (phase 15 §5.2, D4)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(QuickstartPage);
  });

  it('walks the confirmed onboarding path in order', () => {
    for (const step of [
      '1. Create an account',
      '2. Create a project',
      '3. Create a TEST API key',
      '5. Create a customer',
      '6. Create a payment',
      '7. Watch the payment succeed',
      '8. Register a webhook endpoint and verify a delivery',
    ]) {
      expect(screen.getByRole('heading', { name: step })).toBeInTheDocument();
    }
    // A default personal organization already exists — no setup step (ADR-0010).
    expect(guide.text).toMatch(/default personal\s+organization is created for you/i);
  });

  it('links every step to its full guide', () => {
    expect(guide.text).toContain('How authentication works');
    expect(guide.text).toContain('API keys in detail');
    expect(guide.text).toContain('Payments in detail');
    expect(guide.text).toContain('Idempotency in detail');
    expect(guide.text).toContain('Webhooks in detail');
    expect(guide.text).toContain('What the sandbox simulates');
    expect(guide.text).toContain('Local development');
  });

  it('uses TEST values and placeholder credentials only', () => {
    expect(guide.text).toContain('sk_test_...');
    expect(guide.text).toMatch(/TEST environment|test" environment/);
    // Nothing that does not exist may be required (D6, §14).
    expect(guide.text).not.toMatch(/\bCLI\b|\bsdk\b/i);
  });

  it('names the scenario catalog instead of promising universal success (phase 16 §6.2)', () => {
    expect(guide.text).toMatch(/scenario: "decline"/);
    expect(guide.text).toMatch(/scenario: "timeout"/);
    expect(guide.text).toMatch(/every unflagged payment/i);
  });
});

describe('authentication (phase 15 §5.3)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(AuthenticationPage);
  });

  it('describes both modes and that they are not equivalent', () => {
    expect(guide.text).toContain('Authorization: Bearer sk_test_… / sk_live_…');
    expect(guide.text).toContain('Authorization: Bearer <your-access-token>');
    expect(guide.text).toMatch(/not interchangeable|not\s*\*?\*?equivalent/i);
    expect(guide.text).toMatch(/No organization-management authority/i);
    expect(guide.text).toMatch(/organization memberships, subject to role permissions/i);
  });

  it('states which route areas accept which mode', () => {
    expect(guide.text).toContain('auth/*, organizations/*, projects/*, api-keys/*, logs/*');
    expect(guide.text).toContain('customers/*, payments/*, refunds/*, webhook-*');
    expect(guide.text).toContain('Session only');
    expect(guide.text).toContain('API key or session');
  });

  it('explains how each credential is obtained', () => {
    expect(guide.text).toContain('/auth/login');
    expect(guide.text).toContain('/auth/refresh');
    expect(guide.text).toMatch(/HttpOnly/);
    expect(guide.text).toMatch(/never.{0,40}JSON body/i);
  });

  it('documents each failure and the minimal request example', () => {
    expect(guide.text).toContain('UNAUTHENTICATED');
    expect(guide.text).toContain('FORBIDDEN');
    expect(guide.text).toContain('NOT_FOUND');
    expect(guide.text).toContain('Existence is never disclosed');
    expect(guide.text).toContain('-H "Authorization: Bearer sk_test_..."');
  });
});

describe('api keys (phase 15 §5.4)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(ApiKeysPage);
  });

  it('documents format, scope and one-time display', () => {
    expect(guide.text).toContain('sk_test_…');
    expect(guide.text).toContain('sk_live_…');
    expect(guide.text).toMatch(/exactly one project and one environment/i);
    expect(guide.text).toMatch(/no.{0,30}organization-management authority/i);
    expect(guide.text).toMatch(/shown once|creation response/i);
    expect(guide.text).toMatch(/only a hash is stored/i);
  });

  it('documents rotation, revocation and leak response', () => {
    expect(guide.text).toMatch(/create, then revoke/i);
    expect(guide.text).toMatch(/both are valid for a short window|overlap is intentional/i);
    expect(guide.text).toMatch(/Revocation is immediate/i);
    expect(guide.text).toContain('401 UNAUTHENTICATED');
    expect(guide.text).toMatch(/Revoke or rotate the exposed key first/i);
  });

  it('states that plaintext keys are never logged', () => {
    expect(guide.text).toMatch(/never its plaintext|never be displayed again/i);
    expect(guide.text).toMatch(/identifier,\s*never its plaintext/i);
  });

  it('ties keys to both rate-limit budgets', () => {
    expect(guide.text).toMatch(/spends two budgets|two budgets|ip.*budget and the key/i);
    expect(guide.text).toContain('Rate limits in detail');
  });
});

describe('environments (phase 15 §5.5)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(EnvironmentsPage);
  });

  it('states both environments are simulated and both exist per project', () => {
    expect(guide.text).toMatch(/Neither processes real money|processes no real money/i);
    expect(guide.text).toMatch(/supports both environments by default/i);
    expect(guide.text).toMatch(/never mixed/i);
  });

  it('keeps the API and UI spellings apart', () => {
    expect(guide.text).toContain('test / live');
    expect(guide.text).toContain('TEST / LIVE');
    expect(guide.text).toContain('sk_test_… / sk_live_…');
    expect(guide.text).toMatch(/never mixed inside a single artifact/i);
  });

  it('explains where the environment comes from per mode', () => {
    expect(guide.text).toMatch(/Derived from the key/i);
    expect(guide.text).toMatch(/rejected with 422/);
    expect(guide.text).toMatch(/Declared explicitly/i);
    expect(guide.text).toMatch(/environment query (parameter|filter)/i);
    expect(guide.text).toMatch(/environment-scoped resource belongs to exactly one/i);
    expect(guide.text).toMatch(/API keys are the exception/i);
  });

  it('describes the dashboard selector as a query parameter defaulting to test', () => {
    expect(guide.text).toMatch(/environment query parameter/i);
    expect(guide.text).toMatch(/The default is test/i);
    expect(guide.text).toMatch(/unknown value falls back/i);
  });
});

describe('payments (phase 15 §5.6)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(PaymentsPage);
  });

  it('covers create, retrieve and list with cursor pagination', () => {
    expect(guide.text).toContain('/projects/{project_id}/payments');
    expect(guide.text).toContain('limit');
    expect(guide.text).toContain('next_cursor');
    expect(guide.text).toContain('has_more');
    expect(guide.text).toMatch(/opaque strings.*do not decode|do not decode them/i);
  });

  it('states the required create body and the money conventions', () => {
    for (const field of ['environment', 'customer_id', 'amount', 'currency', 'description']) {
      expect(guide.text).toContain(field);
    }
    expect(guide.text).toMatch(/existing customer/i);
    expect(guide.text).toContain('"10.00"');
    expect(guide.text).toMatch(/only currency in the MVP/i);
  });

  it('documents the simulated state machine and its scenario-driven failures', () => {
    expect(guide.text).toContain('pending');
    expect(guide.text).toContain('processing');
    expect(guide.text).toContain('succeeded');
    expect(guide.text).toContain('failed');
    expect(guide.text).toMatch(/processing → failed/);
    expect(guide.text).toMatch(/scenario: "decline"/);
    expect(guide.text).toMatch(/never disclosed at creation/i);
    expect(guide.text).toMatch(/survives restarts/i);
    expect(guide.text).toMatch(/Observe the progression by polling/i);
  });

  it('lists scenario and failure_code as optional create fields (phase 16 §6.2)', () => {
    expect(guide.text).toContain('scenario');
    expect(guide.text).toContain('failure_code');
    expect(guide.text).toContain('succeed (default) | decline | timeout');
    expect(guide.text).toContain(
      'card_declined (default) | insufficient_funds | processing_timeout',
    );
    expect(guide.text).toMatch(/only with scenario: "decline"/i);
  });

  it('documents environment scoping, idempotency and who may create', () => {
    expect(guide.text).toContain('Idempotency-Key');
    expect(guide.text).toMatch(/owner and admin only/i);
    expect(guide.text).toMatch(/member and viewer get/i);
    expect(guide.text).toMatch(/the key is the scope/i);
    expect(guide.text).toMatch(/reported as 404/i);
  });

  it('shows the cURL, JavaScript and Python variants of the create call (D3)', () => {
    const labels = codeLabels(guide.container);
    expect(labels).toContain('cURL');
    expect(labels).toContain('JavaScript (fetch)');
    expect(labels).toContain('Python (requests)');
  });
});

describe('refunds (phase 15 §5.7)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(RefundsPage);
  });

  it('states refunds target a succeeded payment and complete synchronously', () => {
    expect(guide.text).toMatch(/against a succeeded payment/i);
    expect(guide.text).toMatch(/complete synchronously/i);
    expect(guide.text).toContain('status: "succeeded"');
    expect(guide.text).toMatch(/own status does not change/i);
    expect(guide.text).toMatch(/stays succeeded/i);
  });

  it('states omitted amount means the remaining balance', () => {
    expect(guide.text).toMatch(/full remaining balance/i);
    expect(guide.text).toMatch(/does not exceed the remaining balance/i);
  });

  it('documents the rejection matrix', () => {
    expect(guide.text).toContain('422 BUSINESS_RULE_VIOLATION');
    expect(guide.text).toContain('PAYMENT_ALREADY_REFUNDED');
    expect(guide.text).toContain('409 CONFLICT');
    expect(guide.text).toMatch(/generic conflict that reveals nothing/i);
  });

  it('documents the refunds.create idempotency scope and its window', () => {
    expect(guide.text).toContain('refunds.create');
    expect(guide.text).toContain('24 hours');
    expect(guide.text).toContain('payments.create');
  });

  it('documents authorization and per-payment listing', () => {
    expect(guide.text).toMatch(/owner and admin only/i);
    expect(guide.text).toMatch(/List a payment.s refunds/i);
    expect(guide.text).toContain('next_cursor');
    expect(guide.text).toMatch(/reason/i);
    expect(guide.text).toMatch(/usd/i);
  });
});

describe('idempotency (phase 15 §5.8)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(IdempotencyPage);
  });

  it('states the header bounds and the operation scopes', () => {
    expect(guide.text).toContain('Idempotency-Key');
    expect(guide.text).toMatch(/1–255 characters/);
    expect(guide.text).toContain('payments.create');
    expect(guide.text).toContain('refunds.create');
  });

  it('states the 24-hour window and the scope tuple', () => {
    expect(guide.text).toContain('24 hours');
    expect(guide.text).toMatch(/\(project, operation scope, key\)/);
    expect(guide.text).toMatch(/treated as a brand-new operation|A new operation/);
  });

  it('states what is stored, the replay request id and 429 behavior', () => {
    expect(guide.text).toMatch(/committed successful/i);
    expect(guide.text).toMatch(/current request.s X-Request-Id/);
    expect(guide.text).toMatch(/neither does a 429/);
    expect(guide.text).toMatch(/exactly one side effect/i);
  });

  it('gives a client retry pattern', () => {
    expect(guide.text).toMatch(/Generate one key per logical operation/);
    expect(guide.text).toMatch(/never blindly retry/i);
  });
});

describe('webhooks (phase 15 §5.9)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(WebhooksPage);
  });

  it('documents endpoint registration against the closed catalog', () => {
    for (const type of [
      'payment.created',
      'payment.succeeded',
      'payment.failed',
      'refund.created',
    ]) {
      expect(guide.text).toContain(type);
    }
    expect(guide.text).toMatch(/Duplicate URLs are allowed/i);
    expect(guide.text).toMatch(/10 requests per hour/i);
    expect(guide.text).toMatch(/owner or admin/i);
  });

  it('documents the one-time signing secret', () => {
    expect(guide.text).toMatch(/Returned once, at creation/);
    expect(guide.text).toMatch(/not recoverable/i);
    expect(guide.text).toMatch(/delete the endpoint and create a new one/i);
  });

  it('documents the exact signature scheme', () => {
    expect(guide.text).toContain('BrinnPay-Signature');
    expect(guide.text).toContain('BrinnPay-Event-Id');
    expect(guide.text).toContain('BrinnPay-Event-Type');
    expect(guide.text).toContain('BrinnPay-Delivery-Id');
    expect(guide.text).toContain('BrinnPay-Attempt');
    expect(guide.text).toContain('BrinnPay-Webhooks/1.0');
    expect(guide.text).toContain('t=<unix-seconds>,v1=<lowercase-hex>');
    expect(guide.text).toContain('${t}.${rawBody}');
    expect(guide.text).toMatch(/raw request body bytes/i);
    expect(guide.text).toMatch(/HMAC-SHA256/);
  });

  it('documents at-least-once unordered delivery and deduplication', () => {
    expect(guide.text).toMatch(/At-least-once/);
    expect(guide.text).toMatch(/Unordered/);
    expect(guide.text).toMatch(/Deduplicate on the envelope id/i);
  });

  it('states the five-attempt retry ladder and its bounds', () => {
    expect(guide.text).toMatch(/5 attempts total/);
    expect(guide.text).toContain('0 s, 30 s, 2 min, 10 min, 1 h');
    expect(WEBHOOK_RETRY_SCHEDULE_SECONDS).toEqual([0, 30, 120, 600, 3600]);
    expect(guide.text).toContain('408, 425, 429 and every 5xx');
    expect(guide.text).toMatch(/3xx — never retried/i);
    expect(guide.text).toMatch(/Retry-After.*honored/i);
  });

  it('documents replay and its budget, retention and destination rules', () => {
    expect(guide.text).toMatch(/20 requests per 5 minutes/i);
    expect(guide.text).toMatch(/retained for 30 days/i);
    expect(guide.text).toMatch(/replay attempt answers 404/i);
    expect(guide.text).toMatch(/Absolute http or https URL/i);
    expect(guide.text).toMatch(/No embedded credentials and no fragment/i);
    expect(guide.text).toMatch(/Localhost and private hosts are allowed by default/i);
    expect(guide.text).toMatch(/denied host fails/i);
  });

  it('gives the recommended consumer sequence', () => {
    expect(guide.text).toMatch(/Verify/);
    expect(guide.text).toMatch(/Persist and deduplicate/);
    expect(guide.text).toMatch(/Acknowledge quickly/);
    expect(guide.text).toMatch(/Inspect/);
    const labels = codeLabels(guide.container);
    expect(labels).toContain('cURL');
    expect(labels).toContain('JavaScript (Node)');
    expect(labels).toContain('Python');
  });
});

describe('error handling (phase 15 §5.10)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(ErrorsPage);
  });

  it('documents the envelope fields', () => {
    expect(guide.text).toContain('error.code');
    expect(guide.text).toContain('error.message');
    expect(guide.text).toContain('error.request_id');
    expect(guide.text).toContain('error.details');
    expect(guide.text).toContain('"request_id"');
  });

  it('lists the base codes plus a representative domain code', () => {
    for (const code of [
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'BUSINESS_RULE_VIOLATION',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
    ]) {
      expect(guide.text).toContain(code);
    }
    expect(guide.text).toContain('PAYMENT_ALREADY_REFUNDED');
  });

  it('gives the status table and the retry rule', () => {
    for (const status of ['400', '401', '403', '404', '409', '422', '429', '5xx']) {
      expect(screen.getByRole('row', { name: new RegExp(`^${status}`) })).toBeInTheDocument();
    }
    expect(guide.text).toMatch(/retry only 429 and transient 5xx/i);
    expect(guide.text).toMatch(/Retry-After.*when it is present/i);
    expect(guide.text).toMatch(/Never blindly retry/i);
    expect(codeLabels(guide.container)).toContain('cURL (deliberate 401)');
  });

  it('promises request ids and no internals', () => {
    expect(guide.text).toContain('X-Request-Id');
    expect(guide.text).toMatch(/req_…/);
    expect(guide.text).toMatch(/No stack traces, SQL/i);
    expect(guide.text).toMatch(/No secrets, credentials, tokens/i);
  });
});

describe('rate limits (phase 15 §5.11, Q1: §10.1–10.5 only)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(RateLimitsPage);
  });

  it('publishes the scopes and the absence of a session/org dimension', () => {
    expect(guide.text).toContain('ip');
    expect(guide.text).toContain('api_key');
    expect(guide.text).toContain('account');
    expect(guide.text).toMatch(/no session-user scope/i);
    expect(guide.text).toMatch(/no per-organization scope/i);
  });

  it('publishes the class catalog with the sandbox defaults', () => {
    for (const limitClass of RATE_LIMIT_CLASSES) {
      expect(guide.text).toContain(limitClass.name);
      expect(guide.text).toContain(`${limitClass.limit} / ${limitClass.windowSeconds} s`);
    }
    expect(guide.text).toMatch(/fixed window anchored at the first counted request/i);
  });

  it('publishes what counts, the headers and the 429 semantics', () => {
    expect(guide.text).toMatch(/including requests later rejected/i);
    expect(guide.text).toMatch(/CORS preflight requests, the health endpoints/i);
    for (const header of ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']) {
      expect(guide.text).toContain(header);
    }
    expect(guide.text).toMatch(/It is retryable/i);
    expect(guide.text).toMatch(/budget numbers only/i);
    expect(guide.text).toMatch(/nothing about whether a credential exists/i);
  });

  it('keeps the operator-only sections out of the public guide (Q1)', () => {
    expect(guide.text).not.toMatch(/RATE_LIMIT_FAIL_MODE|TRUST_PROXY|fail[- ]open|Redis/i);
    expect(guide.text).not.toContain('### 10.6');
    expect(guide.text).not.toContain('### 10.7');
    expect(guide.text).not.toContain('### 10.8');
  });
});

describe('logs (phase 15 §5.11: request ids, request logs, audit)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(LogsPage);
  });

  it('documents request-id generation and propagation', () => {
    expect(guide.text).toMatch(/req_…/);
    expect(guide.text).toMatch(/assigned a req_… identifier at ingress/i);
    expect(guide.text).toContain('X-Request-Id');
    expect(guide.text).toContain('error.request_id');
    expect(guide.text).toMatch(/Outbound webhook delivery records/i);
  });

  it('documents request-log content and the 30-day retention', () => {
    expect(guide.text).toContain('30 days');
    expect(guide.text).toMatch(/query strings are never persisted/i);
    expect(guide.text).toMatch(/request headers and request or response bodies are never persisted/i);
    expect(guide.text).toMatch(/session-only: an API key gets 401/i);
    expect(guide.text).toMatch(/cursor pagination/i);
  });

  it('documents the audit trail lifecycle', () => {
    expect(guide.text).toMatch(/Append-only/);
    expect(guide.text).toMatch(/never updated and never deleted/i);
    expect(guide.text).toMatch(/cascade that removes an organization/i);
    expect(guide.text).toMatch(/Organization-wide/);
    expect(guide.text).toMatch(/closed catalogs/i);
    expect(guide.text).toMatch(/Session-only. Reading the trail requires a session/i);
  });
});

describe('sandbox (phase 15 §5.12, D6)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(SandboxPage);
  });

  it('states what the sandbox is and is not', () => {
    expect(guide.text).toMatch(/processes no real money/i);
    expect(guide.text).toMatch(/no card data at all|no real card data/i);
    expect(guide.text).toMatch(/Both environments are simulated/);
    expect(guide.text).toMatch(/model surface is the same/i);
  });

  it('documents only implemented behavior', () => {
    expect(guide.text).toMatch(/pending → processing → succeeded/);
    expect(guide.text).toMatch(/Failure scenarios/);
    expect(guide.text).toMatch(/The outcome is not disclosed in the create response/i);
    expect(guide.text).toMatch(/sandbox\/<action>/);
    expect(guide.text).toMatch(/do not build against them/i);
    // What is still out of scope must stay out of scope.
    expect(guide.text).toMatch(/No test cards or card data/i);
    expect(guide.text).toMatch(/No project-wide default scenario/i);
    expect(guide.text).toMatch(/No refund or dispute scenarios/i);
  });

  it('publishes the scenario and failure-code catalogs (phase 16 §6.2)', () => {
    for (const scenario of ['succeed', 'decline', 'timeout']) {
      expect(guide.text).toContain(scenario);
    }
    for (const code of ['card_declined', 'insufficient_funds', 'processing_timeout']) {
      expect(guide.text).toContain(code);
    }
    expect(guide.text).toMatch(/card_declined \(default\)/);
  });
});

describe('local development (phase 15 §8, D5)', () => {
  let guide: RenderedGuide;
  beforeEach(() => {
    guide = renderGuide(LocalDevelopmentPage);
  });

  it('covers running BrinnPay: prerequisites, stack, ports and migrations', () => {
    expect(guide.text).toMatch(/Node\.js 22/);
    expect(guide.text).toMatch(/corepack enable/);
    expect(guide.text).toMatch(/Docker with Docker Compose/);
    expect(guide.text).toContain('docker compose -f docker/compose.yml up --build');
    for (const port of ['3000', '3001', '5432', '6379']) {
      expect(guide.text).toContain(port);
    }
    expect(guide.text).toContain('pnpm --filter @brinnpay/api prisma:migrate:dev');
    expect(guide.text).toMatch(/never migrates on boot/i);
  });

  it('lists the required checks and the canonical artifacts', () => {
    for (const command of [
      'pnpm lint',
      'pnpm lint:openapi',
      'pnpm typecheck',
      'pnpm test',
      'pnpm test:e2e',
      'pnpm build',
    ]) {
      expect(guide.text).toContain(command);
    }
    expect(guide.text).toContain('docs/openapi.yaml');
    expect(guide.text).toContain('docs/api-conventions.md');
    expect(codeLabels(guide.container)).toContain('Shell setup (local stack)');
  });

  it('covers developing an integration locally, including localhost webhooks', () => {
    expect(guide.text).toContain('http://localhost:3000/api/v1');
    expect(guide.text).toContain('http://localhost:8080/webhooks/brinnpay');
    expect(guide.text).toMatch(/Local destinations are allowed by default/i);
    expect(guide.text).toMatch(/Verify against the raw body/i);
    expect(guide.text).toMatch(/Answer 2xx quickly/i);
  });

  it('publishes non-secret configuration only (Q1, §11.3)', () => {
    expect(guide.text).not.toMatch(/RATE_LIMIT_|TRUST_PROXY|WEBHOOK_DESTINATION_(ALLOW|DENY)LIST/);
    expect(guide.text).toMatch(/never commit or log them/i);
    expect(guide.text).not.toMatch(/(postgres|postgresql|redis):\/\/\S+/i);
  });
});
