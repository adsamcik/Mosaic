import { useCallback, useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import { getDownloadManager } from '../lib/download-manager';
import type {
  AlbumDiff,
  CoordinatorWorkerApi,
  CurrentAlbumManifest,
  DownloadJobsBroadcastMessage,
  DownloadPhase,
  JobSummary,
  ResumableJobSummary,
} from '../workers/types';

const log = createLogger('useDownloadManager');
const CHANNEL_NAME = 'mosaic-download-jobs';

/** React-facing download-manager state and actions. */
export interface UseDownloadManagerResult {
  readonly ready: boolean;
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly resumableJobs: ReadonlyArray<ResumableJobSummary>;
  readonly api: CoordinatorWorkerApi | null;
  readonly error: Error | null;
  /** Subscribe to a specific job and refresh jobs on progress; returns a cleanup callback. */
  subscribe(jobId: string): () => void;
  /** Pause a running job through the coordinator. */
  pauseJob(jobId: string): Promise<{ phase: DownloadPhase }>;
  /** Resume a paused job through the coordinator. */
  resumeJob(jobId: string): Promise<{ phase: DownloadPhase }>;
  /** Cancel a job through the coordinator; hard cancel discards persisted progress. */
  cancelJob(jobId: string, opts: { readonly soft: boolean }): Promise<{ phase: DownloadPhase }>;
  /** Compute a local manifest diff for a persisted download plan. */
  computeAlbumDiff(jobId: string, current: CurrentAlbumManifest): Promise<AlbumDiff>;
}

/**
 * React hook for the opt-in Phase 1 download coordinator plumbing.
 *
 * The hook initializes the singleton manager, keeps an in-memory job list fresh,
 * and observes cross-tab `mosaic-download-jobs` broadcasts without taking job ownership.
 */
export function useDownloadManager(): UseDownloadManagerResult {
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState<ReadonlyArray<JobSummary>>([]);
  const [resumableJobs, setResumableJobs] = useState<ReadonlyArray<ResumableJobSummary>>([]);
  const [api, setApi] = useState<CoordinatorWorkerApi | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const apiRef = useRef<CoordinatorWorkerApi | null>(null);

  const refreshJobs = useCallback(async (): Promise<void> => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      return;
    }
    const [nextJobs, nextResumableJobs] = await Promise.all([
      currentApi.listJobs(),
      currentApi.listResumableJobs(),
    ]);
    setJobs(nextJobs);
    setResumableJobs(nextResumableJobs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const manager = await getDownloadManager();
        if (cancelled) {
          return;
        }
        apiRef.current = manager;
        setApi(manager);
        const [initialJobs, initialResumableJobs] = await Promise.all([
          manager.listJobs(),
          manager.listResumableJobs(),
        ]);
        setJobs(initialJobs);
        setResumableJobs(initialResumableJobs);
        setReady(true);
        setError(null);
      } catch (caught) {
        const nextError = caught instanceof Error ? caught : new Error(String(caught));
        if (!cancelled) {
          setError(nextError);
          setReady(false);
        }
        log.warn('Download manager initialization failed', { errorName: nextError.name });
      }
    })();

    return (): void => {
      cancelled = true;
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') {
      return undefined;
    }
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const listener = (event: MessageEvent<unknown>): void => {
      if (!isDownloadJobsBroadcastMessage(event.data)) {
        return;
      }
      void refreshJobs();
    };
    channel.addEventListener('message', listener);
    return (): void => {
      channel.removeEventListener('message', listener);
      channel.close();
    };
  }, [refreshJobs]);

  const subscribe = useCallback((jobId: string): (() => void) => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      return (): void => undefined;
    }
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void currentApi.subscribe(jobId, Comlink.proxy((): void => {
      void refreshJobs();
    })).then((subscription) => {
      if (disposed) {
        subscription.unsubscribe();
        return;
      }
      unsubscribe = subscription.unsubscribe;
    }).catch((caught) => {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      log.warn('Download job subscription failed', { errorName: nextError.name });
    });

    return (): void => {
      disposed = true;
      unsubscribe?.();
    };
  }, [refreshJobs]);


  const requireApi = useCallback((): CoordinatorWorkerApi => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      throw new Error('Download manager is not ready');
    }
    return currentApi;
  }, []);

  const pauseJob = useCallback(async (jobId: string): Promise<{ phase: DownloadPhase }> => {
    const result = await requireApi().pauseJob(jobId);
    await refreshJobs();
    return result;
  }, [refreshJobs, requireApi]);

  const resumeJob = useCallback(async (jobId: string): Promise<{ phase: DownloadPhase }> => {
    const result = await requireApi().resumeJob(jobId);
    await refreshJobs();
    return result;
  }, [refreshJobs, requireApi]);

  const cancelJob = useCallback(async (jobId: string, opts: { readonly soft: boolean }): Promise<{ phase: DownloadPhase }> => {
    const result = await requireApi().cancelJob(jobId, opts);
    await refreshJobs();
    return result;
  }, [refreshJobs, requireApi]);

  const computeAlbumDiff = useCallback((jobId: string, current: CurrentAlbumManifest): Promise<AlbumDiff> => {
    return requireApi().computeAlbumDiff(jobId, current);
  }, [requireApi]);

  return { ready, jobs, resumableJobs, api, error, subscribe, pauseJob, resumeJob, cancelJob, computeAlbumDiff };
}

function isDownloadJobsBroadcastMessage(value: unknown): value is DownloadJobsBroadcastMessage {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && value.kind === 'job-changed'
    && 'jobId' in value
    && typeof value.jobId === 'string'
    && 'phase' in value
    && typeof value.phase === 'string'
    && 'lastUpdatedAtMs' in value
    && typeof value.lastUpdatedAtMs === 'number';
}
