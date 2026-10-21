/**
 * Unit test configuration (layer L1, phase 17 §6).
 *
 * The unit layer is pure logic: colocated specs under `src`, plus the pure
 * test-support logic under `test/support` (the D5 conformance helper, AC1).
 * The database-backed suites are `*.e2e-spec.ts` and run under
 * `test/jest-e2e.json` instead — an e2e spec must never be collected here, or
 * a unit run would silently boot the application (rule 5).
 *
 * ## Coverage ratchet (phase 17 D2(a), ADR-0034)
 *
 * `collectCoverageFrom` is explicit so the ratchet is stable across refactors:
 * production code under `src` counts; specs, declaration files, generated and
 * config files do not (§17). Thresholds are the measured baseline rounded down
 * — CI fails only on regression, never on an arbitrary target (Q3).
 *
 * The measured baseline and threshold numbers are recorded next to this policy
 * in `.ai/decisions/adr-0034-coverage-enforcement-ratchet.md`; re-measure with
 * `pnpm --filter @brinnpay/api test:coverage` when raising (never lowering) a
 * threshold.
 *
 * | Metric     | Measured baseline (2026-10-09) | Threshold (rounded down) |
 * | ---------- | ------------------------------ | ------------------------ |
 * | statements | 72.8%                          | 72%                      |
 * | branches   | 64.91%                         | 64%                      |
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
      },
    ],
    'node_modules/.pnpm/@nestjs\\+jwt.*/node_modules/@nestjs/jwt': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.node_modules.json',
      },
    ],
    'node_modules/.pnpm/@nestjs\\+bullmq.*/node_modules/@nestjs/bullmq': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.node_modules.json',
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!\\.pnpm/)(?!@nestjs/jwt)(?!@nestjs/bullmq)'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  // D2(a): ratchet at the measured baseline rounded down (never raise the
  // number without re-measuring; a regression fails CI, an improvement does
  // not silently move the bar).
  coverageThreshold: {
    global: {
      statements: 72,
      branches: 64,
    },
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
