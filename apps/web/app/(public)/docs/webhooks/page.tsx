import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  LIST_DELIVERIES,
  REGISTER_WEBHOOK_ENDPOINT,
  REPLAY_EVENT,
  VERIFY_SIGNATURE_JS,
  VERIFY_SIGNATURE_PY,
} from '../../../../lib/docs/examples';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_RETRY_SCHEDULE_SECONDS } from '../../../../lib/docs/facts';

export const metadata: Metadata = {
  title: 'Webhooks — BrinnPay',
  description:
    'Register webhook endpoints, verify HMAC-SHA256 signatures against the raw body, understand at-least-once delivery, retries, replay and 30-day event retention.',
};

/** Resource path and the documented signed message, exactly as contracted. */
const ENDPOINTS_PATH = '/projects/{project_id}/webhook-endpoints';
const SIGNED_MESSAGE = '${t}.${rawBody}';

/** Human label for a backoff delay in seconds. */
function formatRetryDelay(seconds: number): string {
  if (seconds === 0) return '0 s';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  return `${seconds / 3600} h`;
}

const DELIVERY_HEADERS: { header: string; purpose: string }[] = [
  { header: 'BrinnPay-Signature', purpose: 't=<unix-seconds>,v1=<lowercase-hex> — verify this.' },
  { header: 'BrinnPay-Event-Id', purpose: 'The event id; equals the envelope id. Deduplicate on it.' },
  { header: 'BrinnPay-Event-Type', purpose: 'The catalog type of this event.' },
  { header: 'BrinnPay-Delivery-Id', purpose: 'This delivery; stable across retries of one delivery.' },
  { header: 'BrinnPay-Attempt', purpose: 'Attempt number, starting at 1.' },
  { header: 'User-Agent', purpose: 'BrinnPay-Webhooks/1.0' },
];

const RETRYABLE = 'Network errors and timeouts, plus 408, 425, 429 and every 5xx.';
const TERMINAL = 'Any other 4xx and every 3xx — never retried.';

/**
 * Webhooks guide (phase 15 §5.9): registration, the one-time signing secret,
 * the signature scheme, at-least-once unordered delivery, the five-attempt
 * retry ladder, replay, retention and the developer-facing destination rules.
 */
