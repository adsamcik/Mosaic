import * as Comlink from 'comlink';
import type { DbWorkerApi } from '../workers/types';

// Import worker constructor via Vite's ?worker suffix
// This ensures Vite properly bundles and transforms the worker
import DbSharedWorkerConstructor from '../workers/db.worker.ts?sharedworker';
import DbWorkerConstructor from '../workers/db.worker.ts?worker';

let worker: SharedWorker | Worker | null = null;
let api: Comlink.Remote<DbWorkerApi> | null = null;

// Check if SharedWorker is available (not available in some contexts like tests)
// Disable SharedWorker in headless browsers and testing environments
function shouldUseSharedWorker(): boolean {
  if (typeof SharedWorker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  
  // Check for automation/testing environments using webdriver property
  // This is set by Playwright, Puppeteer, Selenium, etc.
  if ((navigator as any).webdriver === true) return false;
  
  const ua = navigator.userAgent.toLowerCase();
  // Disable in headless browsers (Playwright, Puppeteer, etc.)
  if (ua.includes('headless')) return false;
  // Disable in Playwright-controlled browsers
  if (ua.includes('playwright')) return false;
  // Environment variable check for testing
  if (typeof window !== 'undefined' && (window as any).__MOSAIC_DISABLE_SHARED_WORKER__) return false;
  
  return true;
}

const useSharedWorker = shouldUseSharedWorker();

/**
 * Get the database worker client (singleton)
 * Uses SharedWorker so multiple tabs share the same database instance
 * Falls back to regular Worker in test environments (Playwright sets navigator.webdriver)
 */
export async function getDbClient(): Promise<Comlink.Remote<DbWorkerApi>> {
  if (api) return api;

  if (useSharedWorker) {
    const sharedWorker = new DbSharedWorkerConstructor({ name: 'mosaic-db-worker' });
    sharedWorker.onerror = (e) => console.error('[db-client] SharedWorker error:', e);
    worker = sharedWorker;
    api = Comlink.wrap<DbWorkerApi>(sharedWorker.port);
  } else {
    // Fall back to regular Worker for test environments
    const regularWorker = new DbWorkerConstructor({ name: 'mosaic-db-worker' });
    regularWorker.onerror = (e) => console.error('[db-client] Worker error:', e);
    worker = regularWorker;
    api = Comlink.wrap<DbWorkerApi>(regularWorker);
  }
  
  return api;
}

/**
 * Close the database connection and cleanup
 */
export async function closeDbClient(): Promise<void> {
  if (api) {
    await api.close();
    api = null;
  }
  if (worker) {
    if ('port' in worker) {
      worker.port.close();
    } else {
      worker.terminate();
    }
    worker = null;
  }
}
