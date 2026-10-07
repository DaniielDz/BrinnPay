import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import {
  CREATE_PAYMENT_CURL,
  CREATE_PAYMENT_NO_KEY,
} from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Idempotency — BrinnPay',
  description:
    'Safe retries with the Idempotency-Key header: the 24-hour window, operation scopes, stored responses, concurrency and retry guidance.',
};

const IDEMPOTENCY_SCOPE_ROWS: { question: string; answer: string }[] = [
  {
    question: 'Same project, same operation, same key',
    answer: 'Replay: the original stored response is returned, nothing re-executes.',
  },
  {
    question: 'Same project, different operation, same key',
    answer:
      'Independent operations. A payments.create key and a refunds.create key never collide.',
  },
  {
    question: 'Same key after 24 hours',
    answer: 'A new operation — the earlier record has been cleaned up.',
  },
];

/**
 * Idempotency guide (phase 15 §5.8): the header, the (project,
 * operation_scope, key) tuple, the 24-hour retention window, what is stored,
 * concurrency, and how a client should retry.
 */
export default function IdempotencyPage() {
  return (
    <Guide
      title="Idempotency"
      lead="Networks fail after a request is sent but before the answer arrives. The Idempotency-Key header is how you retry a critical write without creating it twice."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="idempotency-header">
        <h2 id="idempotency-header">The header</h2>
        <ul>
          <li>
            Header name: <code>Idempotency-Key</code>.
          </li>
          <li>
            Accepted on <code>payments.create</code> and <code>refunds.create</code> — the two
            operation scopes that exist today.
          </li>
          <li>
            Value: <strong>1–255 characters</strong>, trimmed before validation. An empty or
            over-long value is a <code>400</code>.
          </li>
          <li>
            Optional: a request without the header behaves normally — it just has no replay
            protection.
          </li>
        </ul>
        <Callout title="Generate it on your side" tone="note">
          <p>
            The key is chosen by your client, not by the API. Use something stable per logical
            operation — an order reference, a job id, a UUID you already generated. It is{' '}
            <strong>not</strong> a secret: it never authenticates anything, it only names the
            operation for retries.
          </p>
        </Callout>
      </section>

      <section aria-labelledby="idempotency-scope">
        <h2 id="idempotency-scope">What identifies an operation</h2>
        <p>
          The scope is the tuple <strong>(project, operation scope, key)</strong>:
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Combination</th>
                <th scope="col">Behavior</th>
              </tr>
            </thead>
            <tbody>
              {IDEMPOTENCY_SCOPE_ROWS.map((row) => (
                <tr key={row.question}>
                  <th scope="row">{row.question}</th>
                  <td>{row.answer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The project is part of the scope, but the authentication mode is not: the same key
          replayed through a session and through a key for the same project is still a replay.
        </p>
      </section>

      <section aria-labelledby="idempotency-window">
        <h2 id="idempotency-window">The 24-hour window</h2>
        <p>
          A stored response is kept for <strong>24 hours</strong> from the original request.
          Within that window the same key replays the stored response without re-executing the
          operation. After it expires, reusing the key is treated as a brand-new operation.
        </p>
        <p>
          Only <strong>committed successful</strong> responses are stored. A request rejected by
          validation, authentication, authorization or a business rule stores nothing, so the
          same key stays usable by a later, correct request — a <code>400</code> does not
          poison your key, and neither does a <code>429</code>.
        </p>
        <p>
          A replayed response is served with the <strong>current</strong> request&rsquo;s{' '}
          <code>X-Request-Id</code>, never the stored one — tracing stays truthful for the call
          you are looking at.
        </p>
        <p>
          <Link href="/docs/logs">Request ids and request logs →</Link>
        </p>
      </section>

      <section aria-labelledby="idempotency-example">
        <h2 id="idempotency-example">A safe create</h2>
        <CodeExampleList examples={[CREATE_PAYMENT_CURL]} />
        <p>
          Send the same header value on every retry of <em>this</em> operation. Do not reuse it
          for a different payment:
        </p>
        <CodeExampleList examples={[CREATE_PAYMENT_NO_KEY]} />
      </section>

      <section aria-labelledby="idempotency-concurrency">
        <h2 id="idempotency-concurrency">Concurrent retries</h2>
        <p>
          Idempotency is enforced in the database, where the claim, the mutation and the stored
          response share one transaction. Two identical requests racing therefore produce{' '}
          <strong>exactly one</strong> side effect, and every caller receives the same committed
          response — the loser of the race does not get an error, it gets the answer.
        </p>
        <p className="hint">
          That is also why a retry after a timeout is safe: whether your first request landed or
          not, the outcome is identical either way.
        </p>
      </section>

      <section aria-labelledby="idempotency-retries">
        <h2 id="idempotency-retries">Retry pattern</h2>
        <ol>
          <li>Generate one key per logical operation, before the first attempt.</li>
          <li>Send it on every attempt of that operation, including after a timeout.</li>
          <li>Change the key only when you intend a new operation.</li>
          <li>
            Retry <code>429</code> and transient <code>5xx</code> responses; never blindly
            retry <code>4xx</code>.
          </li>
        </ol>
        <p>
          <Link href="/docs/errors">Which statuses to retry →</Link> ·{' '}
          <Link href="/docs/rate-limits">Rate limits →</Link>
        </p>
      </section>
    </Guide>
  );
}
