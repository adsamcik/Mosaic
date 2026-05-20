import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * When `VITE_E2E_WEAK_KEYS=true`, swap every relative import that targets
 * `generated/mosaic-wasm/...` (the production artifact, built WITHOUT the
 * `weak-kdf` cargo feature) to `generated/mosaic-wasm-test-weak/...` (an
 * isolated artifact built WITH `weak-kdf`, so Argon2 derivations finish in
 * milliseconds for E2E fixtures).
 *
 * Gating rules (defense in depth, security-review-2026-05-20-01):
 *   - The redirect runs only when the env var is the literal string "true".
 *   - The redirect cannot point at the production artifact — it always
 *     resolves to a path containing `mosaic-wasm-test-weak/`.
 *   - The production artifact ships at the canonical path, so prod bundles
 *     can never accidentally bundle the weak-kdf bytes.
 */
function mosaicWeakKdfRedirectPlugin(): Plugin {
  const enabled = process.env.VITE_E2E_WEAK_KEYS === 'true';
  const PROD_MARKER = 'generated/mosaic-wasm/';
  const TEST_MARKER = 'generated/mosaic-wasm-test-weak/';
  return {
    name: 'mosaic-weak-kdf-redirect',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!enabled) return null;
      if (!source.includes(PROD_MARKER)) return null;
      if (source.includes(TEST_MARKER)) return null;
      const redirected = source.replace(PROD_MARKER, TEST_MARKER);
      const resolved = await this.resolve(redirected, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Production-build hard guard (HIGH security-review-2026-05-20-02).
  // Refuse to build a production bundle if the weak-kdf redirect is on,
  // and refuse to build at all if the canonical WASM has been overwritten
  // with the test-only weak-kdf bytes.
  if (mode === 'production') {
    if (process.env.VITE_E2E_WEAK_KEYS === 'true') {
      throw new Error(
        'VITE_E2E_WEAK_KEYS=true is set during a production build. ' +
          'Weak KDF must never reach production bundles ' +
          '(security-review-2026-05-20-02).',
      );
    }
    const canonical = resolve(
      __dirname,
      'src/generated/mosaic-wasm/mosaic_wasm_bg.wasm',
    );
    const weak = resolve(
      __dirname,
      'src/generated/mosaic-wasm-test-weak/mosaic_wasm_bg.wasm',
    );
    if (!existsSync(canonical)) {
      throw new Error(
        `Canonical production WASM is missing at ${canonical}. ` +
          'Run scripts/build-rust-wasm.sh (without weak-kdf) first.',
      );
    }
    if (existsSync(weak)) {
      const canonicalHash = createHash('sha256').update(readFileSync(canonical)).digest('hex');
      const weakHash = createHash('sha256').update(readFileSync(weak)).digest('hex');
      if (canonicalHash === weakHash) {
        throw new Error(
          'Canonical WASM is byte-identical to the test-weak artifact. ' +
            'The weak-kdf build overwrote the production output ' +
            '(security-review-2026-05-20-02).',
        );
      }
    }
  }

  // Default to port 5000 for local dev, override with VITE_API_PORT for containers
  const apiPort = env.VITE_API_PORT || '5000';

  return {
    plugins: [mosaicWeakKdfRedirectPlugin(), react()],

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
      rollupOptions: {
        // Multi-entry build: the SPA from index.html plus the Background-Fetch
        // service worker. The SW MUST be served from /sw.js at the site
        // root (scope /), so we override entryFileNames to keep it there
        // instead of under /assets/.
        input: {
          main: resolve(__dirname, 'index.html'),
          sw: resolve(__dirname, 'src/service-worker/sw.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
          manualChunks: (id) => {
            const normalizedId = id.replaceAll('\\', '/');
            if (normalizedId.includes('/node_modules/libsodium-wrappers-sumo/')) {
              return 'sodium';
            }
            if (
              normalizedId.includes('/node_modules/leaflet/') ||
              normalizedId.includes('/node_modules/supercluster/')
            ) {
              return 'leaflet';
            }
            if (
              normalizedId.includes('/node_modules/@tiptap/extension-placeholder/') ||
              normalizedId.includes('/node_modules/@tiptap/react/') ||
              normalizedId.includes('/node_modules/@tiptap/starter-kit/')
            ) {
              return 'editor';
            }
            return undefined;
          },
        },
      },
    },

    // Dependency optimization
    optimizeDeps: {
      include: ['libsodium-wrappers-sumo'],
      exclude: ['sql.js'],
    },
  };
});
