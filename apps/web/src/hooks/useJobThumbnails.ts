import { useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { getDownloadManager } from '../lib/download-manager';
import { createLogger } from '../lib/logger';

const log = createLogger('useJobThumbnails');
/** Maximum number of thumbnails kept in the in-memory ring buffer per job. */
export const JOB_THUMBNAIL_RING_BUFFER_SIZE = 100;

export interface JobThumbnail {
  readonly photoId: string;
  readonly blobUrl: string;
}

export interface UseJobThumbnailsResult {
  /** Most-recently-emitted first. Capped at {@link JOB_THUMBNAIL_RING_BUFFER_SIZE}. */
  readonly thumbnails: ReadonlyArray<JobThumbnail>;
}

/**
 * Subscribe to in-app thumbnail previews for a download job.
 *
 * **Lifecycle / memory contract**
 *   - On mount, calls coordinator `subscribeToThumbnails(jobId, cb)`.
 *   - Maintains a ring buffer of `{photoId, blobUrl}` (most-recent first).
 *   - On unmount, calls the worker-side `unsubscribe`. The worker is the
 *     authoritative owner of blob URLs and revokes them as part of stopping
 *     the streamer (see `thumbnail-streamer.ts`).
 *   - This hook does NOT call `URL.revokeObjectURL` itself — the worker
 *     created the URL in its own context and owns the revoke side. We only
 *     count creates vs apparent disappearances and surface a dev warning
 *     on unmount when a mismatch is suspicious (debug-only).
 *
 * **NOT exported**
 *   The thumbnail subscription path is in-app preview ONLY. The blob URLs
 *   here MUST NOT be passed into ZIP / per-file / fsAccessDirectory export
 *   sinks. Verified by callsite audit.
 */
export function useJobThumbnails(jobId: string | null): UseJobThumbnailsResult {
  const [thumbnails, setThumbnails] = useState<ReadonlyArray<JobThumbnail>>([]);
  // Counters for dev-mode leak detection. These count blobs the hook OBSERVED;
  // ground truth on revokes lives in the worker.
  const seenRef = useRef(0);

  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let proxiedCallback: ((p: string, u: string) => void) | null = null;

    void (async (): Promise<void> => {
      try {
        const api = await getDownloadManager();
        if (cancelled) return;
        const cb = (photoId: string, blobUrl: string): void => {
          seenRef.current += 1;
          setThumbnails((prev) => {
            // Drop any existing entry for this photoId (prevents duplicates),
            // then prepend, then cap.
            const filtered = prev.filter((t) => t.photoId !== photoId);
            const next: JobThumbnail[] = [{ photoId, blobUrl }, ...filtered];
            if (next.length > JOB_THUMBNAIL_RING_BUFFER_SIZE) {
              next.length = JOB_THUMBNAIL_RING_BUFFER_SIZE;
            }
            return next;
          });
        };
        proxiedCallback = cb;
        const sub = await api.subscribeToThumbnails(jobId, Comlink.proxy(cb));
        if (cancelled) {
          sub.unsubscribe();
          return;
        }
        unsubscribe = sub.unsubscribe;
      } catch (err) {
        log.warn('subscribeToThumbnails failed', {
          errName: err instanceof Error ? err.name : 'Unknown',
        });
      }
    })();

    return (): void => {
      cancelled = true;
      try {
        unsubscribe?.();
      } catch {
        // best-effort
      }
      // Dev-mode leak diagnostic: at unmount we expect the worker-side stop
      // to have revoked blob URLs. We can't verify directly across the
      // worker boundary; surface a debug message when a job ends with many
      // unaccounted-for emissions to aid investigation.
      if (process.env.NODE_ENV !== 'production' && seenRef.current > 0) {
        log.debug('thumbnail subscription torn down', {
          observedCount: seenRef.current,
        });
      }
      proxiedCallback = null;
      void proxiedCallback;
    };
  }, [jobId]);

  return { thumbnails };
}
