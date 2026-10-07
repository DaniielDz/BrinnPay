import type { CodeExample } from '../../components/docs/code-block';

/**
 * Shared code examples (phase 15 §7).
 *
 * Every example is placeholder-only: the API base is an obvious placeholder or
 * the configured origin, keys appear only as `sk_test_…`/`sk_live_…`, signing
 * secrets as `<your-signing-secret>`, and identifiers as `<your_…>`. Nothing
 * here is a working credential (§11.3), and every request shape is taken from
 * `docs/openapi.yaml` — same method, path, headers and `snake_case` body.
 *
 * Examples are shared only where the *same* flow appears in more than one
 * guide (create payment, create refund, verify a signature, retry after a
 * 429), so a fix cannot land in one guide and be missed in another.
 */

/** Placeholder base: the contract declares the relative server `/api/v1`. */
export const API_BASE_PLACEHOLDER = '<your-api-origin>/api/v1';

/** Placeholder identifiers used across the examples. */
export const PROJECT_ID = '<your_project_id>';
export const CUSTOMER_ID = '<your_customer_id>';
export const PAYMENT_ID = '<your_payment_id>';
export const ENDPOINT_ID = '<your_endpoint_id>';
export const EVENT_ID = '<your_event_id>';

/**
 * The shell preamble every cURL example assumes. Setting the base and the key
 * once keeps the individual examples short without hiding a header.
 */
export const SHELL_SETUP: CodeExample = {
  label: 'Shell setup',
  language: 'bash',
  code: [
    '# Placeholder values — replace them with yours.',
    `BRINNPAY="${API_BASE_PLACEHOLDER}"`,
    `PROJECT_ID="${PROJECT_ID}"`,
    'API_KEY="sk_test_..."',
    '',
    '# Session-authenticated calls (dashboard endpoints) use the access token',
    '# instead of the key: ACCESS_TOKEN="<your-access-token>"',
  ].join('\n'),
};

/** The shell preamble for session-authenticated (dashboard) endpoints. */
export const SHELL_SETUP_SESSION: CodeExample = {
  label: 'Shell setup',
  language: 'bash',
  code: [
    '# Placeholder values — replace them with yours.',
    `BRINNPAY="${API_BASE_PLACEHOLDER}"`,
    'PROJECT_ID="<your_project_id>"',
    'ACCESS_TOKEN="<your-access-token>"',
  ].join('\n'),
};

/** Minimal authenticated request (§5.3). */
export const AUTHENTICATED_REQUEST: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS "$BRINNPAY/projects/$PROJECT_ID/payments?environment=test&limit=5" \\',
    '  -H "Authorization: Bearer sk_test_..."',
  ].join('\n'),
};

/** Register an account (quickstart step 1). The refresh cookie is HttpOnly. */
export const REGISTER_ACCOUNT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/auth/register" \\',
    '  -H "Content-Type: application/json" \\',
    '  -c cookies.txt \\',
    `  -d '{"email":"developer@example.com","password":"<your-password>","name":"Ada"}'`,
  ].join('\n'),
};

/** Log in with an existing account. */
export const LOGIN_ACCOUNT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/auth/login" \\',
    '  -H "Content-Type: application/json" \\',
    '  -c cookies.txt \\',
    `  -d '{"email":"developer@example.com","password":"<your-password>"}'`,
  ].join('\n'),
};

/** Refresh the session: the cookie is presented and rotated. */
export const REFRESH_SESSION: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/auth/refresh" \\',
    '  -b cookies.txt -c cookies.txt',
  ].join('\n'),
};

/** Create a project (session only). */
export const CREATE_PROJECT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer $ACCESS_TOKEN" \\',
    `  -d '{"organization_id":"<your_organization_id>","name":"Acme integration"}'`,
  ].join('\n'),
};

/** Create an API key (session only); the plaintext key is returned once. */
export const CREATE_API_KEY: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/api-keys" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer $ACCESS_TOKEN" \\',
    `  -d '{"environment":"test"}'`,
    '',
    '# 201 → { "id": "<your_api_key_id>", "environment": "test",',
    '#         "key": "sk_test_...", "created_at": "2026-01-15T12:00:00.000Z" }',
    '# The "key" value is shown only here — store it now or rotate later.',
  ].join('\n'),
};

