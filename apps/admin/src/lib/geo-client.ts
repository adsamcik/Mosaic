import * as Comlink from 'comlink';
import type { GeoWorkerApi } from '../workers/types';

let worker: Worker | null = null;
let api: Comlink.Remote<GeoWorkerApi> | null = null;

/**
 * Get the geo worker client (singleton)
 * Uses dedicated Worker for map clustering calculations
 */
export async function getGeoClient(): Promise<Comlink.Remote<GeoWorkerApi>> {
  if (api) return api;

  worker = new Worker(
    new URL('../workers/geo.worker.ts', import.meta.url),
    { type: 'module', name: 'mosaic-geo-worker' }
  );

  api = Comlink.wrap<GeoWorkerApi>(worker);
  return api;
}

/**
 * Close the geo worker
 */
export function closeGeoClient(): void {
  api = null;
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
