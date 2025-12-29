import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      // TODO: These tests need to be updated to match refactored component APIs
      // The components were refactored from dialog-based to view-based patterns
      'tests/share-link-dialog.test.tsx',
      'tests/edit-link-expiration-dialog.test.tsx',
      // TODO: These e2e-flow tests try to make real network requests
      // They should be converted to proper integration tests with mocked fetch
      'tests/e2e-flows.test.ts',
    ],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
        'src/main.tsx',
        'src/App.tsx',
        'src/components/**/*.tsx',
      ],
    },
  },
  resolve: {
    alias: {
      '@mosaic/crypto': resolve(__dirname, '../../libs/crypto/src'),
    },
  },
});
