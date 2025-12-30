import * as Comlink from 'comlink';
import type { DbWorkerApi } from '../workers/types';
import { createLogger } from './logger';

const log = createLogger('db-client');

// Import worker constructor via Vite's ?worker suffix
// This ensures Vite properly bundles and transforms the worker
import DbSharedWorkerConstructor from '../workers/db.worker.ts?sharedworker';
import DbWorkerConstructor from '../workers/db.worker.ts?worker';

let worker: SharedWorker | Worker | null = null;
let api: Comlink.Remote<DbWorkerApi> | null = null;

/**
 * Check if SharedWorker should be used.
 * Uses proper feature detection instead of fragile user-agent sniffing.
 * 
 * SharedWorker requires:
 * 1. SharedWorker API available in the global scope
 * 2. OPFS (Origin Private File System) for persistence - requires storage.getDirectory()
 * 3. Not in an automation/testing environment (webdriver flag)
 * 
 * Falls back to regular Worker when SharedWorker cannot be used.
 */
function shouldUseSharedWorker(): boolean {
  // Check if SharedWorker API is available
  if (!('SharedWorker' in globalThis)) return false;
  
  // Check if navigator is available (SSR safety)
  if (typeof navigator === 'undefined') return false;
  
  // Check for automation/testing environments using webdriver property
  // This is a standard property set by Playwright, Puppeteer, Selenium, etc.
  // Not user-agent sniffing - this is a proper automation detection flag
  if ((navigator as unknown as Record<string, unknown>).webdriver === true) return false;
  
  // Check for OPFS support via feature detection
  // SharedWorker with SQLite requires OPFS for cross-tab persistence
  const supportsOPFS = 'storage' in navigator && 
    typeof (navigator.storage as unknown as Record<string, unknown>)?.getDirectory === 'function';
  if (!supportsOPFS) return false;
  
  // Manual override for testing - allows disabling SharedWorker programmatically
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__MOSAIC_DISABLE_SHARED_WORKER__) return false;
  
  return true;
}

const useSharedWorker = shouldUseSharedWorker();

/**
 * Get the database worker client (singleton)
 * Uses SharedWorker so multiple tabs share the same database instance.
 * Falls back to regular Worker when SharedWorker is unavailable or in automation environments.
 */
export async function getDbClient(): Promise<Comlink.Remote<DbWorkerApi>> {
  if (api) return api;

  if (useSharedWorker) {
    const sharedWorker = new DbSharedWorkerConstructor({ name: 'mosaic-db-worker' });
    sharedWorker.onerror = (e) => log.error('SharedWorker error:', e);
    worker = sharedWorker;
    api = Comlink.wrap<DbWorkerApi>(sharedWorker.port);
  } else {
    // Fall back to regular Worker for test environments
    const regularWorker = new DbWorkerConstructor({ name: 'mosaic-db-worker' });
    regularWorker.onerror = (e) => log.error('Worker error:', e);
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
