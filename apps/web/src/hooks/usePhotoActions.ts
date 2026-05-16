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
import { createLogger } from '../lib/logger';
import { releasePhoto, releaseThumbnail } from '../lib/photo-service';
import { signTombstone } from '../lib/tombstone-sign';

const log = createLogger('usePhotoActions');

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

        // A2 (audit "sync C2"): sign the tombstone transcript so other
        // clients verify the deletion before purging local state. The
        // current manifest is fetched from the server to get the
        // authoritative `versionCreated`; a stale local value would yield
        // a signature that visitor sync rejects. A best-effort: if signing
        // fails (no cached epoch key, network glitch, etc.), we still
        // proceed with an UNSIGNED delete so the user is not blocked, and
        // log the reason. Visitor clients then surface the row as
        // `tombstone-unsigned` and refuse to purge until it is re-deleted
        // — which is the correct fail-closed posture.
        let signedBody: Awaited<ReturnType<typeof signTombstone>> | null = null;
        try {
          const manifest = await api.getManifest(manifestId);
          signedBody = await signTombstone({
            albumId,
            photoId: manifestId,
            versionCreated: manifest.versionCreated,
          });
        } catch (signErr) {
          log.warn('Falling back to unsigned tombstone (audit sync C2)', {
            albumId,
            manifestId,
            reason: signErr instanceof Error ? signErr.message : String(signErr),
          });
        }

        // 1. Delete from server (with signed tombstone body when available)
        await api.deleteManifest(manifestId, signedBody);

        // 2. Delete stale dedup record so a re-upload is not blocked
        await contentHashDedup.deleteByPhotoId(albumId, manifestId);

        // 3. Delete from local database
        await db.deleteManifest(manifestId);

        // 4. Clean up caches
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
            // A2 (audit "sync C2"): sign per-photo (each transcript binds
            // photoId + versionCreated). Same fail-open-but-warn semantics
            // as the single-photo path: visitor sync rejects unsigned
            // tombstones, so an unsigned bulk-delete entry effectively
            // becomes a no-op on other clients until re-deleted.
            let signedBody: Awaited<ReturnType<typeof signTombstone>> | null = null;
            try {
              const manifest = await api.getManifest(manifestId);
              signedBody = await signTombstone({
                albumId,
                photoId: manifestId,
                versionCreated: manifest.versionCreated,
              });
            } catch (signErr) {
              log.warn('Falling back to unsigned tombstone in bulk delete', {
                albumId,
                manifestId,
                reason: signErr instanceof Error ? signErr.message : String(signErr),
              });
            }

            // 1. Delete from server
            await api.deleteManifest(manifestId, signedBody);

            // 2. Delete stale dedup record so a re-upload is not blocked
            await contentHashDedup.deleteByPhotoId(albumId, manifestId);

            // 3. Delete from local database
            await db.deleteManifest(manifestId);

            // 4. Clean up caches
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
