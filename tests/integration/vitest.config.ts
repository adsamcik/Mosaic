import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Enable weak Argon2 params for fast test execution
    env: {
      VITE_E2E_WEAK_KEYS: 'true',
    },
    testTimeout: 30000, // Reduced with weak keys
    hookTimeout: 30000,
    sequence: {
      shuffle: false, // Run in order for integration tests
    },
    reporters: ['verbose', 'junit'],
    outputFile: {
      junit: './results/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
