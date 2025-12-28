/**
 * Justified Photo Grid Component
 *
 * Displays photos in a Google Photos-style justified layout with virtualization.
 * Photos fill each row while maintaining their aspect ratios.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoActions } from '../../hooks/usePhotoActions';
import { usePhotos } from '../../hooks/usePhotos';
import {
  computeJustifiedLayout,
  getRowOffset,
  getTotalHeight,
  getVisibleRows,
  type JustifiedRow,
} from '../../lib/justified-layout';
import type { PhotoMeta } from '../../workers/types';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { PhotoLightbox } from './PhotoLightbox';
import { JustifiedPhotoThumbnail } from './JustifiedPhotoThumbnail';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface JustifiedPhotoGridProps {
  albumId: string;
  /** Search query to filter photos */
  searchQuery?: string;
  /** Callback when photos are deleted (for refreshing) */
  onPhotosDeleted?: () => void;
}

/**
 * Virtualized Justified Photo Grid Component
 * Uses a Google Photos-style layout with efficient rendering
 */
export function JustifiedPhotoGrid({ albumId, searchQuery, onPhotosDeleted }: JustifiedPhotoGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const { photos, isLoading, error, refetch } = usePhotos(albumId, searchQuery);
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);
  const lightbox = useLightbox(photos);
  const photoActions = usePhotoActions();
  const permissions = useAlbumPermissions();

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<PhotoMeta[] | null>(null);
  const [deleteThumbnailUrl, setDeleteThumbnailUrl] = useState<string | undefined>();

  // Measure container width on mount and resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Compute justified layout
  const rows = useMemo((): JustifiedRow[] => {
    if (containerWidth <= 0 || photos.length === 0) return [];

    return computeJustifiedLayout(photos, {
      containerWidth,
      targetRowHeight: TARGET_ROW_HEIGHT,
      gap: PHOTO_GAP,
    });
  }, [photos, containerWidth]);

  // Get total grid height
  const totalHeight = useMemo(
    () => getTotalHeight(rows, PHOTO_GAP),
    [rows]
  );

  // Get viewport height
  const viewportHeight = containerRef.current?.clientHeight ?? 800;

  // Compute visible rows for virtualization
  const { startIndex, endIndex } = useMemo(
    () => getVisibleRows(rows, scrollTop, viewportHeight, PHOTO_GAP, 2),
    [rows, scrollTop, viewportHeight]
  );

  // Handle scroll
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // Compute preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;

    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = photos[currentIdx - offset];
      const nextPhoto = photos[currentIdx + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
    }

    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, photos]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback(
    (photo: PhotoMeta) => {
      if (!selectionMode) {
        const index = photos.findIndex((p) => p.id === photo.id);
        if (index >= 0) {
          lightbox.open(index);
        }
      }
    },
    [selectionMode, lightbox, photos]
  );

  // Handle selection change for a single photo
  const handleSelectionChange = useCallback((photoId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(photoId);
      } else {
        next.delete(photoId);
      }
      return next;
    });
  }, []);

  // Toggle selection mode
  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((prev) => {
      if (prev) {
        setSelectedIds(new Set());
      }
      return !prev;
    });
  }, []);

  // Select all photos
  const selectAll = useCallback(() => {
    setSelectedIds(new Set(photos.map((p) => p.id)));
  }, [photos]);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Handle delete button click for a single photo
  const handleDeletePhoto = useCallback((photo: PhotoMeta, thumbnailUrl?: string) => {
    setDeleteTarget([photo]);
    setDeleteThumbnailUrl(thumbnailUrl);
  }, []);

  // Handle delete from lightbox
  const handleDeleteFromLightbox = useCallback(() => {
    if (lightbox.currentPhoto) {
      setDeleteTarget([lightbox.currentPhoto]);
      setDeleteThumbnailUrl(undefined);
    }
  }, [lightbox.currentPhoto]);

  // Handle bulk delete
  const handleBulkDelete = useCallback(() => {
    const selectedPhotos = photos.filter((p) => selectedIds.has(p.id));
    if (selectedPhotos.length > 0) {
      setDeleteTarget(selectedPhotos);
      setDeleteThumbnailUrl(undefined);
    }
  }, [photos, selectedIds]);

  // Confirm deletion
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
          albumId
        );
      }

      setDeleteTarget(null);
      setDeleteThumbnailUrl(undefined);
      setSelectedIds(new Set());

      if (lightbox.isOpen) {
        lightbox.close();
      }

      refetch();
      onPhotosDeleted?.();
    } catch {
      // Error is handled by usePhotoActions
    }
  }, [deleteTarget, photoActions, albumId, lightbox, refetch, onPhotosDeleted]);

  // Cancel deletion
  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteThumbnailUrl(undefined);
    photoActions.clearError();
  }, [photoActions]);

  // Loading state
  if (isLoading || keysLoading) {
    return (
      <div className="justified-grid-loading" data-testid="justified-grid-loading">
        <div className="loading-spinner" />
        <p>Loading photos...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="justified-grid-error" data-testid="justified-grid-error">
        <p>Failed to load photos: {error.message}</p>
      </div>
    );
  }

  // Empty state
  if (photos.length === 0) {
    return (
      <div className="justified-grid-empty" data-testid="justified-grid-empty">
        <div className="empty-state-icon">📷</div>
        <h3>No photos yet</h3>
        {permissions.canUpload ? (
          <p>Upload some photos to get started</p>
        ) : (
          <p>This album is empty</p>
        )}
      </div>
    );
  }

  // Get the epoch read key for the current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  const selectedCount = selectedIds.size;
  const visibleRows = rows.slice(startIndex, endIndex + 1);

  return (
    <>
      {/* Selection toolbar - only show if user can select */}
      {permissions.canSelect && (
        <div className="justified-grid-toolbar" data-testid="justified-grid-toolbar">
          <button
            className={`button-secondary ${selectionMode ? 'button-active' : ''}`}
            onClick={toggleSelectionMode}
            data-testid="selection-mode-button"
          >
            {selectionMode ? 'Cancel' : 'Select'}
          </button>

          {selectionMode && (
            <>
              <button
                className="button-secondary"
                onClick={selectAll}
                data-testid="select-all-button"
              >
                Select All
              </button>
              {selectedCount > 0 && (
                <>
                  <span className="selection-count" data-testid="selection-count">
                    {selectedCount} selected
                  </span>
                  <button
                    className="button-secondary"
                    onClick={clearSelection}
                    data-testid="clear-selection-button"
                  >
                    Clear
                  </button>
                  {permissions.canDelete && (
                    <button
                      className="button-danger"
                      onClick={handleBulkDelete}
                      data-testid="bulk-delete-button"
                    >
                      Delete ({selectedCount})
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Virtualized grid container */}
      <div
        ref={containerRef}
        className="justified-grid-container"
        onScroll={handleScroll}
        data-testid="justified-grid"
      >
        <div
          className="justified-grid-content"
          style={{ height: totalHeight, position: 'relative' }}
        >
          {visibleRows.map((row, localIndex) => {
            const rowIndex = startIndex + localIndex;
            const rowTop = getRowOffset(rows, rowIndex, PHOTO_GAP);

            return (
              <div
                key={rowIndex}
                className="justified-grid-row"
                style={{
                  position: 'absolute',
                  top: rowTop,
                  left: 0,
                  right: 0,
                  height: row.height,
                  display: 'flex',
                  gap: PHOTO_GAP,
                }}
                data-testid="justified-grid-row"
              >
                {row.photos.map(({ photo, width, height }) => {
                  const epochReadKey = epochKeys.get(photo.epochId);
                  const isSelected = selectedIds.has(photo.id);

                  return (
                    <JustifiedPhotoThumbnail
                      key={photo.id}
                      photo={photo}
                      width={width}
                      height={height}
                      epochReadKey={epochReadKey}
                      isSelected={isSelected}
                      selectionMode={selectionMode}
                      showDelete={permissions.canDelete}
                      onClick={() => handlePhotoClick(photo)}
                      onSelectionChange={(selected: boolean) =>
                        handleSelectionChange(photo.id, selected)
                      }
                      onDelete={() => handleDeletePhoto(photo)}
                    />
                  );
                })}
              </div>
            );
          })}
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
          {...(permissions.canDelete && { onDelete: handleDeleteFromLightbox })}
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
