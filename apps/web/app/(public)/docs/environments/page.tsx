import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { Guide } from '../../../../components/docs/guide';

export const metadata: Metadata = {
  title: 'Environments — BrinnPay',
  description:
    'How the BrinnPay TEST and LIVE environments work: simulated by default in both, lowercase API values, and how the environment is chosen per authentication mode.',
};

const SPELLING_ROWS: { context: string; spelling: string }[] = [
  { context: 'API values, payloads, filters, event envelopes', spelling: 'test / live' },
  { context: 'UI copy, badges, documentation headings', spelling: 'TEST / LIVE' },
  { context: 'API key prefix', spelling: 'sk_test_… / sk_live_…' },
];

/**
 * Environment guide (phase 15 §5.5): both environments are simulated, every
 * project has both, the lowercase API spelling, where the environment comes
 * from per authentication mode, and how the dashboard selector relates.
 */
export default function EnvironmentsPage() {
  return (
    <Guide
      title="Environments"
      lead="Every project has two simulated environments: test and live. They are identical in shape and behavior, they never share data, and neither of them processes real money."
      sources={['docs/api-conventions.md', 'docs/openapi.yaml']}
    >
      <section aria-labelledby="environments-simulated">
        <h2 id="environments-simulated">Both environments are simulated</h2>
        <Callout title="No real money" tone="warning">
          <p>
            BrinnPay simulates payment infrastructure. <code>test</code> and <code>live</code>{' '}
            differ in which data set they use — not in whether money moves. Neither processes
            real money or real card data.
          </p>
        </Callout>
        <ul>
          <li>
            A project supports <strong>both</strong> environments by default; there is no
            option to disable one.
          </li>
          <li>
            Each environment-scoped resource belongs to <strong>exactly one</strong> environment
            — customers, payments, refunds, webhook endpoints, events.
          </li>
          <li>
            TEST and LIVE data are never mixed: a list, retrieve or create in one environment
            cannot see or touch the other, even when addressed by id.
          </li>
          <li>
            <strong>API keys are the exception</strong>: keys are created per environment, but
            the <em>list</em> of a project&rsquo;s keys spans both, so rotation and revocation
            are managed at the project level.
          </li>
        </ul>
        <p>
          <Link href="/docs/sandbox">What the sandbox simulates →</Link>
        </p>
      </section>

      <section aria-labelledby="environments-spelling">
        <h2 id="environments-spelling">Spelling</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Where</th>
                <th scope="col">Spelling</th>
              </tr>
            </thead>
            <tbody>
              {SPELLING_ROWS.map((row) => (
                <tr key={row.context}>
                  <th scope="row">{row.context}</th>
                  <td>
                    <code>{row.spelling}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          The two spellings map by context and are never mixed inside a single artifact: the API
          only ever sees lowercase values, the interface only ever shows uppercase ones.
        </p>
      </section>

      <section aria-labelledby="environments-source">
        <h2 id="environments-source">Where the environment comes from</h2>
        <p>
          It depends on the authentication mode, and this is the most common integration
          mistake:
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Mode</th>
                <th scope="col">How the environment is determined</th>
                <th scope="col">Mismatch</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">API key</th>
                <td>
                  Derived from the key (<code>sk_test_…</code> or <code>sk_live_…</code>). You
                  do not choose it per request.
                </td>
                <td>
                  A payload or filter naming the other environment is rejected with{' '}
                  <code>422</code> — including a value that conflicts with the key.
                </td>
              </tr>
              <tr>
                <th scope="row">Session</th>
                <td>
                  Declared explicitly: an <code>environment</code> body field on creates, or an{' '}
                  <code>environment</code> query filter on lists.
                </td>
                <td>
                  A missing value on a create is a <code>400 VALIDATION_ERROR</code> — the API
                  never guesses.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          This is why the quickstart sends <code>"environment": "test"</code> together with a{' '}
          <code>sk_test_…</code> key: the two must agree.
        </p>
        <p>
          <Link href="/docs/authentication">Authentication modes →</Link>
        </p>
      </section>

      <section aria-labelledby="environments-dashboard">
        <h2 id="environments-dashboard">The dashboard selector</h2>
        <p>
          The dashboard does not switch environments behind the scenes — the selected
          environment travels in the URL as an <code>environment</code> query parameter, which
          every environment-scoped page inherits. The default is <code>test</code>, and an
          unknown value falls back to it.
        </p>
        <p className="hint">
          Because the selector is a query parameter, deep links are shareable and always name
          the environment they open: the same link never shows different data to two people.
        </p>
      </section>
    </Guide>
  );
}
