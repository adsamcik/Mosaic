import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60000, // 60s for integration tests
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