/** Create a customer in the TEST environment. */
export const CREATE_CUSTOMER: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/customers" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"environment":"test","email":"customer@example.com","name":"Ada"}'`,
  ].join('\n'),
};

/** Create a payment — cURL (mandatory for every guided flow, §7). */
export const CREATE_PAYMENT_CURL: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/payments" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: <your-idempotency-key>" \\',
    `  -d '{"environment":"test","customer_id":"${CUSTOMER_ID}","amount":"10.00","currency":"usd","description":"Order 1001"}'`,
  ].join('\n'),
};

/** Create a payment — JavaScript `fetch` (D3 language set). */
export const CREATE_PAYMENT_JS: CodeExample = {
  label: 'JavaScript (fetch)',
  language: 'javascript',
  code: [
    `const base = '${API_BASE_PLACEHOLDER}';`,
    '',
    'const response = await fetch(`${base}/projects/<your_project_id>/payments`, {',
    "  method: 'POST',",
    '  headers: {',
    "    Authorization: 'Bearer sk_test_...',",
    "    'Content-Type': 'application/json',",
    "    'Idempotency-Key': '<your-idempotency-key>',",
    '  },',
    '  body: JSON.stringify({',
    "    environment: 'test',",
    "    customer_id: '<your_customer_id>',",
    "    amount: '10.00',",
    "    currency: 'usd',",
    "    description: 'Order 1001',",
    '  }),',
    '});',
    '',
    'if (!response.ok) {',
    '  const { error } = await response.json();',
    '  // Always keep the request id: it is what support needs to trace a call.',
    '  console.error(error.code, error.request_id, error.message);',
    '}',
    '',
    'const payment = await response.json();',
    '// payment.status starts as "pending".',
  ].join('\n'),
};

/** Create a payment — Python `requests` (D3 language set). */
export const CREATE_PAYMENT_PY: CodeExample = {
  label: 'Python (requests)',
  language: 'python',
  code: [
    'import requests',
    '',
    `base = "${API_BASE_PLACEHOLDER}"`,
    '',
    'response = requests.post(',
    '    f"{base}/projects/<your_project_id>/payments",',
    '    headers={',
    '        "Authorization": "Bearer sk_test_...",',
    '        "Content-Type": "application/json",',
    '        "Idempotency-Key": "<your-idempotency-key>",',
    '    },',
    '    json={',
    '        "environment": "test",',
    '        "customer_id": "<your_customer_id>",',
    '        "amount": "10.00",',
    '        "currency": "usd",',
    '        "description": "Order 1001",',
    '    },',
    '    timeout=10,',
    ')',
    '',
    'if not response.ok:',
    '    error = response.json()["error"]',
    '    # Always keep the request id: it is what support needs to trace a call.',
    '    print(error["code"], error["request_id"], error["message"])',
    '',
    'payment = response.json()',
    '# payment["status"] starts as "pending".',
  ].join('\n'),
};

/** Create a payment — with the Idempotency-Key omitted, for contrast (§5.8). */
export const CREATE_PAYMENT_NO_KEY: CodeExample = {
  label: 'cURL without an Idempotency-Key',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/payments" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"environment":"test","customer_id":"${CUSTOMER_ID}","amount":"10.00","currency":"usd"}'`,
    '',
    '# Two retries without a key can create two payments. Send one.',
  ].join('\n'),
};

/**
 * Create a payment with an explicit decline scenario (phase 16 §4.2, §4.5).
 * `failure_code` is valid only with `scenario: "decline"`; omit it and the
 * catalog default `card_declined` is used.
 */
export const CREATE_PAYMENT_DECLINE_CURL: CodeExample = {
  label: 'cURL — decline',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/payments" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: <your-idempotency-key>" \\',
    `  -d '{"environment":"test","customer_id":"${CUSTOMER_ID}","amount":"10.00","currency":"usd","scenario":"decline","failure_code":"insufficient_funds"}'`,
    '',
    '# 201 "pending" — the outcome is not disclosed here. Poll the payment:',
    '# it settles "failed" with "failure_code":"insufficient_funds".',
    '# Omit "failure_code" to get the default "card_declined".',
  ].join('\n'),
};