export default function WebhooksPage() {
  return (
    <Guide
      title="Webhooks"
      lead="BrinnPay pushes events to your endpoint as they happen: signed, retried with backoff, deduplicable, and replayable when you need one again."
      sources={['docs/openapi.yaml', 'docs/api-conventions.md']}
    >
      <section aria-labelledby="webhooks-register">
        <h2 id="webhooks-register">Register an endpoint</h2>
        <p>
          <code>{ENDPOINTS_PATH}</code> takes a destination
          URL and a non-empty subset of the closed event catalog:
        </p>
        <ul>
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <li key={type}>
              <code>{type}</code>
            </li>
          ))}
        </ul>
        <p>
          An unknown type is a <code>400 VALIDATION_ERROR</code> — a stored type that nothing
          ever emits would create an endpoint that can never fire. Duplicate URLs are allowed:
          there is no uniqueness constraint, so two endpoints may share a destination.
        </p>
        <CodeExampleList examples={[REGISTER_WEBHOOK_ENDPOINT]} />
        <p>
          Environment scoping and authentication follow the resource rules: with an API key the
          body&rsquo;s <code>environment</code> must match the key (<code>422</code>{' '}
          otherwise), and with a session it must be stated. Registering is administrative —{' '}
          owner or admin — while reading endpoints, deliveries and events is open to every role.
          Endpoint creation is also budgeted at <strong>10 requests per hour</strong> per
          project (<code>webhook.endpoint-create</code>).
        </p>
        <p>
          <Link href="/docs/rate-limits">Rate limits →</Link>
        </p>
      </section>

      <section aria-labelledby="webhooks-secret">
        <h2 id="webhooks-secret">The signing secret</h2>
        <Callout title="Returned once, at creation" tone="important">
          <p>
            The <code>signing_secret</code> appears only in the creation response. It is stored
            encrypted and is <strong>not recoverable</strong>: there is no reveal or rotation
            operation. Copy it when you create the endpoint — if you lose it, delete the
            endpoint and create a new one to obtain a fresh secret.
          </p>
        </Callout>
        <p className="hint">
          Never log the secret, never put it in a client, and never send it anywhere except
          through your server&rsquo;s configuration.
        </p>
      </section>

      <section aria-labelledby="webhooks-verify">
        <h2 id="webhooks-verify">Verify the signature</h2>
        <p>Every delivery is an HTTP <code>POST</code> of the stored envelope, with:</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Header</th>
                <th scope="col">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {DELIVERY_HEADERS.map((row) => (
                <tr key={row.header}>
                  <th scope="row">
                    <code>{row.header}</code>
                  </th>
                  <td>{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The signature value is <code>t=&lt;unix-seconds&gt;,v1=&lt;lowercase-hex&gt;</code>{' '}
          and the signed message is <code>{SIGNED_MESSAGE}</code> — the timestamp,
          a dot, and the exact bytes you received — signed with HMAC-SHA256 using your endpoint
          secret. The <code>t</code> is generated per attempt, so two attempts of the same event
          carry different signatures.
        </p>
        <Callout title="Sign the raw body" tone="important">
          <p>
            Verify against the <strong>raw request body bytes</strong>, not against a
            re-serialization of parsed JSON. If your framework parses the body first, capture
            the raw stream before parsing — a re-serialized object will not match, and a
            matching re-serialization would also be wrong to trust. Reject a <code>t</code> too
            far from the current time.
          </p>
        </Callout>
        <p>
          The examples below read the secret from your server&rsquo;s configuration — in its
          placeholder form, <code>{'SECRET="<your-signing-secret>"'}</code>.
        </p>
        <CodeExampleList examples={[VERIFY_SIGNATURE_JS, VERIFY_SIGNATURE_PY]} />
        <p className="hint">
          Compare in constant time, and treat a failed verification as an untrusted request:
          respond with a non-2xx and do not process the payload.
        </p>
      </section>

      <section aria-labelledby="webhooks-semantics">
        <h2 id="webhooks-semantics">Delivery semantics</h2>
        <ul>
          <li>
            <strong>At-least-once.</strong> A destination that processes a delivery and then
            fails to answer 2xx will see the same envelope again.
          </li>
          <li>
            <strong>Unordered.</strong> Do not assume <code>payment.created</code> arrives
            before <code>payment.succeeded</code>.
          </li>
          <li>
            <strong>Deduplicate on the envelope id.</strong> The event <code>id</code> equals
            the <code>BrinnPay-Event-Id</code> header and is stable across retries — persist it
            and ignore repeats.
          </li>
        </ul>
        <p>
          The <code>BrinnPay-Delivery-Id</code> identifies the delivery rather than the event;
          replays create a <em>new</em> delivery of the <em>same</em> event, so the event id is
          the one to deduplicate on.
        </p>
      </section>

      <section aria-labelledby="webhooks-retries">
        <h2 id="webhooks-retries">Retries</h2>
        <p>
          A retryable failure is retried up to <strong>5 attempts total</strong> with
          exponential backoff and full jitter — approximately{' '}
          {WEBHOOK_RETRY_SCHEDULE_SECONDS.map((seconds, index) => (
            <span key={seconds}>
              <code>{formatRetryDelay(seconds)}</code>
              {index < WEBHOOK_RETRY_SCHEDULE_SECONDS.length - 1 ? ', ' : ''}
            </span>
          ))}
          , capped. The jitter means the real delays vary around those bounds.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Treated as</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>2xx</td>
                <td>
                  <code>delivered</code> — no further attempts.
                </td>
              </tr>
              <tr>
                <td>{RETRYABLE}</td>
                <td>Retried within the 5-attempt budget, then <code>failed</code>.</td>
              </tr>
              <tr>
                <td>{TERMINAL}</td>
                <td>
                  <code>failed</code> immediately — never retried.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A parseable <code>Retry-After</code> from your endpoint is honored (seconds or an
          HTTP date) and clamped to the same cap; anything unparseable is ignored.{' '}
          <strong>Redirects are never followed</strong> and response bodies are never read, so a
          destination behind a redirect must expose its direct URL — a 3xx is terminal.
        </p>
        <p className="hint">
          <code>last_error</code> on a delivery is a bounded, sanitized summary: never a
          destination response body, never credentials.
        </p>
      </section>

      <section aria-labelledby="webhooks-replay">
        <h2 id="webhooks-replay">Replay</h2>
        <p>
          Replay re-delivers a retained event to an endpoint as a new delivery with the
          original envelope, unchanged:
        </p>
        <CodeExampleList examples={[REPLAY_EVENT]} />
        <p>
          Replay is deliberately repeatable — replaying twice creates two deliveries — and is
          budgeted at <strong>20 requests per 5 minutes</strong> (<code>webhook.replay</code>).
          It requires an owner/admin session or an API key of the endpoint&rsquo;s project and
          environment. An endpoint that is disabled, or not subscribed to the event&rsquo;s
          type, is a <code>422</code>; a foreign, cross-environment or expired event is a{' '}
          <code>404</code> that reveals nothing.
        </p>
        <p className="hint">
          The dashboard has the same operation: open a project&rsquo;s <strong>Webhooks</strong>{' '}
          page, select an endpoint, and use <strong>Replay</strong> on a delivery or an event.
        </p>
      </section>

      <section aria-labelledby="webhooks-inspect">
        <h2 id="webhooks-inspect">Inspect deliveries</h2>
        <CodeExampleList examples={[LIST_DELIVERIES]} />
        <p>
          One row is one <em>(event, endpoint)</em> pair — not one row per attempt — carrying
          the attempt counter, the last response status, the next scheduled attempt, and whether
          it is a replay. Filter by <code>status</code> (<code>pending</code>,{' '}
          <code>delivered</code>, <code>failed</code>) to find what still needs attention.
        </p>
      </section>

      <section aria-labelledby="webhooks-retention">
        <h2 id="webhooks-retention">Retention</h2>
        <p>
          Events are retained for <strong>30 days</strong>. After that they disappear from
          listings and can no longer be replayed (a replay attempt answers <code>404</code>).
          Deliveries live with their endpoint: deleting an endpoint removes its deliveries, and
          the events themselves are unaffected.
        </p>
        <p>
          <Link href="/docs/logs">Where deliveries and requests are logged →</Link>
        </p>
      </section>

      <section aria-labelledby="webhooks-destination">
        <h2 id="webhooks-destination">Destination rules</h2>
        <ul>
          <li>
            Absolute <code>http</code> or <code>https</code> URL, with a host, at most 2048
            characters.
          </li>
          <li>No embedded credentials and no fragment.</li>
          <li>
            <strong>Localhost and private hosts are allowed by default</strong>, so a local
            receiver works out of the box while you develop.
          </li>
          <li>
            Redirects are never followed — the destination must answer directly.
          </li>
          <li>
            A deployment may restrict destination hosts. A denied host fails{' '}
            <em>terminally</em>, without any outbound request being made.
          </li>
        </ul>
        <p className="hint">
          This page covers the destination rules you need as a developer. Which hosts a given
          deployment allows is an operator decision, not part of the API contract.
        </p>
      </section>

      <section aria-labelledby="webhooks-consumer">
        <h2 id="webhooks-consumer">How to write your receiver</h2>
        <ol>
          <li>
            <strong>Verify</strong> the signature against the raw body, including the timestamp
            tolerance.
          </li>
          <li>
            <strong>Persist and deduplicate</strong> on the event id before doing anything
            else.
          </li>
          <li>
            <strong>Acknowledge quickly</strong> with a 2xx and process asynchronously — the
            retry budget starts immediately.
          </li>
          <li>
            <strong>Inspect</strong> anything that fails in the dashboard deliveries list, then
            replay it once the destination is healthy.
          </li>
        </ol>
        <p>
          <Link href="/docs/quickstart">The quickstart walks through this end to end →</Link>
        </p>
      </section>
    </Guide>
  );
}
