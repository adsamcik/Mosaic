import * as Comlink from 'comlink';
import type { CryptoWorkerApi } from '../workers/types';

let worker: Worker | null = null;
let api: Comlink.Remote<CryptoWorkerApi> | null = null;

/**
 * Get the crypto worker client (singleton)
 * Uses dedicated Worker for cryptographic operations
 */
export async function getCryptoClient(): Promise<Comlink.Remote<CryptoWorkerApi>> {
  if (api) return api;

  worker = new Worker(
    new URL('../workers/crypto.worker.ts', import.meta.url),
    { type: 'module', name: 'mosaic-crypto-worker' }
  );

  api = Comlink.wrap<CryptoWorkerApi>(worker);
  return api;
}

/**
 * Close the crypto worker and clear keys
 */
export async function closeCryptoClient(): Promise<void> {
  if (api) {
    await api.clear();
    api = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
