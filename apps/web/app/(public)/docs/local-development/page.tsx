import type { Metadata } from 'next';
import Link from 'next/link';

import { Callout } from '../../../../components/docs/callout';
import { CodeExampleList } from '../../../../components/docs/code-block';
import { Guide } from '../../../../components/docs/guide';
import { LOCAL_SHELL_SETUP, REGISTER_WEBHOOK_LOCALHOST } from '../../../../lib/docs/examples';

export const metadata: Metadata = {
  title: 'Local development — BrinnPay',
  description:
    'Local development guide: run BrinnPay with Docker Compose — prerequisites, service ports, migrations and checks — and point a local application at the sandbox, including webhooks on localhost.',
};

const PORT_ROWS: { service: string; port: string; override: string; purpose: string }[] = [
  { service: 'API', port: '3000', override: 'API_PORT', purpose: 'NestJS dev server, Swagger UI and /api/v1' },
  { service: 'Web', port: '3001', override: 'WEB_PORT', purpose: 'Next.js dev server (this documentation area)' },
  { service: 'PostgreSQL', port: '5432', override: 'POSTGRES_PORT', purpose: 'Primary database' },
  { service: 'Redis', port: '6379', override: 'REDIS_PORT', purpose: 'Queue and rate-limit storage' },
];

const CHECK_ROWS: { command: string; purpose: string }[] = [
  { command: 'pnpm lint', purpose: 'ESLint across the workspace, plus the OpenAPI lint (Redocly)' },
  { command: 'pnpm lint:openapi', purpose: 'OpenAPI contract only — must stay at zero errors' },
  { command: 'pnpm typecheck', purpose: 'TypeScript, every package' },
  { command: 'pnpm test', purpose: 'Unit suites (API and web)' },
  { command: 'pnpm test:e2e', purpose: 'Integration/e2e suites' },
  { command: 'pnpm build', purpose: 'Production build of every package' },
];

/**
 * Local development guide (phase 15 §8, D5 confirmed (a)): one guide, both
 * audiences — running BrinnPay itself, and developing an integration against
 * it from a local application. Configuration published here is non-secret
 * only; rate-limit environment variables and operator-only tuning stay in the
 * repository documentation (Q1), and no secret value is ever reproduced.
 */
