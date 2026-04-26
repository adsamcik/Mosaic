import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useGridSelection } from '../../hooks/useGridSelection';
import { useLightbox } from '../../hooks/useLightbox';
import { useLightboxPreload } from '../../hooks/useLightboxPreload';
import { usePhotoDelete } from '../../hooks/usePhotoDelete';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import { type PhotoItem, usePhotoStore } from '../../stores/photo-store';
import type { PhotoMeta } from '../../workers/types';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { PhotoLightbox } from './PhotoLightbox';
import { PhotoThumbnail } from './PhotoThumbnail';

/** Estimated row height for virtualization fallback */
const ROW_HEIGHT = 200;



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
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Store ResizeObserver instance so we can clean it up
  const observerRef = useRef<ResizeObserver | null>(null);

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

  // Memoized list of sorted photo IDs for range selection
  const sortedPhotoIds = useMemo(
    () => sortedPhotos.map((p) => p.id),
    [sortedPhotos],
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

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Use contentRect for accurate inner width
          setContainerWidth(entry.contentRect.width);
        }
      });

      observer.observe(node);
      observerRef.current = observer;

      // Set initial width
      setContainerWidth(node.clientWidth || node.getBoundingClientRect().width);
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

  const rowCount = Math.ceil(sortedPhotos.length / columns);

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

  const preloadQueue = useLightboxPreload({
    isOpen: lightbox.isOpen,
    currentIndex: lightbox.currentIndex,
    navigationDirection: lightbox.navigationDirection,
    photos: sortedPhotos,
  });

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
  // Supports shift-click for range selection
  const handleSelectionChange = useGridSelection({
    selection,
    sortedPhotoIds,
  });

  if (isLoading || keysLoading) {
    return (
      <div className="photo-grid-loading">
        <div className="loading-spinner" />
        <p>{t('gallery.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="photo-grid-error">
        <p>
          {t('gallery.error.loadFailed')}: {error.message}
        </p>
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
        <h3>{t('gallery.gridView.emptyTitle')}</h3>
        <p className="text-muted">{t('gallery.gridView.emptyDescription')}</p>
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
                  const photo = sortedPhotos[photoIndex];
                  if (!photo) return null;

                  // Check if this photo is pending/syncing in the PhotoStore
                  const pendingItem = getPendingPhotoItem(photo);

                  if (pendingItem) {
                    // Render pending photo with progress overlay
                    const progress = pendingItem.uploadProgress ?? 0;
                    const isUploading = progress > 0 && progress < 1;
                    const isSyncing = pendingItem.status === 'syncing';
                    const isEncrypting =
                      progress === 0 && !isSyncing && !pendingItem.error;
                    const displayProgress = isUploading
                      ? 20 + progress * 70
                      : isSyncing
                        ? 95
                        : isEncrypting
                          ? 15
                          : 0;

                    const progressBarClass = isEncrypting
                      ? 'encrypting'
                      : isSyncing
                        ? 'syncing'
                        : '';

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
                                opacity: 0.8,
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                filter: 'brightness(0.9)',
                              }}
                            />
                          )}
                          <div className="upload-overlay">
                            <div className="upload-progress-container">
                              <div
                                className={`upload-progress-bar ${progressBarClass}`}
                                style={{ width: `${displayProgress}%` }}
                              />
                            </div>
                            {pendingItem.error ? (
                              <span className="upload-status upload-status--error">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="15" y1="9" x2="9" y2="15" />
                                  <line x1="9" y1="9" x2="15" y2="15" />
                                </svg>
                                <span>{t('upload.failed')}</span>
                              </span>
                            ) : isSyncing ? (
                              <span className="upload-status upload-status--syncing">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polyline points="23 4 23 10 17 10" />
                                  <polyline points="1 20 1 14 7 14" />
                                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                                <span>{t('gallery.gridView.syncing')}</span>
                              </span>
                            ) : isEncrypting ? (
                              <span className="upload-status upload-status--encrypting">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <rect
                                    x="3"
                                    y="11"
                                    width="18"
                                    height="11"
                                    rx="2"
                                    ry="2"
                                  />
                                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                                <span>{t('upload.encrypting')}</span>
                              </span>
                            ) : isUploading ? (
                              <span className="upload-status upload-status--uploading">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="17 8 12 3 7 8" />
                                  <line x1="12" y1="3" x2="12" y2="15" />
                                </svg>
                                <span>{Math.round(progress * 100)}%</span>
                              </span>
                            ) : (
                              <span className="upload-status upload-status--queued">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                                <span>{t('gallery.gridView.queued')}</span>
                              </span>
                            )}
                          </div>
                        </div>
                        {pendingItem.error && (
                          <div className="photo-error-overlay">
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="white"
                              strokeWidth="2"
                            >
                              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                          </div>
                        )}
                      </div>
                    );
                  }

                  const epochReadKey = epochKeys.get(photo.epochId);
                  const isSelected = selectedIds.has(photo.id);

                  return (
                    <PhotoThumbnail
                      key={photo.id}
                      photo={photo}
                      {...(epochReadKey && { epochReadKey })}
                      onClick={() => handlePhotoClick(photo)}
                      isSelected={isSelected}
                      onSelectionChange={(selected, event) =>
                        handleSelectionChange(photo.id, selected, event)
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