/** Create a payment with an explicit timeout scenario (phase 16 §4.2). */
export const CREATE_PAYMENT_TIMEOUT_CURL: CodeExample = {
  label: 'cURL — timeout',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/payments" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: <your-idempotency-key>" \\',
    `  -d '{"environment":"test","customer_id":"${CUSTOMER_ID}","amount":"10.00","currency":"usd","scenario":"timeout"}'`,
    '',
    '# 201 "pending". The payment moves pending → processing and never settles:',
    '# "payment.succeeded"/"payment.failed" are never emitted and a refund is 422.',
  ].join('\n'),
};

/** Poll a payment until the simulation has advanced it. */
export const RETRIEVE_PAYMENT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS "$BRINNPAY/projects/$PROJECT_ID/payments/<your_payment_id>" \\',
    '  -H "Authorization: Bearer sk_test_..."',
    '',
    '# Re-run until the payment settles:',
    '#   default/succeed → pending → processing → succeeded',
    '#   decline         → pending → processing → failed (with "failure_code")',
    '#   timeout         → pending → processing → stays "processing"',
  ].join('\n'),
};

/** List payments with cursor pagination. */
export const LIST_PAYMENTS: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS "$BRINNPAY/projects/$PROJECT_ID/payments?environment=test&limit=10" \\',
    '  -H "Authorization: Bearer sk_test_..."',
    '',
    '# Next page: append &cursor=<next_cursor from the previous response>',
  ].join('\n'),
};

/** Create a partial refund — cURL. */
export const CREATE_REFUND_CURL: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    `PAYMENT_ID="<your_payment_id>"`,
    '',
    'curl -sS -X POST "$BRINNPAY/payments/$PAYMENT_ID/refunds" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: <your-idempotency-key>" \\',
    `  -d '{"amount":"4.00","currency":"usd","reason":"partial refund"}'`,
  ].join('\n'),
};

/** Create a refund of the whole remaining balance — omit `amount`. */
export const CREATE_REFUND_FULL: CodeExample = {
  label: 'cURL (full remaining balance)',
  language: 'bash',
  code: [
    `PAYMENT_ID="<your_payment_id>"`,
    '',
    'curl -sS -X POST "$BRINNPAY/payments/$PAYMENT_ID/refunds" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: <your-idempotency-key>" \\',
    `  -d '{"reason":"customer request"}'`,
    '',
    '# No "amount": the whole remaining balance is refunded, including',
    '# whatever is left after earlier partial refunds.',
  ].join('\n'),
};

/** Create a refund — JavaScript `fetch` (D3 language set). */
export const CREATE_REFUND_JS: CodeExample = {
  label: 'JavaScript (fetch)',
  language: 'javascript',
  code: [
    `const base = '${API_BASE_PLACEHOLDER}';`,
    '',
    'const response = await fetch(`${base}/payments/<your_payment_id>/refunds`, {',
    "  method: 'POST',",
    '  headers: {',
    "    Authorization: 'Bearer sk_test_...',",
    "    'Content-Type': 'application/json',",
    "    'Idempotency-Key': '<your-idempotency-key>',",
    '  },',
    '  body: JSON.stringify({',
    "    amount: '4.00',",
    "    currency: 'usd',",
    "    reason: 'partial refund',",
    '  }),',
    '});',
    '',
    'if (!response.ok) {',
    '  const { error } = await response.json();',
    '  console.error(error.code, error.request_id);',
    '}',
    '',
    'const refund = await response.json();',
    '// Refunds complete synchronously: refund.status === "succeeded".',
  ].join('\n'),
};

