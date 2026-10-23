import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

/**
 * Phase 21 artifact tests (AC3/AC4/AC6/AC7/§8 rule 1): the committed
 * production Docker artifacts must exist, must be configuration-free and
 * secret-free, must harden the runtime as specified, and must leave the
 * development contracts (Phase 2 compose + dev Dockerfiles) untouched.
 *
 * These are pure file reads — no application boot, no Docker — so they live
 * in the unit layer (`test/` specs) and run in every `pnpm test`. The heavy
 * Docker-based assertions are the §6 M5 script's job
 * (`docker/production/validate.mjs`).
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCKER = path.join(REPO_ROOT, 'docker');

const read = (relative: string): string => readFileSync(path.join(DOCKER, relative), 'utf8');

const API_PROD_DOCKERFILE = 'api/Dockerfile.prod';
const WEB_PROD_DOCKERFILE = 'web/Dockerfile.prod';
const PROD_COMPOSE = 'compose.production.yml';
const ENV_TEMPLATE = 'production.env.example';
const VALIDATE_SCRIPT = path.join('production', 'validate.mjs');

/**
 * Secret-shaped patterns that must never appear in committed production
 * artifacts (same sweep posture as the phase-20 monitoring validator). The
 * base64-blob pattern is scoped to 60+ alphabet chars so ordinary prose does
 * not false-hit.
 */
const FORBIDDEN_SECRET_SHAPED = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk_live_[A-Za-z0-9]{16,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/=]{32,}['"]/i,
  /[A-Za-z0-9+/]{60,}={1,2}/,
];

/** Keys the boot path or a working deployment cannot do without (§6 M3). */
const REQUIRED_UNCOMMENTED_KEYS = [
  'JWT_SECRET',
  'WEBHOOK_ENCRYPTION_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'CORS_ORIGINS',
  'NEXT_PUBLIC_API_BASE_URL',
  'METRICS_SCRAPE_TOKEN',
];

/**
 * Every optional key of the documented contract (the configuration inventory
 * of `apps/api/src/config/configuration.ts`, `apps/api/.env.example`, and the
 * Phase 18/20 handover tables). The template must list each one so an
 * operator never has to re-derive the inventory.
 */
const OPTIONAL_DOCUMENTED_KEYS = [
  'NODE_ENV',
  'PORT',
  'SERVICE_NAME',
  'LOG_LEVEL',
  'OPENAPI_PATH',
  'SWAGGER_PATH',
  'ACCESS_TOKEN_TTL_SECONDS',
  'COOKIE_SECURE',
  'COOKIE_SAME_SITE',
  'AUTH_COOKIE_NAME',
  'REFRESH_SESSION_TTL_DAYS',
  'AUTH_RATE_LIMIT_WINDOW_SECONDS',
  'AUTH_RATE_LIMIT_IP_LOGIN_MAX',
  'AUTH_RATE_LIMIT_ACCOUNT_LOGIN_MAX',
  'AUTH_RATE_LIMIT_IP_REFRESH_MAX',
  'AUTH_RATE_LIMIT_IP_READ_MAX',
  'PAYMENT_PENDING_DELAY_MS',
  'PAYMENT_SETTLEMENT_DELAY_MS',
  'IDEMPOTENCY_RETENTION_HOURS',
  'WEBHOOK_MAX_ATTEMPTS',
  'WEBHOOK_BASE_BACKOFF_MS',
  'WEBHOOK_MAX_BACKOFF_MS',
  'WEBHOOK_CONNECT_TIMEOUT_MS',
  'WEBHOOK_REQUEST_TIMEOUT_MS',
  'WEBHOOK_EVENT_RETENTION_DAYS',
  'WEBHOOK_RECONCILIATION_INTERVAL_MS',
  'WEBHOOK_RECONCILIATION_HORIZON_MS',
  'WEBHOOK_ADVANCEMENT_SWEEP_INTERVAL_MS',
  'WEBHOOK_CLEANUP_INTERVAL_MS',
  'WEBHOOK_FAILED_JOB_RETENTION_MS',
  'WEBHOOK_RETAINED_FAILED_JOBS',
  'WEBHOOK_DESTINATION_ALLOWLIST',
  'WEBHOOK_DESTINATION_DENYLIST',
  'REQUEST_LOG_RETENTION_DAYS',
  'REQUEST_LOG_CLEANUP_INTERVAL_MS',
  'RATE_LIMIT_READ_MAX',
  'RATE_LIMIT_WRITE_MAX',
  'RATE_LIMIT_WINDOW_SECONDS',
  'RATE_LIMIT_WEBHOOK_REPLAY_MAX',
  'RATE_LIMIT_WEBHOOK_REPLAY_WINDOW_SECONDS',
  'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_MAX',
  'RATE_LIMIT_WEBHOOK_ENDPOINT_CREATE_WINDOW_SECONDS',
  'RATE_LIMIT_FAIL_MODE',
  'TRUST_PROXY_HOPS',
  'TRUST_PROXY_CIDRS',
  'WEB_SECURE',
  'HOSTNAME',
  'METRICS_ENABLED',
  'METRICS_PATH',
  'WORKER_METRICS_PORT',
];

