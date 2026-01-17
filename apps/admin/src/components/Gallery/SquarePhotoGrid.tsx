import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoDelete } from '../../hooks/usePhotoDelete';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import { type PhotoItem, usePhotoStore } from '../../stores/photo-store';
import type { PhotoMeta } from '../../workers/types';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { PhotoLightbox } from './PhotoLightbox';
import { PhotoThumbnail } from './PhotoThumbnail';

/** Estimated row height for virtualization fallback */
const ROW_HEIGHT = 200;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface SquarePhotoGridProps {
  albumId: string;
  /** Photos to display (passed from Gallery) */
  photos: PhotoMeta[];
  /** Whether photos are loading */
  isLoading: boolean;
  /** Error if photo loading failed */
  error: Error | null;
  /** Function to trigger a photo refetch */
  refetch: () => void;
  /** Callback when photos are deleted (for refreshing) */
  onPhotosDeleted?: () => void;
  /** Selection state from parent (lifted up for header batch actions) */
  selection?: UseSelectionReturn;
}

/**
 * Virtualized Square Photo Grid Component
 * Uses TanStack Virtual for efficient rendering of large photo collections
 * This is the "classic" grid view with fixed aspect ratio squares.
 */
export function SquarePhotoGrid({
  albumId,
  photos,
  isLoading,
  error,
  refetch,
  onPhotosDeleted,
  selection,
}: SquarePhotoGridProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);

  // Sort photos by createdAt descending to match display order
  // This ensures lightbox navigation follows the visual order
  const sortedPhotos = useMemo(
    () =>
      [...photos].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [photos],
  );

  const lightbox = useLightbox(sortedPhotos);

  // Get photo items from store for status checking
  const getPhotoItem = usePhotoStore((state) => state.getPhoto);

  /**
   * Check if a photo is pending/syncing by looking it up in the PhotoStore.
   * Returns the PhotoItem if pending/syncing, undefined otherwise.
   */
  const getPendingPhotoItem = useCallback(
    (photo: PhotoMeta): PhotoItem | undefined => {
      const item = getPhotoItem(albumId, photo.assetId);
      if (item && (item.status === 'pending' || item.status === 'syncing')) {
        return item;
      }
      return undefined;
    },
    [getPhotoItem, albumId],
  );

  // Photo delete workflow
  const {
    deleteTarget,
    deleteThumbnailUrl,
    isDeleting,
    error: deleteError,
    handleDeletePhoto,
    handleDeleteFromLightbox,
    handleConfirmDelete,
    handleCancelDelete,
  } = usePhotoDelete({
    albumId,
    lightbox,
    selection,
    refetch,
    onPhotosDeleted,
  });

  // Use selection from props if provided (lifted state), otherwise internal state
  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedIds = selection?.selectedIds ?? new Set<string>();

  // Track container width for square aspect ratio
  const [containerWidth, setContainerWidth] = useState(0);

  // Callback ref for resize observer
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    parentRef.current = node;

    if (node) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Use contentRect for accurate inner width
          setContainerWidth(entry.contentRect.width);
        }
      });

      observer.observe(node);

      // Set initial width
      setContainerWidth(node.clientWidth || node.getBoundingClientRect().width);

      return () => observer.disconnect();
    }
  }, []);

  // Calculate responsive columns based on container width
  const columns = useMemo(() => {
    if (containerWidth <= 0) return 4; // Default/SSR
    if (containerWidth < 600) return 2; // Mobile
    if (containerWidth < 900) return 3; // Tablet
    if (containerWidth < 1500) return 4; // Desktop
    return 5; // Large screens
  }, [containerWidth]);

  const rowCount = Math.ceil(photos.length / columns);

  // Calculate row height based on column width to ensure squares
  // Subtracting gap from width to get accurate cell size
  const gap = 4;
  const cellWidth =
    containerWidth > 0
      ? (containerWidth - (columns - 1) * gap) / columns
      : ROW_HEIGHT;
  const rowHeight = cellWidth;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  // Compute preload queue for lightbox (photos around current)
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;

    // Add photos before and after current
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = sortedPhotos[currentIdx - offset];
      const nextPhoto = sortedPhotos[currentIdx + offset];
      if (prevPhoto) {
        queue.push(prevPhoto);
      }
      if (nextPhoto) {
        queue.push(nextPhoto);
      }
    }

    return queue;
  }, [
    lightbox.isOpen,
    lightbox.currentIndex,
    lightbox.currentPhoto,
    sortedPhotos,
  ]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback(
    (photo: PhotoMeta) => {
      if (!isSelectionMode) {
        // Find index in the sorted photos array (matches display order)
        const index = sortedPhotos.findIndex((p) => p.id === photo.id);
        if (index >= 0) {
          lightbox.open(index);
        }
      }
    },
    [isSelectionMode, lightbox, sortedPhotos],
  );

  // Handle selection change for a single photo
  const handleSelectionChange = useCallback(
    (photoId: string, selected: boolean) => {
      if (selection) {
        if (selected) {
          selection.selectPhoto(photoId);
        } else {
          selection.deselectPhoto(photoId);
        }
      }
    },
    [selection],
  );

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

  if (photos.length === 0) {
    return (
      <div className="photo-grid-empty">
        <div className="empty-state-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
        </div>
        <h3>No photos yet</h3>
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
      <div
        ref={containerRef}
        className={`photo-grid-container ${isSelectionMode ? 'photo-grid-selection-mode' : ''}`}
        data-testid="photo-grid"
      >
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
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: '4px',
              }}
            >
              {Array.from({ length: columns }).map((_, colIndex) => {
                const photoIndex = virtualRow.index * columns + colIndex;
                const photo = photos[photoIndex];
                if (!photo) return null;

                // Check if this photo is pending/syncing in the PhotoStore
                const pendingItem = getPendingPhotoItem(photo);

                if (pendingItem) {
                  // Render pending photo with progress overlay
                  const progress = pendingItem.uploadProgress ?? 0;
                  const isUploading = progress > 0 && progress < 1;
                  const statusText = pendingItem.error
                    ? 'Error'
                    : isUploading
                      ? 'Uploading...'
                      : pendingItem.status === 'syncing'
                        ? 'Finalizing...'
                        : 'Queued';
                  const displayProgress = isUploading
                    ? 20 + progress * 70
                    : pendingItem.status === 'syncing'
                      ? 95
                      : 0;

                  return (
                    <div
                      key={photo.id}
                      className="photo-thumbnail photo-thumbnail-pending"
                      data-testid="pending-photo-thumbnail"
                    >
                      <div className="photo-content">
                        {(pendingItem.localBlobUrl || photo.thumbnail) && (
                          <img
                            src={
                              pendingItem.localBlobUrl ??
                              (photo.thumbnail
                                ? `data:image/jpeg;base64,${photo.thumbnail}`
                                : undefined)
                            }
                            alt={photo.filename}
                            className="photo-image"
                            style={{
                              opacity: 0.7,
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                            }}
                          />
                        )}
                        <div className="upload-overlay">
                          {displayProgress > 0 ? (
                            <div className="upload-progress-container">
                              <div
                                className={`upload-progress-bar ${progress === 0 ? 'encrypting' : ''}`}
                                style={{ width: `${displayProgress}%` }}
                              />
                            </div>
                          ) : (
                            !pendingItem.error && (
                              <div className="upload-queued-badge"></div>
                            )
                          )}
                          <span className="upload-status-text">
                            {statusText}
                          </span>
                        </div>
                      </div>
                      {pendingItem.error && (
                        <div className="photo-error-overlay">
                          <span className="error-icon">⚠️</span>
                        </div>
                      )}
                    </div>
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
                    onClick={() => handlePhotoClick(photo)}
                    isSelected={isSelected}
                    onSelectionChange={(selected: boolean) =>
                      handleSelectionChange(photo.id, selected)
                    }
                    onDelete={(thumbnailUrl) =>
                      handleDeletePhoto(photo, thumbnailUrl)
                    }
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
          isDeleting={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          error={deleteError}
        />
      )}
    </>
  );
}