/** Create a refund — Python `requests` (D3 language set). */
export const CREATE_REFUND_PY: CodeExample = {
  label: 'Python (requests)',
  language: 'python',
  code: [
    'import requests',
    '',
    `base = "${API_BASE_PLACEHOLDER}"`,
    '',
    'response = requests.post(',
    '    f"{base}/payments/<your_payment_id>/refunds",',
    '    headers={',
    '        "Authorization": "Bearer sk_test_...",',
    '        "Content-Type": "application/json",',
    '        "Idempotency-Key": "<your-idempotency-key>",',
    '    },',
    '    json={',
    '        "amount": "4.00",',
    '        "currency": "usd",',
    '        "reason": "partial refund",',
    '    },',
    '    timeout=10,',
    ')',
    '',
    'if not response.ok:',
    '    error = response.json()["error"]',
    '    print(error["code"], error["request_id"])',
    '',
    'refund = response.json()',
    '# Refunds complete synchronously: refund["status"] == "succeeded".',
  ].join('\n'),
};

/**
 * Shell setup for a local checkout (§8): the API origin of the local stack
 * plus the versioned prefix. Localhost is the one host name published in the
 * guides — it is where this documentation's own stack runs (§8), never a
 * deployed environment hostname.
 */
export const LOCAL_SHELL_SETUP: CodeExample = {
  label: 'Shell setup (local stack)',
  language: 'bash',
  code: [
    '# The local Docker stack (see the local development guide).',
    'BRINNPAY="http://localhost:3000/api/v1"',
    'PROJECT_ID="<your_project_id>"',
    'API_KEY="sk_test_..."',
  ].join('\n'),
};

/** Register a webhook endpoint whose receiver runs on the developer's machine. */
export const REGISTER_WEBHOOK_LOCALHOST: CodeExample = {
  label: 'cURL (localhost receiver)',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/webhook-endpoints" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"environment":"test","url":"http://localhost:8080/webhooks/brinnpay","event_types":["payment.succeeded"]}'`,
    '',
    '# Localhost and private hosts are allowed by default: no allowlist to set.',
    '# Copy "signing_secret" from this response — it is shown only once.',
  ].join('\n'),
};

/** Register a webhook endpoint. */
export const REGISTER_WEBHOOK_ENDPOINT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/webhook-endpoints" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"environment":"test","url":"https://example.com/webhooks/brinnpay","event_types":["payment.succeeded","refund.created"]}'`,
    '',
    '# 201 → the response includes "signing_secret" once. Copy it now:',
    '# it cannot be read back or rotated — delete and recreate instead.',
  ].join('\n'),
};

/**
 * Register an endpoint whose URL carries the sandbox marker (phase 16 §5.1):
 * the exact consecutive path segments `sandbox/fail`.
 */
