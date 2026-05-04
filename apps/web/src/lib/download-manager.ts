import * as Comlink from 'comlink';
import { createLogger } from './logger';
import type { AlbumDiff, CoordinatorWorkerApi, CurrentAlbumManifest, ResumableJobSummary } from '../workers/types';

const log = createLogger('DownloadManager');

let worker: Worker | null = null;
let api: Comlink.Remote<CoordinatorWorkerApi> | null = null;
let initPromise: Promise<Comlink.Remote<CoordinatorWorkerApi>> | null = null;

/** Initialize the singleton manager (creates the worker if absent). Safe to call repeatedly. */
export async function getDownloadManager(): Promise<CoordinatorWorkerApi> {
  if (api) {
    return api;
  }
  initPromise ??= createDownloadManager();
  return initPromise;
}

/** List locally resumable jobs through the singleton coordinator worker. */
export async function listResumableJobs(): Promise<ResumableJobSummary[]> {
  const manager = await getDownloadManager();
  return manager.listResumableJobs();
}

/** Compute an album diff through the singleton coordinator worker. */
export async function computeAlbumDiff(jobId: string, current: CurrentAlbumManifest): Promise<AlbumDiff> {
  const manager = await getDownloadManager();
  return manager.computeAlbumDiff(jobId, current);
}

/** Tear down the singleton worker proxy for tests and hot-reload cleanup. */
export async function disposeDownloadManager(): Promise<void> {
  const currentApi = api;
  api = null;
  initPromise = null;
  if (currentApi) {
    currentApi[Comlink.releaseProxy]();
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

async function createDownloadManager(): Promise<Comlink.Remote<CoordinatorWorkerApi>> {
  worker = new Worker(new URL('../workers/coordinator.worker.ts', import.meta.url), {
    type: 'module',
    name: 'mosaic-download-coordinator-worker',
  });

  worker.onerror = (event: ErrorEvent): void => {
    log.error('Coordinator worker error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  };

  const remote = Comlink.wrap<CoordinatorWorkerApi>(worker);
  await remote.initialize({ nowMs: Date.now() });
  api = remote;
  return remote;
}
