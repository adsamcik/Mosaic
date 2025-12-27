import * as Comlink from 'comlink';
import type { DbWorkerApi } from '../workers/types';

let worker: SharedWorker | null = null;
let api: Comlink.Remote<DbWorkerApi> | null = null;

/**
 * Get the database worker client (singleton)
 * Uses SharedWorker so multiple tabs share the same database instance
 */
export async function getDbClient(): Promise<Comlink.Remote<DbWorkerApi>> {
  if (api) return api;

  worker = new SharedWorker(
    new URL('../workers/db.worker.ts', import.meta.url),
    { type: 'module', name: 'mosaic-db-worker' }
  );

  api = Comlink.wrap<DbWorkerApi>(worker.port);
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
    worker.port.close();
    worker = null;
  }
}
