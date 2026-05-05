import { useCallback, useMemo, useRef, useState } from 'react';
import { createLogger } from '../lib/logger';
import { supportsFileSystemAccess } from '../lib/album-download-service';
import { useDownloadManager } from './useDownloadManager';
import { useWakeLock } from './useWakeLock';
import { runCoordinatorDownload } from './coordinator-download-runner';
import { createShareLinkSourceStrategy } from '../workers/coordinator/source-strategy-sharelink';
import type {
  DownloadOutputMode,
  JobProgressEvent,
  LinkDecryptionKey,
  PhotoMeta,
} from '../workers/types';

const log = createLogger('useVisitorAlbumDownload');

export interface UseVisitorAlbumDownloadOptions {
  /** Share-link id (URL path segment). */
  readonly linkId: string;
  /** Optional per-grant token sent as `X-Share-Grant`; null when absent. */
  readonly grantToken: string | null;
  /**
   * Resolve the tier-3 `LinkDecryptionKey` for the given epoch.
   * Visitor downloads are tier-3-only by design; callers MUST already gate
   * the UI on `accessTier === FULL` before invoking this hook's download.
   * Returning `undefined` is treated as access revoked.
   */
  readonly getTier3Key: (epochId: number) => LinkDecryptionKey | undefined;
}

export interface UseVisitorAlbumDownloadResult {
  readonly isDownloading: boolean;
  readonly jobProgress: JobProgressEvent | null;
  readonly error: Error | null;
  /**
   * Start a coordinator-driven download via the share-link `SourceStrategy`.
   *
   * The caller picks `mode` via `useAlbumDownloadModePicker` (configure it
   * with `hideKeepOffline` for visitors — keepOffline requires a per-account
   * scope that anonymous viewers lack).
   */
  readonly startDownload: (
    albumId: string,
    albumName: string,
    photos: ReadonlyArray<PhotoMeta>,
    mode: DownloadOutputMode,
  ) => Promise<void>;
  readonly cancel: () => void;
  readonly supportsStreaming: boolean;
}

/**
 * Coordinator-driven download hook for anonymous share-link (visitor)
 * viewers.
 *
 * Mirrors {@link useAlbumDownload} but always constructs a `share-link`
 * `SourceStrategy` so the coordinator pipeline fetches shards through
 * `/api/s/{linkId}/shards/{shardId}` and resolves per-epoch keys from the
 * caller-supplied tier-3 key lookup.
 *
 * Out-of-scope follow-ups (NOT implemented here):
 *   - `p3-visitor-job-scope`        — per-link OPFS scope key
 *   - `p3-visitor-resume-prompt`    — visitor-aware resume UX
 *   - `p3-visitor-gc`               — GC of abandoned visitor jobs
 *   - `p3-visitor-broadcast-scope`  — cross-tab scope filtering
 *   - `p3-visitor-disclosure`       — pre-download disclosure prompt
 *   - `p3-visitor-revoked-ux`       — distinct UX for revoked links
 */
export function useVisitorAlbumDownload(
  opts: UseVisitorAlbumDownloadOptions,
): UseVisitorAlbumDownloadResult {
  const { linkId, grantToken, getTier3Key } = opts;
  const [isDownloading, setIsDownloading] = useState(false);
  const [jobProgress, setJobProgress] = useState<JobProgressEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const { acquire: acquireWakeLock, release: releaseWakeLock } = useWakeLock();
  const manager = useDownloadManager();

  // Build the strategy lazily per-call so `getTier3Key` and `grantToken`
  // changes reflect immediately without remounting.
  const sourceFactory = useMemo(
    () => () => createShareLinkSourceStrategy({
      linkId,
      ...(grantToken !== null ? { grantToken } : {}),
      getTierKey: getTier3Key,
    }),
    [linkId, grantToken, getTier3Key],
  );

  const cancel = useCallback((): void => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const jobId = activeJobIdRef.current;
    activeJobIdRef.current = null;
    if (jobId !== null && manager.api !== null) {
      void manager.cancelJob(jobId, { soft: false }).catch((err) => {
        log.warn('Failed to cancel visitor coordinator job', {
          errorName: err instanceof Error ? err.name : 'Unknown',
        });
      });
    }
  }, [manager]);

  const startDownload = useCallback(async (
    albumId: string,
    albumName: string,
    photos: ReadonlyArray<PhotoMeta>,
    mode: DownloadOutputMode,
  ): Promise<void> => {
    if (isDownloading) return;
    setIsDownloading(true);
    setError(null);
    setJobProgress(null);
    void acquireWakeLock();

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const api = manager.api;
      if (api === null) {
        throw new Error('Visitor download coordinator is not ready');
      }
      await runCoordinatorDownload({
        api,
        albumId,
        albumName,
        photos: [...photos],
        mode,
        source: sourceFactory(),
        onJobProgress: setJobProgress,
        signal: abortController.signal,
        activeJobIdRef,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info('Visitor download cancelled by user');
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // ZK-safe: log only error name, not link id or grant token.
      log.error('Visitor album download failed', { errorName: e.name });
      setError(e);
    } finally {
      setIsDownloading(false);
      void releaseWakeLock();
      abortControllerRef.current = null;
      activeJobIdRef.current = null;
    }
  }, [acquireWakeLock, isDownloading, manager, releaseWakeLock, sourceFactory]);

  return {
    isDownloading,
    jobProgress,
    error,
    startDownload,
    cancel,
    supportsStreaming: typeof window !== 'undefined' && supportsFileSystemAccess(),
  };
}
