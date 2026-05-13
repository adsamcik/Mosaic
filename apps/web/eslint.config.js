// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Mosaic web — flat ESLint config.
 *
 * Enforces the project's coding standards documented in
 * `apps/web/.instructions.md`:
 *   - No `any` types (use `unknown` + type guards).
 *   - No `@ts-ignore`; `@ts-expect-error` only with a written explanation.
 *   - React hooks rules.
 *   - No `console.log`/`console.info` in main-thread production code; the
 *     centralised `logger` utility is the only sanctioned channel. Workers
 *     and the `logger` implementation itself are scoped exceptions.
 *   - Retired `@mosaic/crypto` keychain / identity / auth / manifest / etc.
 *     modules are banned in production code — protocol crypto must route
 *     through the Rust/WASM handle APIs exposed by `crypto.worker`.
 *
 * Test directories, generated code, experimental spikes, dev tooling, and
 * worker-internal logging are explicitly relaxed via overrides below.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'src/generated/**',
      'src/spikes/**',
      'scripts/**',
      'tests/e2e/**',
      'benchmark.html',
      '*.config.*',
      '*-output.txt',
      '*.log',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...(reactHooks.configs?.recommended?.rules ?? {}),
      // React 19's eslint-plugin-react-hooks v7 ships a set of forward-looking
      // rules that flag patterns the React Compiler cannot optimise (mutating
      // refs during render, mutating props/state, calling impure functions
      // inside render, set-state-in-effect, etc.). The codebase predates the
      // compiler and contains many existing patterns that work today but
      // would need to be reshaped before adopting it. Keep these as warnings
      // so the surface is visible without blocking CI on a one-shot upgrade.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/purity': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 8,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
      // `no-useless-assignment` (ESLint v9) is overzealous on idiomatic
      // patterns like end-of-loop counter increments and try/catch
      // defaults. Leaving it on produces churn for zero real-bug value.
      'no-useless-assignment': 'off',
      // The album filename sanitizer at lib/album-download-service.ts has
      // a deliberate `\x00-\x1f` range to strip control chars from
      // user-supplied filenames. That is the entire point of the regex.
      'no-control-regex': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@mosaic/crypto/keychain*',
                '@mosaic/crypto/keybox*',
                '@mosaic/crypto/identity*',
                '@mosaic/crypto/auth*',
                '@mosaic/crypto/manifest*',
                '@mosaic/crypto/sharing*',
                '@mosaic/crypto/link-sharing*',
                '@mosaic/crypto/content*',
                '@mosaic/crypto/signer*',
                '@mosaic/crypto/memory*',
                '@mosaic/crypto/mock*',
              ],
              message:
                'Retired @mosaic/crypto module — route protocol crypto through the Rust/WASM handle APIs exposed by crypto.worker.',
            },
          ],
        },
      ],
    },
  },
  // The centralised logger is the implementation behind log.info / log.debug /
  // log.warn / log.error; it is allowed to call `console.*` directly.
  {
    files: ['src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  // Web workers do not share the main thread's logger transport. They are
  // permitted to use the structured logger which itself reaches console
  // inside the worker realm. The .instructions.md for workers explicitly
  // sanctions this.
  {
    files: ['src/workers/**/*.ts', 'src/service-worker/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Test sources — relax purity rules. Branded-type casts (`as EpochHandleId`),
  // ad-hoc mocks, and the occasional `any` for stubbing third-party shapes
  // are pragmatic in tests and do not affect production safety.
  {
    files: [
      '**/__tests__/**/*.{ts,tsx}',
      'tests/**/*.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/**/*.bench.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
);
