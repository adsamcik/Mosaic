import { useCallback, useRef, useState } from 'react';
import { downloadAlbumAsZip, supportsFileSystemAccess, type AlbumDownloadProgress, type AlbumDownloadResolver } from '../lib/album-download-service';
import { createLogger } from '../lib/logger';
import { useWakeLock } from './useWakeLock';
import { useDownloadManager } from './useDownloadManager';
import { runCoordinatorDownload } from './coordinator-download-runner';
import type {
  DownloadOutputMode,
  JobProgressEvent,
  PhotoMeta,
} from '../workers/types';

const log = createLogger('useAlbumDownload');

/**
 * MIGRATION TRAJECTORY
 * --------------------
 * The legacy `downloadAlbumAsZip` flow (album-download-service.ts) is preserved
 * as a back-compat fallback when the coordinator manager is not ready. The
 * share-link visitor flow now lives in `useVisitorAlbumDownload` and goes
 * through the coordinator with a `share-link` SourceStrategy.
 */

export interface UseAlbumDownloadResult {
  /** Whether a download is currently in progress */
  readonly isDownloading: boolean;
  /** Current legacy-style progress (only populated for legacy path; coordinator path emits via DownloadTray). */
  readonly progress: AlbumDownloadProgress | null;
  /** Most recent coordinator progress event (coordinator path only; null for legacy). */
  readonly jobProgress: JobProgressEvent | null;
  /** Error from last download attempt */
  readonly error: Error | null;
  /**
   * Start downloading photos.
   *
   * - Authenticated path (no resolver): drives the coordinator worker. Caller
   *   MUST pass `mode` (typically obtained from {@link useAlbumDownloadModePicker}).
   * - Legacy fallback (resolver provided OR coordinator not ready): uses the
   *   streaming ZIP flow; `mode` is ignored.
   */
  readonly startDownload: (
    albumId: string,
    albumName: string,
    photos: PhotoMeta[],
    optionsOrResolver?: StartDownloadOptions | AlbumDownloadResolver,
  ) => Promise<void>;
  /** Cancel the current download. */
  readonly cancel: () => void;
  /** Whether the browser supports streaming downloads (File System Access API). */
  readonly supportsStreaming: boolean;
}

/** Optional parameters to {@link UseAlbumDownloadResult.startDownload}. */
export interface StartDownloadOptions {
  /** Output mode for the coordinator path. Required when no resolver is given. */
  readonly mode?: DownloadOutputMode;
  /** Legacy-flow resolver (e.g. share-link bulk path). Triggers the legacy path. */
  readonly resolveOriginal?: AlbumDownloadResolver;
}

export function useAlbumDownload(): UseAlbumDownloadResult {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<AlbumDownloadProgress | null>(null);
  const [jobProgress, setJobProgress] = useState<JobProgressEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const { acquire: acquireWakeLock, release: releaseWakeLock } = useWakeLock();
  const manager = useDownloadManager();

  const cancel = useCallback((): void => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const jobId = activeJobIdRef.current;
    activeJobIdRef.current = null;
    if (jobId !== null && manager.api !== null) {
      void manager.cancelJob(jobId, { soft: false }).catch((err) => {
        log.warn('Failed to cancel coordinator job', {
          errorName: err instanceof Error ? err.name : 'Unknown',
        });
      });
    }
  }, [manager]);

  const startDownload = useCallback(async (
    albumId: string,
    albumName: string,
    photos: PhotoMeta[],
    optionsOrResolver?: StartDownloadOptions | AlbumDownloadResolver,
  ): Promise<void> => {
    if (isDownloading) return;
    setIsDownloading(true);
    setError(null);
    setProgress(null);
    setJobProgress(null);
    void acquireWakeLock();

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Backward-compat: a bare resolver function may be passed as the 4th arg.
    const options: StartDownloadOptions | undefined = typeof optionsOrResolver === 'function'
      ? { resolveOriginal: optionsOrResolver }
      : optionsOrResolver;

    try {
      const useLegacy = options?.resolveOriginal !== undefined || manager.api === null;
      if (useLegacy) {
        await downloadAlbumAsZip({
          albumId,
          albumName,
          photos,
          onProgress: setProgress,
          signal: abortController.signal,
          ...(options?.resolveOriginal ? { resolveOriginal: options.resolveOriginal } : {}),
        });
        return;
      }

      const api = manager.api;
      if (api === null) {
        throw new Error('Download manager is not ready');
      }
      const mode = options?.mode ?? { kind: 'keepOffline' };
      await runCoordinatorDownload({
        api,
        albumId,
        albumName,
        photos,
        mode,
        onJobProgress: setJobProgress,
        signal: abortController.signal,
        activeJobIdRef,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info('Download cancelled by user');
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      log.error('Album download failed', e);
      setError(e);
    } finally {
      setIsDownloading(false);
      void releaseWakeLock();
      abortControllerRef.current = null;
      activeJobIdRef.current = null;
    }
  }, [acquireWakeLock, isDownloading, manager, releaseWakeLock]);

  return {
    isDownloading,
    progress,
    jobProgress,
    error,
    startDownload,
    cancel,
    supportsStreaming: typeof window !== 'undefined' && supportsFileSystemAccess(),
  };
}
