import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Enable weak Argon2 params for fast test execution
    env: {
      VITE_E2E_WEAK_KEYS: 'true',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/mock.ts', 'src/index.ts', 'src/argon2-params.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
    testTimeout: 20000, // Fast with weak keys enabled, but some integration tests still need time
  },
});
