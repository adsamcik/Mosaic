import * as Comlink from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadAlbumAsZip, supportsFileSystemAccess, type AlbumDownloadProgress, type AlbumDownloadResolver } from '../lib/album-download-service';
import { createLogger } from '../lib/logger';
import { useWakeLock } from './useWakeLock';
import { useDownloadManager } from './useDownloadManager';
import { defaultSaveTargetProvider } from '../lib/save-target-bridge';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import type {
  CoordinatorWorkerApi,
  DownloadOutputMode,
  JobProgressEvent,
  PhotoMeta,
  StartJobInput,
} from '../workers/types';

const log = createLogger('useAlbumDownload');

/**
 * MIGRATION TRAJECTORY
 * --------------------
 * The legacy `downloadAlbumAsZip` flow (album-download-service.ts) is preserved
 * as the share-link path: when a caller injects an `AlbumDownloadResolver` it
 * goes through the legacy flow because the new coordinator-driven path needs
 * authenticated epoch handles and the share-link visitor-tray UX is still
 * being designed. Once `p2-spike-visitor-tray` lands, the share-link branch
 * will also move to the coordinator and the legacy service can be retired.
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
   * - Share-link path (resolver provided): uses the legacy streaming ZIP flow;
   *   `mode` is ignored.
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
  /** Share-link resolver. Triggers the legacy path. */
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
      // Legacy path when an explicit resolver is provided (share-link viewer)
      // OR when the coordinator is not ready (back-compat for existing call sites
      // and tests that do not stand up a worker).
      const useLegacy = options?.resolveOriginal !== undefined || manager.api === null;
      if (useLegacy) {
        await runLegacyDownload({
          albumId,
          albumName,
          photos,
          ...(options?.resolveOriginal ? { resolveOriginal: options.resolveOriginal } : {}),
          onProgress: setProgress,
          signal: abortController.signal,
        });
        return;
      }

      const api = manager.api;
      if (api === null) {
        // Should be unreachable due to useLegacy guard above.
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

  // Register the default save-target provider once the manager is ready.
  useEffect(() => {
    if (manager.api === null) return undefined;
    const api = manager.api;
    void api.setSaveTargetProvider(Comlink.proxy(defaultSaveTargetProvider));
    return (): void => {
      void api.setSaveTargetProvider(null).catch(() => undefined);
    };
  }, [manager.api]);

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

interface LegacyArgs {
  readonly albumId: string;
  readonly albumName: string;
  readonly photos: PhotoMeta[];
  readonly resolveOriginal?: AlbumDownloadResolver;
  readonly onProgress: (p: AlbumDownloadProgress) => void;
  readonly signal: AbortSignal;
}

async function runLegacyDownload(args: LegacyArgs): Promise<void> {
  await downloadAlbumAsZip({
    albumId: args.albumId,
    albumName: args.albumName,
    photos: args.photos,
    onProgress: args.onProgress,
    signal: args.signal,
    ...(args.resolveOriginal ? { resolveOriginal: args.resolveOriginal } : {}),
  });
}

interface CoordinatorArgs {
  readonly api: CoordinatorWorkerApi;
  readonly albumId: string;
  readonly albumName: string;
  readonly photos: PhotoMeta[];
  readonly mode: DownloadOutputMode;
  readonly onJobProgress: (event: JobProgressEvent) => void;
  readonly signal: AbortSignal;
  readonly activeJobIdRef: { current: string | null };
}

async function runCoordinatorDownload(args: CoordinatorArgs): Promise<void> {
  const planInput = await photosToPlanInput(args.albumId, args.photos);
  // If the suggested filename came from the album, append .zip when needed.
  const suggestedFileName = args.mode.kind === 'zip' ? args.mode.fileName : `${args.albumName}.zip`;
  const startInput: StartJobInput = args.mode.kind === 'zip'
    ? { ...planInput, outputMode: { kind: 'zip', fileName: suggestedFileName } }
    : { ...planInput, outputMode: args.mode };

  const { jobId } = await args.api.startJob(startInput);
  args.activeJobIdRef.current = jobId;
  await waitForTerminal(args.api, jobId, args.signal, args.onJobProgress);
}

function isTerminalPhase(phase: JobProgressEvent['phase']): boolean {
  return phase === 'Done' || phase === 'Errored' || phase === 'Cancelled';
}

async function waitForTerminal(
  api: CoordinatorWorkerApi,
  jobId: string,
  signal: AbortSignal,
  onJobProgress: (event: JobProgressEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const onAbort = (): void => {
      unsubscribe?.();
      reject(new DOMException('Download aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    api.subscribe(jobId, Comlink.proxy((event: JobProgressEvent) => {
      onJobProgress(event);
      if (isTerminalPhase(event.phase)) {
        signal.removeEventListener('abort', onAbort);
        unsubscribe?.();
        if (event.phase === 'Done') resolve();
        else if (event.phase === 'Cancelled') reject(new DOMException('Download cancelled', 'AbortError'));
        else reject(new Error(`Download failed: ${event.phase}`));
      }
    })).then((subscription) => {
      unsubscribe = subscription.unsubscribe;
      if (signal.aborted) {
        unsubscribe();
        // onAbort already rejected.
      }
    }).catch((err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Convert PhotoMeta records into the Rust download-plan input.
 *
 * Resolves the per-photo epoch (needed for tier-3 shard fetch) by reusing the
 * same helper as the legacy flow. Photos without tier-3 shards are skipped.
 */
async function photosToPlanInput(albumId: string, photos: ReadonlyArray<PhotoMeta>): Promise<{
  readonly albumId: string;
  readonly photos: ReadonlyArray<{
    readonly photoId: string;
    readonly filename: string;
    readonly shards: ReadonlyArray<{
      readonly shardId: Uint8Array;
      readonly epochId: number;
      readonly tier: number;
      readonly expectedHash: Uint8Array;
      readonly declaredSize: number;
    }>;
  }>;
}> {
  const out: Array<{
    readonly photoId: string;
    readonly filename: string;
    readonly shards: ReadonlyArray<{
      readonly shardId: Uint8Array;
      readonly epochId: number;
      readonly tier: number;
      readonly expectedHash: Uint8Array;
      readonly declaredSize: number;
    }>;
  }> = [];
  for (const photo of photos) {
    const shardIds = photo.originalShardIds ?? (photo.shardIds.length > 2 ? photo.shardIds.slice(2) : photo.shardIds);
    if (shardIds.length === 0) continue;
    const hashes = photo.originalShardHashes ?? (photo.shardHashes && photo.shardHashes.length > 2 ? photo.shardHashes.slice(2) : []);
    // Trigger epoch warm-up so the coordinator's per-photo task hits a primed cache.
    void getOrFetchEpochKey(albumId, photo.epochId).catch(() => undefined);
    out.push({
      photoId: photo.id,
      filename: photo.filename || `photo-${photo.id.slice(0, 8)}.jpg`,
      shards: shardIds.map((id, i) => ({
        shardId: hexToBytes(id),
        epochId: photo.epochId,
        tier: 3,
        expectedHash: hashes[i] !== undefined ? hexToBytes(hashes[i]!) : new Uint8Array(32),
        declaredSize: 0,
      })),
    });
  }
  return { albumId, photos: out };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