/** A non-comment `KEY=` line in the env template, with its value. */
function templateAssignment(template: string, key: string): { line: string; value: string } | null {
  const match = template.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? { line: match[0], value: match[1].trim() } : null;
}

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; target?: string; args?: Record<string, string> };
  command?: string | string[];
  environment?: Record<string, string>;
  ports?: string[];
  depends_on?: Record<string, unknown> | string[];
  healthcheck?: unknown;
  profiles?: string[];
}

interface ComposeFile {
  name?: string;
  services?: Record<string, ComposeService>;
}

describe('production Docker artifacts (Phase 21)', () => {
  describe('configuration management (AC3, §6 M3)', () => {
    const template = read(ENV_TEMPLATE);

    it('lists every key of the production configuration contract', () => {
      for (const key of [...REQUIRED_UNCOMMENTED_KEYS, ...OPTIONAL_DOCUMENTED_KEYS]) {
        expect({ key, present: template.includes(`${key}=`) || new RegExp(`^# ${key}=`, 'm').test(template) }).toEqual({
          key,
          present: true,
        });
      }
    });

    it('uncomments exactly the boot-required keys and leaves every secret empty', () => {
      for (const key of REQUIRED_UNCOMMENTED_KEYS) {
        const assignment = templateAssignment(template, key);
        expect(assignment).not.toBeNull();
        expect({ key, value: assignment?.value ?? null }).toEqual({ key, value: '' });
      }
      // The only uncommented assignment with a value is the non-secret
      // production NODE_ENV posture; every other live assignment is empty —
      // no real value for anything is committed.
      const assignments = template.match(/^[A-Z][A-Z0-9_]*=.*$/gm) ?? [];
      for (const line of assignments) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').trim();
        if (value.length > 0) {
          expect({ key, value }).toEqual({ key: 'NODE_ENV', value: 'production' });
        }
      }
    });

    it('carries no secret-shaped material', () => {
      for (const file of [ENV_TEMPLATE, API_PROD_DOCKERFILE, WEB_PROD_DOCKERFILE, PROD_COMPOSE, VALIDATE_SCRIPT]) {
        const content = read(file);
        for (const pattern of FORBIDDEN_SECRET_SHAPED) {
          expect({ file, match: pattern.exec(content)?.[0] ?? null }).toEqual({ file, match: null });
        }
      }
    });

    it('documents the secret generation commands and the cross-process key rule (F8)', () => {
      expect(template).toContain('openssl rand -base64 48');
      expect(template).toContain('openssl rand -base64 32');
      expect(template).toMatch(/identical\s+#?\s*JWT_SECRET and WEBHOOK_ENCRYPTION_KEY/);
    });
  });

  describe('API production image (AC1, §6 M1)', () => {
    const dockerfile = read(API_PROD_DOCKERFILE);

    it('uses a pinned Node 22 Debian-slim base, never :latest', () => {
      const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
      expect(bases.length).toBeGreaterThanOrEqual(3);
      for (const base of bases) {
        expect(base).not.toContain(':latest');
        expect(base).toMatch(/^node:22\.23\.4-bookworm-slim( AS \w+)?$/);
      }
    });

    it('runs non-root and declares the documented entrypoints and probe', () => {
      expect(dockerfile).toMatch(/^USER node$/m);
      expect(dockerfile).toContain('CMD ["node", "dist/src/main.js"]');
      expect(dockerfile).toContain('dist/src/worker.js');
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).toContain('/health/ready');
      expect(dockerfile).toMatch(/^ENV NODE_ENV=production/m);
    });

    it('carries the runtime payload only: prod deps, compiled dist, the contract; no toolchain stage bleed', () => {
      expect(dockerfile).toContain('pnpm install --frozen-lockfile --prod');
      expect(dockerfile).toContain('docs/openapi.yaml');
      expect(dockerfile).toContain('prisma:generate');
      // The runtime stage copies only prod-deps/builder artifacts — never the
      // full install or the source tree.
      const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));
      expect(runtimeStage).not.toContain('pnpm install');
      expect(runtimeStage).not.toContain('COPY apps/api/src');
      expect(runtimeStage).not.toContain('corepack');
    });

    it('declares no secret-bearing build arguments (§4 rule 3)', () => {
      const args = [...dockerfile.matchAll(/^ARG\s+(\S+)/gm)].map((match) => match[1]);
      for (const arg of args) {
        expect(arg).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY$/i);
      }
      expect(args).toContain('VERSION=0.1.0');
    });
  });

  describe('web production image (AC2, §6 M2)', () => {
    const dockerfile = read(WEB_PROD_DOCKERFILE);

    it('uses a pinned Node 22 Debian-slim base, never :latest, and runs non-root', () => {
      const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
      expect(bases.length).toBeGreaterThanOrEqual(2);
      for (const base of bases) {
        expect(base).not.toContain(':latest');
        expect(base).toMatch(/^node:22\.23\.4-bookworm-slim( AS \w+)?$/);
      }
      expect(dockerfile).toMatch(/^USER node$/m);
    });

    it('builds with standalone output and documents the build-time web inputs (F3, ADR-0028)', () => {
      expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_API_BASE_URL=/m);
      // HSTS posture is evaluated at build time by the standalone server, so
      // WEB_SECURE is a build argument too (no default in the Dockerfile: an
      // unset ARG keeps the secure production default in next.config).
      expect(dockerfile).toMatch(/^ARG WEB_SECURE=/m);
      expect(dockerfile).toContain('pnpm build');
      expect(dockerfile).toContain('.next/standalone');
      // The web app config change this phase declares (Q5/D2(a)).
      const nextConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/next.config.ts'), 'utf8');
      expect(nextConfig).toContain("output: 'standalone'");
    });

    it('keeps the canonical contract resolvable and documents the port/probe contract', () => {
      expect(dockerfile).toContain('docs/openapi.yaml');
      expect(dockerfile).toContain('EXPOSE 3001');
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).toContain("PORT || 3001");
    });
  });

  describe('production compose definition (AC5, D5(a))', () => {
    const composeFile = parse(read(PROD_COMPOSE)) as ComposeFile;
    const services = composeFile.services ?? {};

    it('defines the validation stack on an isolated project name', () => {
      expect(composeFile.name).toBe('brinnpay-production');
      expect(Object.keys(services).sort()).toEqual(['api', 'migrate', 'postgres', 'redis', 'web', 'worker']);
    });

    it('injects every secret by interpolation with a required-value guard (§8 rule 1)', () => {
      for (const service of ['api', 'worker', 'migrate']) {
        const environment = services[service]?.environment ?? {};
        for (const key of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY']) {
          if (key in environment) {
            expect({ service, key, guarded: /^\$\{[A-Z_]+:\?/.test(environment[key] ?? '') }).toEqual({
              service,
              key,
              guarded: true,
            });
          }
        }
        expect(environment.DATABASE_URL).toMatch(/^\$\{DATABASE_URL:\?/);
      }
      for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY']) {
        expect(services.api?.environment?.[key] ?? services.postgres?.environment?.[key]).toMatch(
          /^\$\{[A-Z_]+:\?/,
        );
      }
      // No secret has a literal default anywhere in the file: every value is
      // an interpolation (`${…}`), never a committed literal.
      const serialized = read(PROD_COMPOSE);
      for (const key of ['JWT_SECRET', 'WEBHOOK_ENCRYPTION_KEY', 'POSTGRES_PASSWORD']) {
        expect(serialized).not.toMatch(new RegExp(`^\\s*${key}:\\s+(?!\\$)`, 'm'));
      }
    });

    it('shares one image between api and worker; the worker publishes no ports (F8, F9)', () => {
      expect(services.api?.image).toBe('${API_IMAGE:-brinnpay/api:0.1.0-local}');
      expect(services.worker?.image).toBe('${API_IMAGE:-brinnpay/api:0.1.0-local}');
      expect(services.worker?.command).toEqual(['node', 'dist/src/worker.js']);
      expect(services.worker?.ports).toBeUndefined();
      expect(services.api?.ports).toEqual(['${API_PORT:-3000}:3000']);
      expect(services.web?.ports).toEqual(['${WEB_PORT:-3001}:3001']);
    });

    it('applies migrations as an explicit pre-start step before api/worker (D3(a), ADR-0045)', () => {
      const migrate = services.migrate;
      expect(migrate?.build?.target).toBe('builder');
      expect(migrate?.command).toEqual(['pnpm', '--filter', '@brinnpay/api', 'prisma:migrate:deploy']);
      for (const service of ['api', 'worker']) {
        const dependsOn = services[service]?.depends_on as Record<string, { condition?: string }>;
        expect(dependsOn.migrate?.condition).toBe('service_completed_successfully');
      }
      // Runtime images never run migrations themselves.
      expect(services.api?.command).toBeUndefined();
    });

    it('defaults to the production posture: metrics off, run-scoped D8 overrides explicit (F7/F9)', () => {
      expect(services.api?.environment?.METRICS_ENABLED).toBe('${METRICS_ENABLED:-false}');
      expect(services.worker?.environment?.METRICS_ENABLED).toBe('${METRICS_ENABLED:-false}');
      expect(services.api?.environment?.COOKIE_SECURE).toBe('${COOKIE_SECURE:-false}');
      expect(services.web?.environment?.WEB_SECURE).toBe('${WEB_SECURE:-false}');
      expect(services.api?.environment?.TRUST_PROXY_HOPS).toBe('${TRUST_PROXY_HOPS:-0}');
      // The web security/API-origin postures are build-time inputs of the
      // standalone image (F3/ADR-0028) — passed as build args, defaults secure.
      expect(services.web?.build?.args?.NEXT_PUBLIC_API_BASE_URL).toBe(
        '${NEXT_PUBLIC_API_BASE_URL:-http://localhost:3000/api/v1}',
      );
      expect(services.web?.build?.args?.WEB_SECURE).toBe('${WEB_SECURE:-true}');
    });

    it('probes exactly the Phase 2/20 semantics — readiness for the API, liveness on the worker port', () => {
      const apiHealth = JSON.stringify(services.api?.healthcheck);
      expect(apiHealth).toContain('/health/ready');
      expect(apiHealth).not.toContain('/health/live');
      const workerHealth = JSON.stringify(services.worker?.healthcheck);
      expect(workerHealth).toContain('/health/live');
      expect(workerHealth).toContain('9464');
      // The web probe is the documented HTTP 200 on `/` (no health endpoint).
      expect(JSON.stringify(services.web?.healthcheck)).toContain('3001');
    });
  });

  describe('validation procedure (AC5, D5(a), ADR-0046)', () => {
    const script = read(VALIDATE_SCRIPT);

    it('is committed, self-cleaning, project-isolated, and non-zero on failure', () => {
      expect(script).toContain('brinnpay-production');
      expect(script).toContain(`'-p', COMPOSE_PROJECT`);
      expect(script).toContain(`'down', '-v'`);
      expect(script).toContain('process.exitCode');
      // Secrets: generated per run, temp env file, deleted on exit, never printed.
      expect(script).toContain('randomBytes');
      expect(script).toContain('mkdtempSync');
      expect(script).toContain('rmSync');
      expect(script).not.toMatch(/JWT_SECRET\s*=\s*['"][^'"]{8,}['"]/);
    });

    it('executes the §6 M5 assertion checklist', () => {
      for (const id of ['M5-1', 'M5-2', 'M5-3', 'M5-4', 'M5-5', 'M5-6', 'M5-7', 'M5-8', 'M5-9']) {
        expect({ id, present: script.includes(`'${id}'`) }).toEqual({ id, present: true });
      }
      // Negative cases are executable checks, not prose.
      expect(script).toContain('pre-migration');
      expect(script).toContain('JWT_SECRET is required');
      expect(script).toContain('WEBHOOK_ENCRYPTION_KEY is required');
    });
  });

  describe('development contracts intact (AC6, F10, §4 rule 7)', () => {
    it('the dev compose file still builds the dev Dockerfiles and is untouched by production artifacts', () => {
      const devCompose = read('compose.yml');
      expect(devCompose).toContain('dockerfile: docker/api/Dockerfile');
      expect(devCompose).toContain('dockerfile: docker/web/Dockerfile');
      expect(devCompose).not.toContain('Dockerfile.prod');
      expect(devCompose).not.toContain('compose.production.yml');
    });

    it('the dev Dockerfiles still run the watch-mode dev servers', () => {
      expect(read('api/Dockerfile')).toContain('nest start --watch');
      expect(read('web/Dockerfile')).toContain('next dev');
    });

    it('the production entrypoint scripts match the real compiled layout (dist/src)', () => {
      const apiPackage = JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'apps/api/package.json'), 'utf8'),
      ) as { scripts: Record<string, string> };
      expect(apiPackage.scripts.start).toBe('node dist/src/main.js');
      expect(apiPackage.scripts.worker).toBe('node dist/src/worker.js');
    });
  });
});
