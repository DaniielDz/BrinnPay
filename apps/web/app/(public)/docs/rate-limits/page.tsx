import type { Metadata } from 'next';
import Link from 'next/link';

import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  RATE_LIMIT_ENVELOPE_EXAMPLE,
  RETRY_AFTER_429_CURL,
  RETRY_AFTER_429_JS,
  RETRY_AFTER_429_PY,
} from '../../../../lib/docs/examples';
import { RATE_LIMIT_CLASSES, RATE_LIMIT_HEADERS, RATE_LIMIT_SCOPES } from '../../../../lib/docs/facts';

export const metadata: Metadata = {
  title: 'Rate limits — BrinnPay',
  description:
    'BrinnPay rate limits: the budget scopes, the operation-class catalog with sandbox defaults, response headers, and how to handle a 429.',
};

/** Rate limit guide (phase 15 §5.11, Q1: the developer-facing sections only). */
export default function RateLimitsPage() {
  return (
    <Guide
      title="Rate limits"
      lead="Every request under /api/v1 is rate limited. The limits bound credential guessing, scraping and amplification — they are an abuse control, not a quota product."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="rate-limits-scopes">
        <h2 id="rate-limits-scopes">Budget scopes</h2>
        <p>A request spends one unit of every budget that applies to it:</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Keyed by</th>
                <th scope="col">Applies to</th>
              </tr>
            </thead>
            <tbody>
              {RATE_LIMIT_SCOPES.map((row) => (
                <tr key={row.scope}>
                  <th scope="row">
                    <code>{row.scope}</code>
                  </th>
                  <td>{row.discriminator}</td>
                  <td>{row.appliesTo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul>
          <li>
            There is <strong>no session-user scope</strong> and <strong>no per-organization
            scope</strong>.
          </li>
          <li>
            An API-key request spends <em>both</em> its <code>ip</code> and its{' '}
            <code>api_key</code> budget; a session request spends only <code>ip</code>.
          </li>
          <li>
            Budgets are isolated per key: exhausting one key never throttles another key,
            another project, or session traffic from the same address.
          </li>
          <li>
            The <code>ip</code> budget is shared across everyone behind one address (a corporate
            network, for instance) — inherent to keying on an address rather than an identity,
            and why <code>ip</code> limits are deliberately generous.
          </li>
        </ul>
        <p>
          <Link href="/docs/api-keys">API keys and budgets →</Link>
        </p>
      </section>

      <section aria-labelledby="rate-limits-classes">
        <h2 id="rate-limits-classes">Operation classes</h2>
        <p>
          Every operation belongs to exactly one class of this closed catalog — the catalog{' '}
          <em>is</em> the endpoint-specific policy, not a per-endpoint table. The numbers below
          are the sandbox defaults:
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Class</th>
                <th scope="col">Operations</th>
                <th scope="col">Limit / window</th>
                <th scope="col">Scopes</th>
              </tr>
            </thead>
            <tbody>
              {RATE_LIMIT_CLASSES.map((row) => (
                <tr key={row.name}>
                  <th scope="row">
                    <code>{row.name}</code>
                  </th>
                  <td>
                    <code>{row.operations}</code>
                  </td>
                  <td>
                    <code>
                      {row.limit} / {row.windowSeconds} s
                    </code>
                  </td>
                  <td>
                    {row.scopes.map((scope, index) => (
                      <span key={scope}>
                        <code>{scope}</code>
                        {index < row.scopes.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Each class uses one <strong>fixed</strong> window anchored at the first counted request
          of that window — not at a calendar boundary. Limits are generous on purpose: a sandbox
          you cannot hammer while debugging is not usable.
        </p>
      </section>

      <section aria-labelledby="rate-limits-counting">
        <h2 id="rate-limits-counting">What counts</h2>
        <ul>
          <li>
            <strong>Everything that reaches the limiter</strong> — including requests later
            rejected with <code>400</code>, <code>401</code>, <code>403</code>,{' '}
            <code>404</code>, <code>409</code>, <code>422</code> or <code>5xx</code>, and
            including idempotent replays.
          </li>
          <li>
            <strong>Excluded:</strong> CORS preflight requests, the health endpoints, API
            documentation traffic, and anything outside <code>/api/v1</code>.
          </li>
          <li>
            A request to a path that matches no route returns <code>404</code> without spending
            budget — no route means no operation class to charge.
          </li>
        </ul>
        <p className="hint">
          The <code>ip</code> check runs before authentication, so an unauthenticated flood is
          bounded without a lookup; the <code>api_key</code> check runs after the key has been
          resolved.
        </p>
      </section>

      <section aria-labelledby="rate-limits-headers">
        <h2 id="rate-limits-headers">Response headers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Header</th>
                <th scope="col">On</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {RATE_LIMIT_HEADERS.map((row) => (
                <tr key={row.header}>
                  <th scope="row">
                    <code>{row.header}</code>
                  </th>
                  <td>{row.on}</td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul>
          <li>
            When more than one scope applies, the reported budget is the one{' '}
            <strong>closest to exhaustion</strong> — you are never told there is headroom on a
            request that is about to be rejected.
          </li>
          <li>
            <code>RateLimit-Reset</code> and <code>Retry-After</code> come from the same atomic
            read as <code>RateLimit-Remaining</code>: never estimated, never zero or negative.
          </li>
          <li>
            These four headers are CORS-exposed, so a browser client can read its own remaining
            budget directly. Nothing else is exposed, and no header discloses a scope, a class
            name or an identity.
          </li>
        </ul>
      </section>

      <section aria-labelledby="rate-limits-429">
        <h2 id="rate-limits-429">Handling a 429</h2>
        <CodeExampleList examples={[RETRY_AFTER_429_CURL]} />
        <p>A <code>429 RATE_LIMITED</code> response:</p>
        <CodeExampleList examples={[RATE_LIMIT_ENVELOPE_EXAMPLE]} />
        <ul>
          <li>
            <strong>It is retryable.</strong> The handler did not run and no state changed —
            <code>Retry-After</code> says when to come back.
          </li>
          <li>
            <code>error.details</code> carries budget numbers only: <code>limit</code>,{' '}
            <code>remaining</code>, <code>window_seconds</code>. Never an identity, a scope or an
            internal name.
          </li>
          <li>
            It reveals <strong>nothing about whether a credential exists</strong>: the{' '}
            <code>ip</code> stage answers before authentication, and an unknown key is rejected
            with <code>401</code> before its key budget is ever consulted.
          </li>
          <li>
            A throttled request is still request-logged, and it writes no audit entry.
          </li>
        </ul>
        <p>Retry with backoff rather than immediately:</p>
        <CodeExampleList examples={[RETRY_AFTER_429_JS, RETRY_AFTER_429_PY]} />
        <p>
          <Link href="/docs/errors">Error handling →</Link> ·{' '}
          <Link href="/docs/idempotency">Retrying writes safely →</Link>
        </p>
      </section>
    </Guide>
  );
}
