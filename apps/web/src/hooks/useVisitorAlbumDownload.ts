import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { createLogger } from '../lib/logger';
import { supportsFileSystemAccess } from '../lib/album-download-service';
import { useDownloadManager } from './useDownloadManager';
import { useWakeLock } from './useWakeLock';
import { runCoordinatorDownload } from './coordinator-download-runner';
import { createShareLinkSourceStrategy } from '../workers/coordinator/source-strategy-sharelink';
import { ensureScopeKeySodiumReady, deriveVisitorScopeKey, scopeKeyPrefix } from '../lib/scope-key';
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
 * `/api/v1/s/{linkId}/shards/{shardId}` and resolves per-epoch keys from the
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

  // Re-bind any reconstructed paused-no-source visitor jobs that match
  // this share link. The coordinator strictly checks the scope-key match
  // before accepting the rebind, so a different link in another tab cannot
  // pull jobs onto the wrong visitor scope.
  useEffect(() => {
    const api = manager.api;
    if (api === null) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      await ensureScopeKeySodiumReady();
      if (cancelled) return;
      const scopeKey = deriveVisitorScopeKey(linkId, grantToken);
      const resumable = manager.resumableJobs.filter(
        (job) => job.pausedNoSource && job.scopeKey === scopeKey,
      );
      for (const job of resumable) {
        // v1.0.1 isolated-v3-10 (W-A6-6): the strategy carries function
        // members (`fetchShard`, etc.) and CANNOT be structured-cloned
        // across the coordinator-worker postMessage boundary. Wrap it in
        // `Comlink.proxy(...)` so Comlink emits a MessagePort for the
        // top-level argument instead. We release the proxy after the
        // rebind call resolves so the worker-side handle doesn't leak.
        const rebindSource = Comlink.proxy(sourceFactory()) as unknown as Parameters<
          typeof api.rebindJobSource
        >[1];
        try {
          await api.rebindJobSource(job.jobId, rebindSource);
        } catch (err) {
          // ZK-safe: log only the error name and the scope prefix; never the
          // link id, grant token, or hex tail of the scope key.
          log.warn('Visitor source rebind failed', {
            errorName: err instanceof Error ? err.name : 'Unknown',
            scopePrefix: scopeKeyPrefix(scopeKey),
          });
        } finally {
          try {
            (rebindSource as unknown as { [Comlink.releaseProxy]?: () => void })[
              Comlink.releaseProxy
            ]?.();
          } catch {
            // Best-effort release; never block rebind completion on cleanup.
          }
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [manager.api, manager.resumableJobs, linkId, grantToken, sourceFactory]);

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
      // ZK-safe: log only error name + code + message (message is a constant
      // string from the worker, contains no caller-supplied PII). Include
      // the WorkerCryptoError code when present so v1.0.1 isolated-v3-10
      // visitor-download failures can be triaged via E2E traces.
      const code =
        typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : undefined;
      log.error('Visitor album download failed', {
        errorName: e.name,
        errorCode: code,
        errorMessage: e.message,
      });
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
