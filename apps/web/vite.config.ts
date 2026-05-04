import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Default to port 5000 for local dev, override with VITE_API_PORT for containers
  const apiPort = env.VITE_API_PORT || '5000';

  return {
    plugins: [react()],

    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@mosaic/crypto': resolve(__dirname, '../../libs/crypto/src/index.ts'),
        'libsodium-wrappers-sumo': resolve(__dirname, './node_modules/libsodium-wrappers-sumo'),
      },
    },

    // Required headers for SharedArrayBuffer (used by some crypto operations)
    // Using 'credentialless' instead of 'require-corp' to allow cross-origin resources
    // (like OpenStreetMap tiles) that don't have CORP headers
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        // Mirror production CSP (see apps/web/nginx.conf) so dev catches violations early.
        // Dev-only relaxations vs. production:
        //   - script-src adds 'unsafe-inline': Vite injects an inline bootstrap snippet
        //     for the HMR client. Production builds have no inline scripts.
        //   - upgrade-insecure-requests is omitted: dev runs over plain http://localhost
        //     and the directive would break module/HMR fetches.
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' blob: data: https://*.tile.openstreetmap.org",
          "connect-src 'self' ws: wss:",
          "worker-src 'self' blob:",
          "font-src 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      },
      // Proxy API requests to backend during development
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // Forward all headers including Remote-User for E2E tests
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              // Forward Remote-User header if present
              if (req.headers['remote-user']) {
                proxyReq.setHeader('Remote-User', req.headers['remote-user']);
              }
            });
            // Log proxy responses for debugging
            proxy.on('proxyRes', (proxyRes, req) => {
              if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
                console.log(`[Vite Proxy] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
              }
            });
            // Log proxy errors for debugging
            proxy.on('error', (err, req, res) => {
              console.error('[Vite Proxy Error]', err.message, req.url);
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
      sourcemap: mode !== 'production',
    },

    // Dependency optimization
    optimizeDeps: {
      include: ['libsodium-wrappers-sumo'],
      exclude: ['sql.js'],
    },
  };
});
