/**
 * Service Worker registration helper.
 *
 * Registered from `main.tsx`. The SW only exists to enable Background Fetch
 * (see `src/service-worker/sw.ts`). It does NOT cache assets, intercept
 * fetches, or push notifications.
 *
 * Gating
 * ------
 * - Skipped when `serviceWorker` is not available (Firefox private mode,
 *   Safari in some contexts, older browsers). Existing app flow unchanged.
 * - Skipped in dev unless `VITE_ENABLE_SW=1` is set, so the Vite dev server
 *   never has to fight an active SW for module reloads.
 *
 * ZK-safe logging: only success/failure name, no IDs or scopes.
 */
import { createLogger } from './logger';

const log = createLogger('sw-registration');

export interface RegisterServiceWorkerOptions {
  /** Override for tests. Defaults to `'/sw.js'`. */
  readonly scriptUrl?: string;
}

export async function registerServiceWorker(
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  const isProd = import.meta.env.PROD;
  const devOverride = import.meta.env.VITE_ENABLE_SW === '1';
  if (!isProd && !devOverride) {
    return null;
  }

  const scriptUrl = options.scriptUrl ?? '/sw.js';
  try {
    const registration = await navigator.serviceWorker.register(scriptUrl, {
      type: 'module',
      scope: '/',
    });
    log.info('Service worker registered');
    return registration;
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'Unknown';
    log.warn('Service worker registration failed', { errorName });
    return null;
  }
}