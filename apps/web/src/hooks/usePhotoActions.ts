/**
 * usePhotoActions Hook
 *
 * Provides actions for photo management including delete operations.
 * Handles server API calls, local database cleanup, and cache invalidation.
 */

import { useCallback, useState } from 'react';
import { getCachedCover, releaseCover } from '../lib/album-cover-service';
import { getApi } from '../lib/api';
import { ContentHashDedup } from '../lib/content-hash';
import { getDbClient } from '../lib/db-client';
import { toSafeErrorMessage } from '../lib/error-messages';
import { releasePhoto, releaseThumbnail } from '../lib/photo-service';
import { signTombstone } from '../lib/tombstone-sign';

/**
 * Error thrown when photo deletion fails
 */
export class PhotoDeleteError extends Error {
  constructor(
    message: string,
    public readonly manifestId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'PhotoDeleteError';
  }
}

/**
 * Result of a bulk delete operation
 */
export interface BulkDeleteResult {
  /** Number of photos successfully deleted */
  successCount: number;
  /** Number of photos that failed to delete */
  failureCount: number;
  /** IDs of photos that failed to delete */
  failedIds: string[];
  /** Error messages for failed deletions */
  errors: string[];
}

/**
 * State returned by usePhotoActions hook
 */
export interface UsePhotoActionsResult {
  /** Delete a single photo by manifest ID */
  deletePhoto: (manifestId: string, albumId: string) => Promise<void>;
  /** Delete multiple photos by manifest IDs */
  deletePhotos: (
    manifestIds: string[],
    albumId: string,
  ) => Promise<BulkDeleteResult>;
  /** Whether a delete operation is in progress */
  isDeleting: boolean;
  /** Current error message if any */
  error: string | null;
  /** Clear the current error */
  clearError: () => void;
}

const MANIFEST_SEQUENCE_STALE_RETRY_LIMIT = 1;

function isManifestSequenceStaleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    readonly status?: unknown;
    readonly problem?: unknown;
  };
  if (
    record.status !== 409 ||
    typeof record.problem !== 'object' ||
    record.problem === null
  ) {
    return false;
  }
  return (
    (record.problem as { readonly code?: unknown }).code ===
    'MANIFEST_SEQUENCE_STALE'
  );
}

async function deleteManifestWithSignedTombstone(input: {
  readonly manifestId: string;
  readonly albumId: string;
  readonly versionCreated: number;
}): Promise<void> {
  const api = getApi();
  const operationId = globalThis.crypto.randomUUID();

  for (
    let staleRetry = 0;
    staleRetry <= MANIFEST_SEQUENCE_STALE_RETRY_LIMIT;
    staleRetry += 1
  ) {
    const signedBody = await signTombstone({
      albumId: input.albumId,
      photoId: input.manifestId,
      versionCreated: input.versionCreated,
      operationId,
    });

    try {
      await api.deleteManifest(input.manifestId, signedBody);
      return;
    } catch (error) {
      if (
        !isManifestSequenceStaleError(error) ||
        staleRetry === MANIFEST_SEQUENCE_STALE_RETRY_LIMIT
      ) {
        throw error;
      }
    }
  }

  throw new Error('Tombstone sequence retry loop exhausted unexpectedly');
}

/**
 * Hook for photo management actions
 *
 * Provides methods to delete photos from server and local storage,
 * with automatic cache cleanup.
 */
export function usePhotoActions(): UsePhotoActionsResult {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Clean up all caches for a deleted photo
   */
  const cleanupPhotoCache = useCallback((photoId: string, albumId: string) => {
    // Release photo from photo cache
    releasePhoto(photoId);
    // Also release full-resolution version
    releasePhoto(`${photoId}:full`);
    // Release thumbnail
    releaseThumbnail(photoId);

    // Check if this photo was the album cover and clear if so
    const cachedCover = getCachedCover(albumId);
    if (cachedCover?.photoId === photoId) {
      releaseCover(albumId);
    }
  }, []);

  /**
   * Delete a single photo
   */
  const deletePhoto = useCallback(
    async (manifestId: string, albumId: string): Promise<void> => {
      setIsDeleting(true);
      setError(null);

      try {
        const api = getApi();
        const db = await getDbClient();
        const contentHashDedup = new ContentHashDedup();

        // A reservation-backed v2 tombstone is mandatory. The signature
        // binds the server-authoritative pre-delete version; if fetching,
        // reserving, or signing fails, deletion fails closed.
        const manifest = await api.getManifest(manifestId);
        await deleteManifestWithSignedTombstone({
          manifestId,
          albumId,
          versionCreated: manifest.versionCreated,
        });

        // 1. Delete stale dedup record so a re-upload is not blocked
        await contentHashDedup.deleteByPhotoId(albumId, manifestId);

        // 2. Delete from local database
        await db.deleteManifest(manifestId);

        // 3. Clean up caches
        cleanupPhotoCache(manifestId, albumId);
      } catch (err) {
        const message = toSafeErrorMessage(err, 'Failed to delete photo');
        setError(message);
        throw new PhotoDeleteError(
          message,
          manifestId,
          err instanceof Error ? err : undefined,
        );
      } finally {
        setIsDeleting(false);
      }
    },
    [cleanupPhotoCache],
  );

  /**
   * Delete multiple photos (bulk delete)
   */
  const deletePhotos = useCallback(
    async (
      manifestIds: string[],
      albumId: string,
    ): Promise<BulkDeleteResult> => {
      setIsDeleting(true);
      setError(null);

      const result: BulkDeleteResult = {
        successCount: 0,
        failureCount: 0,
        failedIds: [],
        errors: [],
      };

      try {
        const api = getApi();
        const db = await getDbClient();
        const contentHashDedup = new ContentHashDedup();

        // Delete each photo - we do this sequentially to avoid overwhelming the server
        // and to ensure proper error handling for each photo
        for (const manifestId of manifestIds) {
          try {
            // Each photo needs its own signed sequence and pre-delete version.
            // A signing failure is recorded for that item without deleting it.
            const manifest = await api.getManifest(manifestId);
            await deleteManifestWithSignedTombstone({
              manifestId,
              albumId,
              versionCreated: manifest.versionCreated,
            });

            // 1. Delete stale dedup record so a re-upload is not blocked
            await contentHashDedup.deleteByPhotoId(albumId, manifestId);

            // 2. Delete from local database
            await db.deleteManifest(manifestId);

            // 3. Clean up caches
            cleanupPhotoCache(manifestId, albumId);

            result.successCount++;
          } catch (err) {
            result.failureCount++;
            result.failedIds.push(manifestId);
            result.errors.push(
              toSafeErrorMessage(err, `Failed to delete ${manifestId}`),
            );
          }
        }

        if (result.failureCount > 0) {
          const errorMessage =
            result.failureCount === manifestIds.length
              ? 'Failed to delete all photos'
              : `Failed to delete ${result.failureCount} of ${manifestIds.length} photos`;
          setError(errorMessage);
        }

        return result;
      } finally {
        setIsDeleting(false);
      }
    },
    [cleanupPhotoCache],
  );

  /**
   * Clear the current error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    deletePhoto,
    deletePhotos,
    isDeleting,
    error,
    clearError,
  };
}
