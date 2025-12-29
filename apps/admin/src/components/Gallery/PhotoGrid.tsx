import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useUploadContext } from '../../contexts/UploadContext';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoActions } from '../../hooks/usePhotoActions';
import { usePhotos } from '../../hooks/usePhotos';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import type { PhotoMeta } from '../../workers/types';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { PendingPhotoThumbnail } from './PendingPhotoThumbnail';
import { PhotoLightbox } from './PhotoLightbox';
import { PhotoThumbnail } from './PhotoThumbnail';

/** Number of columns in the grid */
const COLUMNS = 4;

/** Estimated row height for virtualization */
const ROW_HEIGHT = 200;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface PhotoGridProps {
  albumId: string;
  /** Search query to filter photos */
  searchQuery?: string;
  /** Callback when photos are deleted (for refreshing) */
  onPhotosDeleted?: () => void;
  /** Selection state from parent (lifted up for header batch actions) */
  selection?: UseSelectionReturn;
}

/**
 * Virtualized Photo Grid Component
 * Uses TanStack Virtual for efficient rendering of large photo collections
 */
export function PhotoGrid({ albumId, searchQuery, onPhotosDeleted, selection }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { photos, isLoading, error, refetch } = usePhotos(albumId, searchQuery);
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);
  const lightbox = useLightbox(photos);
  const photoActions = usePhotoActions();
  const { activeTasks } = useUploadContext();

  // Combine real photos with pending uploads
  const displayPhotos = useMemo(() => {
    const pendingPhotos = activeTasks
      .filter(t => t.albumId === albumId)
      .map(t => ({
        id: t.id,
        assetId: t.id,
        albumId: t.albumId,
        filename: t.file.name,
        mimeType: t.file.type,
        width: t.originalWidth || t.thumbWidth || 800,
        height: t.originalHeight || t.thumbHeight || 600,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        shardIds: [],
        epochId: t.epochId,
        isPending: true, // Marker for pending state
        task: t // Reference to the full task
      } as PhotoMeta & { isPending?: boolean; task?: any }));

    return [...pendingPhotos, ...photos];
  }, [activeTasks, photos, albumId]);

  // Use selection from props if provided (lifted state), otherwise internal state
  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedIds = selection?.selectedIds ?? new Set<string>();

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<PhotoMeta[] | null>(null);
  const [deleteThumbnailUrl, setDeleteThumbnailUrl] = useState<string | undefined>();

  const rowCount = Math.ceil(displayPhotos.length / COLUMNS);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Compute preload queue for lightbox (photos around current)
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];
    
    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    
    // Add photos before and after current
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = photos[currentIdx - offset];
      const nextPhoto = photos[currentIdx + offset];
      if (prevPhoto) {
        queue.push(prevPhoto);
      }
      if (nextPhoto) {
        queue.push(nextPhoto);
      }
    }
    
    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, photos]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback((photoIndex: number) => {
    if (!isSelectionMode) {
      lightbox.open(photoIndex);
    }
  }, [isSelectionMode, lightbox]);

  // Handle selection change for a single photo
  const handleSelectionChange = useCallback((photoId: string, selected: boolean) => {
    if (selection) {
      if (selected) {
        selection.selectPhoto(photoId);
      } else {
        selection.deselectPhoto(photoId);
      }
    }
  }, [selection]);

  // Handle delete button click for a single photo
  const handleDeletePhoto = useCallback((photo: PhotoMeta, thumbnailUrl?: string) => {
    setDeleteTarget([photo]);
    setDeleteThumbnailUrl(thumbnailUrl);
  }, []);

  // Handle delete from lightbox
  const handleDeleteFromLightbox = useCallback(() => {
    if (lightbox.currentPhoto) {
      setDeleteTarget([lightbox.currentPhoto]);
      setDeleteThumbnailUrl(undefined); // Lightbox shows full image, not thumbnail
    }
  }, [lightbox.currentPhoto]);

  // Confirm deletion
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteTarget.length === 0) return;

    try {
      if (deleteTarget.length === 1) {
        // Single photo delete
        const photoToDelete = deleteTarget[0];
        if (photoToDelete) {
          await photoActions.deletePhoto(photoToDelete.id, albumId);
        }
      } else {
        // Bulk delete
        await photoActions.deletePhotos(
          deleteTarget.map(p => p.id),
          albumId
        );
      }

      // Close dialog
      setDeleteTarget(null);
      setDeleteThumbnailUrl(undefined);

      // Clear selection if using lifted state
      if (selection) {
        selection.clearSelection();
      }

      // Close lightbox if open
      if (lightbox.isOpen) {
        lightbox.close();
      }

      // Refresh photos
      refetch();
      onPhotosDeleted?.();
    } catch {
      // Error is handled by usePhotoActions and shown in dialog
    }
  }, [deleteTarget, photoActions, albumId, lightbox, refetch, onPhotosDeleted, selection]);

  // Cancel deletion
  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteThumbnailUrl(undefined);
    photoActions.clearError();
  }, [photoActions]);

  if (isLoading || keysLoading) {
    return (
      <div className="photo-grid-loading">
        <div className="loading-spinner" />
        <p>Loading photos...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="photo-grid-error">
        <p>Failed to load photos: {error.message}</p>
      </div>
    );
  }

  if (displayPhotos.length === 0) {
    return (
      <div className="photo-grid-empty">
        <p>No photos yet</p>
        <p className="text-muted">Upload some photos to get started</p>
      </div>
    );
  }

  // Get the epoch read key for the current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  return (
    <>
      <div ref={parentRef} className="photo-grid-container" data-testid="photo-grid">
        <div
          className="photo-grid-virtual"
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              className="photo-grid-row"
              style={{
                position: 'absolute',
                top: virtualRow.start,
                height: virtualRow.size,
                width: '100%',
                display: 'grid',
                gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
                gap: '4px',
              }}
            >
              {Array.from({ length: COLUMNS }).map((_, colIndex) => {
                const photoIndex = virtualRow.index * COLUMNS + colIndex;
                const photo = displayPhotos[photoIndex];
                if (!photo) return null;

                // Check if this is a pending upload
                const pendingPhoto = photo as PhotoMeta & { isPending?: boolean; task?: any };
                if (pendingPhoto.isPending && pendingPhoto.task) {
                  return (
                    <PendingPhotoThumbnail
                      key={photo.id}
                      task={pendingPhoto.task}
                    />
                  );
                }

                // Get epoch read key for this photo
                const epochReadKey = epochKeys.get(photo.epochId);
                const isSelected = selectedIds.has(photo.id);
                return (
                  <PhotoThumbnail
                    key={photo.id}
                    photo={photo}
                    {...(epochReadKey && { epochReadKey })}
                    onClick={() => handlePhotoClick(photoIndex)}
                    isSelected={isSelected}
                    onSelectionChange={(selected: boolean) => handleSelectionChange(photo.id, selected)}
                    onDelete={(thumbnailUrl) => handleDeletePhoto(photo, thumbnailUrl)}
                    selectionMode={isSelectionMode}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Photo Lightbox */}
      {lightbox.isOpen && lightbox.currentPhoto && currentEpochReadKey && (
        <PhotoLightbox
          photo={lightbox.currentPhoto}
          epochReadKey={currentEpochReadKey}
          onClose={lightbox.close}
          onNext={lightbox.next}
          onPrevious={lightbox.previous}
          hasNext={lightbox.hasNext}
          hasPrevious={lightbox.hasPrevious}
          preloadQueue={preloadQueue}
          onDelete={handleDeleteFromLightbox}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && deleteTarget.length > 0 && (
        <DeletePhotoDialog
          photos={deleteTarget}
          thumbnailUrl={deleteThumbnailUrl}
          isDeleting={photoActions.isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          error={photoActions.error}
        />
      )}
    </>
  );
}

