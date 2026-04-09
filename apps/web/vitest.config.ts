import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    // Enable weak Argon2 params for fast test execution
    env: {
      VITE_E2E_WEAK_KEYS: 'true',
    },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
    ],
    testTimeout: 15000, // Fast with weak keys enabled, but some tests still need time
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
      '@': resolve(__dirname, './src'),
      '@mosaic/crypto': resolve(__dirname, '../../libs/crypto/src'),
    },
  },
});
