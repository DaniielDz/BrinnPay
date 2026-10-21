/**
 * Dependency gate for the database-backed e2e suites (phase 12 F9).
 *
 * These suites boot the whole Nest application and assert behavior no unit
 * double can stand in for: transactional capture, the organization cascade, the
 * `UPDATE` trigger, isolation and concurrency. They therefore need real
 * PostgreSQL and Redis (`docker/compose.yml` plus `prisma migrate deploy`).
 *
 * **Why this exists.** Each suite probed its dependencies in `beforeAll` and
 * then `return`ed from the top of every test when the probe failed. Jest
 * reports an early `return` as a **pass**, so `pnpm test:e2e` printed an
 * all-green run having executed nothing — a silent skip is a false claim, and
 * it is invisible precisely when it matters (a broken environment, a lost
 * service container, a mistyped `DATABASE_URL`).
 *
 * {@link requireDependencies} turns that absence into a visible failure with an
 * actionable message. A suite that genuinely must not run should be reported
 * as pending (`describe.skip`), never as a passing test.
 */
export function requireDependencies(available: boolean): void {
  if (available) return;
  throw new Error(
    'PostgreSQL/Redis are unavailable, so this e2e suite verified nothing. Start them with ' +
      '`docker compose -f docker/compose.yml up -d`, apply the migrations ' +
      '(`pnpm --filter @brinnpay/api prisma:migrate:deploy`) and re-run. This failure is deliberate: ' +
      'skipping silently would turn a green run into a false claim (phase 12 F9).',
  );
}