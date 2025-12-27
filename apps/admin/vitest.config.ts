import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
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
      '@mosaic/crypto': '../../libs/crypto/src',
    },
  },
});
