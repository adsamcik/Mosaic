/**
 * usePhotoActions Hook
 *
 * Provides actions for photo management including delete operations.
 * Handles server API calls, local database cleanup, and cache invalidation.
 */

import { useCallback, useState } from 'react';
import { getCachedCover, releaseCover } from '../lib/album-cover-service';
import { getApi } from '../lib/api';
import { getDbClient } from '../lib/db-client';
import { releasePhoto, releaseThumbnail } from '../lib/photo-service';

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

        // 1. Delete from server
        await api.deleteManifest(manifestId);

        // 2. Delete from local database
        await db.deleteManifest(manifestId);

        // 3. Clean up caches
        cleanupPhotoCache(manifestId, albumId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete photo';
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

        // Delete each photo - we do this sequentially to avoid overwhelming the server
        // and to ensure proper error handling for each photo
        for (const manifestId of manifestIds) {
          try {
            // 1. Delete from server
            await api.deleteManifest(manifestId);

            // 2. Delete from local database
            await db.deleteManifest(manifestId);

            // 3. Clean up caches
            cleanupPhotoCache(manifestId, albumId);

            result.successCount++;
          } catch (err) {
            result.failureCount++;
            result.failedIds.push(manifestId);
            result.errors.push(
              err instanceof Error
                ? err.message
                : `Failed to delete ${manifestId}`,
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
