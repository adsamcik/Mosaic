import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadPhoto,
  releasePhoto,
  type PhotoLoadResult,
} from '../lib/photo-service';
import { createLogger } from '../lib/logger';

const log = createLogger('useThumbnailShard');

/** Loading state for a thumbnail shard */
export type ThumbnailShardState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number }
  | { status: 'loaded'; result: PhotoLoadResult }
  | { status: 'error'; error: Error };

export interface UseThumbnailShardOptions {
  /** Photo ID */
  photoId: string;
  /** Shard IDs for this photo */
  shardIds: string[];
  /** MIME type of the photo */
  mimeType: string;
  /** Whether an embedded thumbnail exists */
  hasThumbnail: boolean;
  /** Epoch read key for decryption */
  epochReadKey: Uint8Array | undefined;
  /** Whether to load full resolution shards */
  loadFullResolution?: boolean;
}

export interface UseThumbnailShardResult {
  /** Current loading state */
  state: ThumbnailShardState;
  /** Retry loading after an error */
  handleRetry: () => void;
}

/**
 * Hook that manages shard loading lifecycle for photo thumbnails.
 *
 * Determines whether shards need loading (no embedded thumbnail or full
 * resolution requested), downloads + decrypts via the photo service,
 * tracks progress, and cleans up on unmount.
 */
export function useThumbnailShard({
  photoId,
  shardIds,
  mimeType,
  hasThumbnail,
  epochReadKey,
  loadFullResolution = false,
}: UseThumbnailShardOptions): UseThumbnailShardResult {
  const [state, setState] = useState<ThumbnailShardState>({ status: 'idle' });

  const shouldLoadShards = useMemo(() => {
    const hasShards = epochReadKey && shardIds && shardIds.length > 0;
    if (!hasShards) return false;
    return !hasThumbnail || loadFullResolution;
  }, [epochReadKey, shardIds, hasThumbnail, loadFullResolution]);

  useEffect(() => {
    if (!shouldLoadShards || !epochReadKey) {
      return;
    }

    let cancelled = false;

    async function load() {
      setState({ status: 'loading', progress: 0 });

      try {
        const result = await loadPhoto(
          photoId,
          shardIds,
          epochReadKey!,
          mimeType,
          {
            onProgress: (loaded, total) => {
              if (!cancelled) {
                const progress = total > 0 ? loaded / total : 0;
                setState({ status: 'loading', progress });
              }
            },
          },
        );

        if (!cancelled) {
          setState({ status: 'loaded', result });
        }
      } catch (error) {
        log.error(`Photo ${photoId} load failed:`, error);
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      releasePhoto(photoId);
    };
  }, [photoId, shardIds, mimeType, epochReadKey, shouldLoadShards]);

  const handleRetry = useCallback(() => {
    if (epochReadKey && shardIds?.length > 0) {
      setState({ status: 'idle' });
      loadPhoto(photoId, shardIds, epochReadKey, mimeType, {
        skipCache: true,
      })
        .then((result) => setState({ status: 'loaded', result }))
        .catch((error) => setState({ status: 'error', error }));
    }
  }, [photoId, shardIds, mimeType, epochReadKey]);

  return { state, handleRetry };
}