export default function LocalDevelopmentPage() {
  return (
    <Guide
      title="Local development"
      lead="Two things people mean by this: running the BrinnPay codebase itself, and pointing your own local application at the sandbox. Both are covered here."
      sources={['docker/compose.yml', 'apps/api/.env.example', 'docs/api-conventions.md']}
    >
      <section aria-labelledby="local-audiences">
        <h2 id="local-audiences">What this guide covers</h2>
        <ul>
          <li>
            <strong>Running BrinnPay</strong> — prerequisites, starting the stack, ports,
            database migrations, configuration, and the required checks.
          </li>
          <li>
            <strong>Developing an integration locally</strong> — pointing a local application at
            the sandbox API, using a TEST key, and receiving webhooks on <code>localhost</code>.
          </li>
        </ul>
        <p>
          Everything below runs on your machine. The stack is the same one the project develops
          against, so what works here works in the shared environment. It is a sandbox
          throughout: BrinnPay simulates payments and processes no real money, in either
          environment. <Link href="/docs/sandbox">What the sandbox simulates →</Link>
        </p>
      </section>

      <section aria-labelledby="local-prerequisites">
        <h2 id="local-prerequisites">Prerequisites</h2>
        <ul>
          <li>
            <strong>Node.js 22</strong> — the version the workspace and the containers use.
          </li>
          <li>
            <strong>pnpm via corepack</strong> — the repository pins its package manager, so
            enabling corepack is enough:
            <CodeExampleList
              examples={[
                {
                  label: 'Shell',
                  language: 'bash',
                  code: ['corepack enable', 'pnpm install'].join('\n'),
                },
              ]}
            />
          </li>
          <li>
            <strong>Docker with Docker Compose</strong> — PostgreSQL, Redis, the API and the web
            app all start from one file.
          </li>
        </ul>
      </section>

      <section aria-labelledby="local-start">
        <h2 id="local-start">Start the stack</h2>
        <p>
          From the repository root, one command builds the containers and starts every service:
        </p>
        <CodeExampleList
          examples={[
            {
              label: 'Shell',
              language: 'bash',
              code: ['docker compose -f docker/compose.yml up --build'].join('\n'),
            },
          ]}
        />
        <p>
          The definition lives in <code>docker/compose.yml</code> and starts five services:
          PostgreSQL, Redis, the API, the webhook worker (the process that signs and performs
          webhook deliveries), and the web app. Source directories are mounted, so edits reload
          without a rebuild. Container state and health are visible with{' '}
          <code>docker compose ps</code>.
        </p>
        <Callout title="First run only" tone="note">
          <p>
            The database starts empty. Apply the committed migrations before expecting the API to
            answer anything beyond its health endpoints — the next section.
          </p>
        </Callout>
      </section>

      <section aria-labelledby="local-ports">
        <h2 id="local-ports">Service ports</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Port</th>
                <th scope="col">Override</th>
                <th scope="col">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {PORT_ROWS.map((row) => (
                <tr key={row.service}>
                  <th scope="row">{row.service}</th>
                  <td>
                    <code>{row.port}</code>
                  </td>
                  <td>
                    <code>{row.override}</code>
                  </td>
                  <td>{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          The API serves Swagger UI from the same canonical contract at{' '}
          <code>http://localhost:3000/docs</code> — the interactive secondary path to the{' '}
          <Link href="/docs/api-reference">API reference</Link>.
        </p>
      </section>

      <section aria-labelledby="local-migrations">
        <h2 id="local-migrations">Apply database migrations</h2>
        <p>
          Migrations are committed under <code>apps/api/prisma/migrations</code> and are applied
          explicitly — the API never migrates on boot. With PostgreSQL running:
        </p>
        <CodeExampleList
          examples={[
            {
              label: 'Shell',
              language: 'bash',
              code: [
                'pnpm --filter @brinnpay/api prisma:migrate:dev',
                '',
                '# Deploying against a non-development database instead:',
                '# pnpm --filter @brinnpay/api prisma:migrate:deploy',
              ].join('\n'),
            },
          ]}
        />
        <p className="hint">
          The Prisma configuration falls back to the documented local defaults, so no extra
          variables are needed for a stock local stack. Re-running it is safe: it applies whatever
          is missing and nothing else.
        </p>
      </section>

      <section aria-labelledby="local-configuration">
        <h2 id="local-configuration">Configuration and secrets</h2>
        <p>
          Configuration is environment-based, and every setting has a non-secret default. The
          committed template <code>apps/api/.env.example</code> documents each setting and its
          default; copy it to <code>apps/api/.env</code> for local development:
        </p>
        <CodeExampleList
          examples={[
            {
              label: 'Shell',
              language: 'bash',
              code: ['cp apps/api/.env.example apps/api/.env'].join('\n'),
            },
          ]}
        />
        <Callout title="Some values are secrets" tone="important">
          <p>
            The API validates its secrets at boot and refuses to start when one is missing or too
            short. Generate them per checkout (the template shows the command for each), keep
            them in the untracked <code>.env</code> files, and never commit or log them. This
            documentation never reproduces a secret value — and neither should you.
          </p>
        </Callout>
        <p className="hint">
          <code>.env</code> files are gitignored. Ports, database name and user, CORS origin and
          log level are the non-secret defaults already listed above.
        </p>
      </section>

      <section aria-labelledby="local-checks">
        <h2 id="local-checks">Run the required checks</h2>
        <p>
          The same commands run locally and in CI. A change is done when all of them pass from
          the repository root:
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">What it checks</th>
              </tr>
            </thead>
            <tbody>
              {CHECK_ROWS.map((row) => (
                <tr key={row.command}>
                  <th scope="row">
                    <code>{row.command}</code>
                  </th>
                  <td>{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="local-artifacts">
        <h2 id="local-artifacts">Where the canonical artifacts live</h2>
        <ul>
          <li>
            <code>docs/openapi.yaml</code> — the canonical contract. Every operation in the{' '}
            <Link href="/docs/api-reference">API reference</Link> is generated from it, and{' '}
            <code>pnpm lint:openapi</code> keeps it valid.
          </li>
          <li>
            <code>docs/api-conventions.md</code> — the cross-cutting conventions behind it.
          </li>
          <li>
            This documentation area — <code>apps/web</code>, under <code>app/(public)/docs</code>{' '}
            — is content, not configuration: it builds statically and never calls the API.
          </li>
        </ul>
        <p className="hint">
          The API reads the contract at boot to serve Swagger UI; nothing else in the stack needs
          it at runtime.
        </p>
      </section>

      <section aria-labelledby="local-integration">
        <h2 id="local-integration">Develop an integration locally</h2>
        <p>
          Point your local application at the running API. The versioned prefix is{' '}
          <code>/api/v1</code>, so the local base URL is the API origin plus that prefix:
        </p>
        <CodeExampleList examples={[LOCAL_SHELL_SETUP]} />
        <p>
          Use a <code>test</code> key while you develop — it is scoped to one project and the{' '}
          <code>test</code> environment, and both environments are simulated anyway.{' '}
          <Link href="/docs/api-keys">API keys →</Link>{' '}
          <Link href="/docs/environments">Environments →</Link>
        </p>

        <h3>Webhooks on localhost</h3>
        <p>
          Local destinations are allowed by default, so a receiver on your own machine works
          without any allowlist configuration. Register an endpoint pointing at it:
        </p>
        <CodeExampleList examples={[REGISTER_WEBHOOK_LOCALHOST]} />
        <p>
          Keep two things in mind while developing against a local receiver:
        </p>
        <ol>
          <li>
            <strong>Verify against the raw body.</strong> If your local framework parses JSON
            before your handler runs, capture the raw stream first — a re-serialized body never
            matches the signature.{' '}
            <Link href="/docs/webhooks">Signature verification →</Link>
          </li>
          <li>
            <strong>Answer 2xx quickly.</strong> The retry budget starts immediately; process the
            event after responding, and deduplicate by event id because delivery is
            at-least-once.
          </li>
        </ol>
        <p className="hint">
          A receiver behind a local redirect must expose its direct URL: redirects are never
          followed, and a 3xx is terminal.
        </p>
      </section>

      <section aria-labelledby="local-next">
        <h2 id="local-next">Next steps</h2>
        <ul>
          <li>
            <Link href="/docs/quickstart">Quickstart</Link> — end to end against the TEST
            environment.
          </li>
          <li>
            <Link href="/docs/errors">Error handling</Link> and{' '}
            <Link href="/docs/rate-limits">rate limits</Link> — what to do when a call fails.
          </li>
          <li>
            <Link href="/docs/api-reference">API reference</Link> — every operation, generated
            from the contract.
          </li>
        </ul>
      </section>
    </Guide>
  );
}
