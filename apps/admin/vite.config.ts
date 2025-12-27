import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@mosaic/crypto': resolve(__dirname, '../../libs/crypto/src/index.ts'),
    },
  },

  // Required headers for SharedArrayBuffer (used by some crypto operations)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Proxy API requests to backend during development
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // Forward all headers including Remote-User for E2E tests
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Forward Remote-User header if present
            if (req.headers['remote-user']) {
              proxyReq.setHeader('Remote-User', req.headers['remote-user']);
            }
          });
        },
      },
    },
  },

  // Worker configuration
  worker: {
    format: 'es',
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },

  // Dependency optimization
  optimizeDeps: {
    include: ['libsodium-wrappers'],
    exclude: ['sql.js'],
  },
});
