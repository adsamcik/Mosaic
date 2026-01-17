/**
 * usePhotoDelete Hook
 *
 * Provides a unified interface for photo deletion workflows in gallery grids.
 * Encapsulates delete target state, confirmation/cancel handlers, and
 * integrates with usePhotoActions for the actual deletion.
 *
 * This hook consolidates duplicated delete logic from PhotoGrid, SquarePhotoGrid,
 * and MosaicPhotoGrid into a single reusable implementation.
 */

import { useCallback, useState } from 'react';
import type { PhotoMeta } from '../workers/types';
import type { UseLightboxResult } from './useLightbox';
import { usePhotoActions } from './usePhotoActions';
import type { UseSelectionReturn } from './useSelection';

/**
 * Options for the usePhotoDelete hook
 */
export interface UsePhotoDeleteOptions {
  /** Album ID for the deletion context */
  albumId: string;
  /** Lightbox controls for closing after delete */
  lightbox: UseLightboxResult;
  /** Selection state for clearing after bulk delete (optional) */
  selection: UseSelectionReturn | undefined;
  /** Callback to refetch photos after deletion */
  refetch: () => void;
  /** Optional callback when photos are deleted */
  onPhotosDeleted: (() => void) | undefined;
}

/**
 * State and controls returned by usePhotoDelete hook
 */
export interface UsePhotoDeleteResult {
  /** Photos currently targeted for deletion (null if no dialog open) */
  deleteTarget: PhotoMeta[] | null;
  /** Thumbnail URL to display in delete dialog */
  deleteThumbnailUrl: string | undefined;
  /** Whether a delete operation is in progress */
  isDeleting: boolean;
  /** Current error message if deletion failed */
  error: string | null;
  /** Trigger delete dialog for a single photo */
  handleDeletePhoto: (photo: PhotoMeta, thumbnailUrl?: string) => void;
  /** Trigger delete dialog from lightbox (uses current lightbox photo) */
  handleDeleteFromLightbox: () => void;
  /** Confirm and execute the deletion */
  handleConfirmDelete: () => Promise<void>;
  /** Cancel the delete operation and close dialog */
  handleCancelDelete: () => void;
}

/**
 * Hook for managing photo deletion workflows
 *
 * Provides state management for delete dialogs and handlers for
 * triggering, confirming, and canceling photo deletions.
 *
 * @param options - Configuration options for the delete workflow
 * @returns Delete state and handler functions
 *
 * @example
 * ```tsx
 * const {
 *   deleteTarget,
 *   deleteThumbnailUrl,
 *   isDeleting,
 *   error,
 *   handleDeletePhoto,
 *   handleDeleteFromLightbox,
 *   handleConfirmDelete,
 *   handleCancelDelete,
 * } = usePhotoDelete({
 *   albumId,
 *   lightbox,
 *   selection,
 *   refetch,
 *   onPhotosDeleted,
 * });
 *
 * // In thumbnail component
 * <PhotoThumbnail onDelete={(url) => handleDeletePhoto(photo, url)} />
 *
 * // In lightbox component
 * <PhotoLightbox onDelete={handleDeleteFromLightbox} />
 *
 * // Delete confirmation dialog
 * {deleteTarget && (
 *   <DeletePhotoDialog
 *     photos={deleteTarget}
 *     thumbnailUrl={deleteThumbnailUrl}
 *     isDeleting={isDeleting}
 *     onConfirm={handleConfirmDelete}
 *     onCancel={handleCancelDelete}
 *     error={error}
 *   />
 * )}
 * ```
 */
export function usePhotoDelete({
  albumId,
  lightbox,
  selection,
  refetch,
  onPhotosDeleted,
}: UsePhotoDeleteOptions): UsePhotoDeleteResult {
  const photoActions = usePhotoActions();

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<PhotoMeta[] | null>(null);
  const [deleteThumbnailUrl, setDeleteThumbnailUrl] = useState<
    string | undefined
  >();

  /**
   * Trigger delete dialog for a single photo from thumbnail
   */
  const handleDeletePhoto = useCallback(
    (photo: PhotoMeta, thumbnailUrl?: string) => {
      setDeleteTarget([photo]);
      setDeleteThumbnailUrl(thumbnailUrl);
    },
    [],
  );

  /**
   * Trigger delete dialog from lightbox (uses current lightbox photo)
   */
  const handleDeleteFromLightbox = useCallback(() => {
    if (lightbox.currentPhoto) {
      setDeleteTarget([lightbox.currentPhoto]);
      setDeleteThumbnailUrl(undefined);
    }
  }, [lightbox.currentPhoto]);

  /**
   * Confirm and execute the deletion
   * Handles both single and bulk delete operations
   */
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteTarget.length === 0) return;

    try {
      if (deleteTarget.length === 1) {
        const photoToDelete = deleteTarget[0];
        if (photoToDelete) {
          await photoActions.deletePhoto(photoToDelete.id, albumId);
        }
      } else {
        await photoActions.deletePhotos(
          deleteTarget.map((p) => p.id),
          albumId,
        );
      }

      // Only close dialog and cleanup on success
      setDeleteTarget(null);
      setDeleteThumbnailUrl(undefined);

      // Clear selection if using lifted state
      selection?.clearSelection();

      // Close lightbox if open
      if (lightbox.isOpen) {
        lightbox.close();
      }

      // Refresh photos
      refetch();
      onPhotosDeleted?.();
    } catch (err) {
      // Error is already set in photoActions.error and displayed in DeletePhotoDialog
      // Log for debugging purposes
      console.error('[usePhotoDelete] Photo deletion failed:', err);
      // Keep dialog open so user can see the error message and retry
    }
  }, [
    deleteTarget,
    photoActions,
    albumId,
    lightbox,
    selection,
    refetch,
    onPhotosDeleted,
  ]);

  /**
   * Cancel the delete operation and close dialog
   */
  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteThumbnailUrl(undefined);
    photoActions.clearError();
  }, [photoActions]);

  return {
    deleteTarget,
    deleteThumbnailUrl,
    isDeleting: photoActions.isDeleting,
    error: photoActions.error,
    handleDeletePhoto,
    handleDeleteFromLightbox,
    handleConfirmDelete,
    handleCancelDelete,
  };
}
