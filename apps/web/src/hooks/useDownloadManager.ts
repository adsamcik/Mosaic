import { useCallback, useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import { getDownloadManager } from '../lib/download-manager';
import type {
  CoordinatorWorkerApi,
  DownloadJobsBroadcastMessage,
  JobSummary,
} from '../workers/types';

const log = createLogger('useDownloadManager');
const CHANNEL_NAME = 'mosaic-download-jobs';

/** React-facing download-manager state and actions. */
export interface UseDownloadManagerResult {
  readonly ready: boolean;
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly api: CoordinatorWorkerApi | null;
  readonly error: Error | null;
  /** Subscribe to a specific job and refresh jobs on progress; returns a cleanup callback. */
  subscribe(jobId: string): () => void;
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
  const [api, setApi] = useState<CoordinatorWorkerApi | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const apiRef = useRef<CoordinatorWorkerApi | null>(null);

  const refreshJobs = useCallback(async (): Promise<void> => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      return;
    }
    const nextJobs = await currentApi.listJobs();
    setJobs(nextJobs);
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
        setJobs(await manager.listJobs());
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

  return { ready, jobs, api, error, subscribe };
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