export const REGISTER_WEBHOOK_MARKER_CURL: CodeExample = {
  label: 'cURL — sandbox marker',
  language: 'bash',
  code: [
    'curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/webhook-endpoints" \\',
    '  -H "Authorization: Bearer sk_test_..." \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"environment":"test","url":"https://example.com/webhooks/sandbox/fail","event_types":["payment.succeeded","payment.failed"]}'`,
    '',
    '# "sandbox/fail" is the marker: deliveries to this URL answer 500 so the',
    '# five-attempt retry ladder can be exercised end to end. "sandbox/timeout"',
    '# and "sandbox/reject" classify differently — see the webhooks guide.',
    '# /sandbox/webhooks (no trailing action) and /failure-handler are ordinary',
    '# destinations: the match is on whole path segments.',
  ].join('\n'),
};

/** Inspect the deliveries of an endpoint. */
export const LIST_DELIVERIES: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    'curl -sS "$BRINNPAY/projects/$PROJECT_ID/webhook-endpoints/<your_endpoint_id>/deliveries?limit=10" \\',
    '  -H "Authorization: Bearer sk_test_..."',
    '',
    '# "attempts" counts tries so far; "response_status" is the last outcome.',
  ].join('\n'),
};

/** Replay an event to an endpoint (202, no request body). */
export const REPLAY_EVENT: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    `curl -sS -X POST "$BRINNPAY/projects/$PROJECT_ID/webhook-endpoints/<your_endpoint_id>/events/<your_event_id>/replay" \\`,
    '  -H "Authorization: Bearer sk_test_..."',
    '',
    '# 202 → replay queued. Expired events (older than 30 days) are 404.',
  ].join('\n'),
};

/**
 * Verify a BrinnPay signature — JavaScript (D3 language set, §5.9 scheme:
 * raw body, `t` + `v1`, HMAC-SHA256 over `${t}.${rawBody}`).
 */
export const VERIFY_SIGNATURE_JS: CodeExample = {
  label: 'JavaScript (Node)',
  language: 'javascript',
  code: [
    "import crypto from 'node:crypto';",
    '',
    '/**',
    ' * @param {Buffer} rawBody      exact bytes received, before any parsing',
    ' * @param {string} header       the BrinnPay-Signature header value',
    ' * @param {string} secret       your endpoint signing secret',
    ' * @returns {boolean}',
    ' */',
    'function verifySignature(rawBody, header, secret, toleranceSeconds = 300) {',
    '  const parts = Object.fromEntries(',
    "    header.split(',').map((piece) => piece.split('=').map((value) => value.trim())),",
    '  );',
    '',
    '  const timestamp = Number(parts.t);',
    '  const presented = parts.v1;',
    '  if (!Number.isFinite(timestamp) || typeof presented !== "string") return false;',
    '  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;',
    '',
    '  const expected = crypto',
    "    .createHmac('sha256', secret)",
    '    .update(`${timestamp}.${rawBody}`)',
    "    .digest('hex');",
    '',
    '  return (',
    '    presented.length === expected.length &&',
    '    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented))',
    '  );',
    '}',
  ].join('\n'),
};

/** Verify a BrinnPay signature — Python (D3 language set). */
export const VERIFY_SIGNATURE_PY: CodeExample = {
  label: 'Python',
  language: 'python',
  code: [
    'import hashlib',
    'import hmac',
    'import time',
    '',
    'def verify_signature(raw_body: bytes, header: str, secret: str,',
    '                     tolerance_seconds: int = 300) -> bool:',
    '    """Verify the BrinnPay-Signature header against the raw body."""',
    '    parts = dict(piece.split("=", 1) for piece in header.split(","))',
    '    try:',
    '        timestamp = int(parts["t"])',
    '        presented = parts["v1"]',
    '    except (KeyError, ValueError):',
    '        return False',
    '    if abs(int(time.time()) - timestamp) > tolerance_seconds:',
    '        return False',
    '',
    '    signed_message = f"{timestamp}.".encode() + raw_body',
    '    expected = hmac.new(secret.encode(), signed_message,',
    '                        hashlib.sha256).hexdigest()',
    '    return hmac.compare_digest(expected, presented)',
  ].join('\n'),
};

/**
 * Fixed inputs for a known signature vector (§13.1): the test signs
 * `${t}.${rawBody}` with `secret` using HMAC-SHA256 and asserts the documented
 * `t=…,v1=<lowercase-hex>` result, so the scheme shown in the guides is the
 * scheme that verifies. Not a credential — a constant, non-secret test input.
 */
export const SIGNATURE_VECTOR = {
  secret: 'example-signing-secret',
  timestamp: 1_700_000_000,
  rawBody: '{"id":"<your_event_id>","type":"payment.succeeded"}',
} as const;

/** Retry a request after a 429 — cURL. */
export const RETRY_AFTER_429_CURL: CodeExample = {
  label: 'cURL',
  language: 'bash',
  code: [
    '# 1. Make the request and read the rate-limit headers.',
    'curl -sS -i "$BRINNPAY/projects/$PROJECT_ID/payments?environment=test" \\',
    '  -H "Authorization: Bearer sk_test_..."',
    '',
    '# HTTP/1.1 429 Too Many Requests',
    '# RateLimit-Limit: 600',
    '# RateLimit-Remaining: 0',
    '# RateLimit-Reset: 30',
    '# Retry-After: 30',
    '',
    '# 2. Wait for the window to reset, then repeat the same request.',
    'sleep 30',
  ].join('\n'),
};

/** Retry a request after a 429 — JavaScript. */
export const RETRY_AFTER_429_JS: CodeExample = {
  label: 'JavaScript (fetch)',
  language: 'javascript',
  code: [
    'async function requestWithBackoff(url, init, attemptsLeft = 3) {',
    '  const response = await fetch(url, init);',
    '  if (response.status !== 429 || attemptsLeft === 0) return response;',
    '',
    '  const waitSeconds = Number(response.headers.get("Retry-After") || "1");',
    '  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));',
    '  return requestWithBackoff(url, init, attemptsLeft - 1);',
    '}',
    '',
    '// A 429 never changed anything: nothing ran, nothing was written.',
  ].join('\n'),
};

/** Retry a request after a 429 — Python. */
export const RETRY_AFTER_429_PY: CodeExample = {
  label: 'Python (requests)',
  language: 'python',
  code: [
    'import time',
    '',
    'import requests',
    '',
    '',
    'def request_with_backoff(url, headers, attempts_left=3):',
    '    response = requests.get(url, headers=headers, timeout=10)',
    '    if response.status_code != 429 or attempts_left == 0:',
    '        return response',
    '    wait_seconds = int(response.headers.get("Retry-After", "1"))',
    '    time.sleep(wait_seconds)',
    '    return request_with_backoff(url, headers, attempts_left - 1)',
    '',
    '# A 429 never changed anything: nothing ran, nothing was written.',
  ].join('\n'),
};

/** Trigger an error on purpose: no credential on a protected route. */
export const ERROR_DEMO_CURL: CodeExample = {
  label: 'cURL (deliberate 401)',
  language: 'bash',
  code: [
    '# A protected route without a credential:',
    'curl -sS -i "$BRINNPAY/projects/$PROJECT_ID/payments?environment=test"',
    '',
    '# HTTP/1.1 401 Unauthorized',
    '# X-Request-Id: req_0192f2a0000070008000000000000004',
    '# { "error": { "code": "UNAUTHENTICATED", "message": "Authentication required",',
    '#               "request_id": "req_0192f2a0000070008000000000000004" } }',
  ].join('\n'),
};

/** The canonical error envelope, as documented in the contract. */
export const ERROR_ENVELOPE_EXAMPLE: CodeExample = {
  label: 'Error response (JSON)',
  language: 'json',
  code: [
    '{',
    '  "error": {',
    '    "code": "UNAUTHENTICATED",',
    '    "message": "Authentication required",',
    '    "request_id": "req_0192f2a0000070008000000000000001"',
    '  }',
    '}',
  ].join('\n'),
};

/** The 429 envelope: budget numbers only. */
export const RATE_LIMIT_ENVELOPE_EXAMPLE: CodeExample = {
  label: '429 response (JSON)',
  language: 'json',
  code: [
    '{',
    '  "error": {',
    '    "code": "RATE_LIMITED",',
    '    "message": "Too many requests",',
    '    "request_id": "req_0192f2a0000070008000000000000002",',
    '    "details": { "limit": 600, "remaining": 0, "window_seconds": 60 }',
    '  }',
    '}',
  ].join('\n'),
};

/** A created payment, as returned by `payments.create`. */
export const PAYMENT_RESPONSE_EXAMPLE: CodeExample = {
  label: '201 response (JSON)',
  language: 'json',
  code: [
    '{',
    '  "id": "<your_payment_id>",',
    '  "project_id": "<your_project_id>",',
    '  "environment": "test",',
    '  "customer_id": "<your_customer_id>",',
    '  "amount": "10.00",',
    '  "currency": "usd",',
    '  "status": "pending",',
    '  "failure_code": null,',
    '  "description": "Order 1001",',
    '  "created_at": "2026-01-15T12:00:00.000Z",',
    '  "updated_at": "2026-01-15T12:00:00.000Z"',
    '}',
  ].join('\n'),
};

/** A validation error envelope (400), for the error-handling guide. */
export const VALIDATION_ERROR_EXAMPLE: CodeExample = {
  label: '400 response (JSON)',
  language: 'json',
  code: [
    '{',
    '  "error": {',
    '    "code": "VALIDATION_ERROR",',
    '    "message": "Request validation failed",',
    '    "request_id": "req_0192f2a0000070008000000000000003",',
    '    "details": { "amount": "must be a positive decimal string" }',
    '  }',
    '}',
  ].join('\n'),
};
