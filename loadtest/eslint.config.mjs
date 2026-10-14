import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Phase 19 load-test harness (D1): the k6 scenarios run inside the k6 runtime
 * (its own globals, no Node), while the runner/seed/receiver scripts and the
 * unit tests run under Node. Both are linted like product code — the security
 * rules of §8 apply to these files exactly as they do to `apps/`.
 */
export default tseslint.config(
  {
    ignores: ['results/**', '.state/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // k6 scenario scripts: executed by the k6 JS runtime, not Node. The `k6`
    // globals below are the runtime-provided identifiers (`open()` and the
    // `__*` read-only values are globals there; everything else is imported).
    files: ['scenarios/**/*.ts', 'lib/**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        open: 'readonly',
        close: 'readonly',
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        __SCENARIO: 'readonly',
        __SOURCE_ID: 'readonly',
      },
    },
  },
  {
    // Runner, seed, receiver and unit tests: plain Node ESM.
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'lib/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
