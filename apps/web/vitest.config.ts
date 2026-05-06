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
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
    ],
    // Rust WASM init is CPU/memory heavy and happens per Vitest worker.
    // Keep limited parallelism so WASM-touching suites don't contend and
    // time out while preserving more throughput than fully sequential runs.
    maxWorkers: 2,
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
      // Thresholds are calibrated to current achieved coverage minus a small
      // buffer (rounded down to the nearest 5%) so day-to-day churn doesn't
      // flap the gate while still preventing regression. The .github/agents.md
      // aspirational target is 80% lines for the frontend; raise these numbers
      // as coverage improves toward that goal.
      thresholds: {
        lines: 50,
        functions: 40,
        branches: 40,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@mosaic/crypto': resolve(__dirname, '../../libs/crypto/src'),
      'libsodium-wrappers-sumo': resolve(__dirname, './node_modules/libsodium-wrappers-sumo'),
    },
  },
});
