/**
 * Justified Photo Grid Component
 *
 * Displays photos in a Google Photos-style justified layout with virtualization.
 * Photos fill each row while maintaining their aspect ratios.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { useUploadContext } from '../../contexts/UploadContext';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoActions } from '../../hooks/usePhotoActions';
import { usePhotos } from '../../hooks/usePhotos';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import {
    computeJustifiedLayout,
    getRowOffset,
    getTotalHeight,
    getVisibleRows,
    type JustifiedRow,
} from '../../lib/justified-layout';
import { syncEngine, type SyncEventDetail } from '../../lib/sync-engine';
import '../../styles/upload.css';
import type { PhotoMeta } from '../../workers/types';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { JustifiedPhotoThumbnail } from './JustifiedPhotoThumbnail';
import { PendingPhotoThumbnail } from './PendingPhotoThumbnail';
import { PhotoLightbox } from './PhotoLightbox';

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
  /** Selection state from parent (lifted up for header batch actions) */
  selection?: UseSelectionReturn;
}

/**
 * Virtualized Justified Photo Grid Component
 * Uses a Google Photos-style layout with efficient rendering
 */
export function JustifiedPhotoGrid({ albumId, searchQuery, onPhotosDeleted, selection }: JustifiedPhotoGridProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  
  // Store the actual container element for scroll/height access
  const containerElementRef = useRef<HTMLDivElement | null>(null);
  
  // Store ResizeObserver instance so we can clean it up
  const observerRef = useRef<ResizeObserver | null>(null);
  
  // Callback ref - called when the container element is attached/detached from DOM
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    // Store the element
    containerElementRef.current = node;
    
    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    
    if (node) {
      // Create new observer for this node
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width);
        }
      });
      
      observer.observe(node);
      observerRef.current = observer;
      
      // Set initial width
      setContainerWidth(node.clientWidth);
    }
  }, []);

  const { photos, isLoading, error, refetch } = usePhotos(albumId, searchQuery);
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);
  const lightbox = useLightbox(photos);
  const photoActions = usePhotoActions();
  const permissions = useAlbumPermissions();
  const { activeTasks } = useUploadContext();

  // Combine real photos with pending uploads
  const displayPhotos = useMemo(() => {
    const existingAssetIds = new Set(photos.map(p => p.assetId));

    const pendingPhotos = activeTasks
      .filter(t => t.albumId === albumId && !existingAssetIds.has(t.id))
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
  // This allows the header to control selection when present
  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedIds = selection?.selectedIds ?? new Set<string>();

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<PhotoMeta[] | null>(null);
  const [deleteThumbnailUrl, setDeleteThumbnailUrl] = useState<string | undefined>();

  // Listen for sync-complete events to refresh photos (e.g., after upload)
  useEffect(() => {
    const handleSyncComplete = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      if (detail.albumId === albumId) {
        refetch();
      }
    };

    syncEngine.addEventListener('sync-complete', handleSyncComplete);
    return () => {
      syncEngine.removeEventListener('sync-complete', handleSyncComplete);
    };
  }, [albumId, refetch]);

  // Compute justified layout
  const rows = useMemo((): JustifiedRow[] => {
    if (containerWidth <= 0 || displayPhotos.length === 0) return [];

    return computeJustifiedLayout(displayPhotos, {
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
  const viewportHeight = containerElementRef.current?.clientHeight ?? 800;

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
      if (!isSelectionMode) {
        const index = photos.findIndex((p) => p.id === photo.id);
        if (index >= 0) {
          lightbox.open(index);
        }
      }
    },
    [isSelectionMode, lightbox, photos]
  );

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
      setDeleteThumbnailUrl(undefined);
    }
  }, [lightbox.currentPhoto]);

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
      
      // Clear selection if using lifted state
      if (selection) {
        selection.clearSelection();
      }

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

  // Get the epoch read key for the current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  const visibleRows = rows.slice(startIndex, endIndex + 1);

  return (
    <>
      {/* Virtualized grid container - ALWAYS rendered so ResizeObserver can measure it */}
      <div
        ref={containerRef}
        className={`justified-grid-container ${isSelectionMode ? 'selection-mode' : ''}`}
        onScroll={handleScroll}
        data-testid="justified-grid"
      >
        {/* Empty state - show inside container so ref is always attached */}
        {displayPhotos.length === 0 ? (
          <div className="justified-grid-empty" data-testid="justified-grid-empty">
            <div className="empty-state-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
            </div>
            <h3>No photos yet</h3>
            {permissions.canUpload ? (
              <p>Upload some photos to get started</p>
            ) : (
              <p>This album is empty</p>
            )}
          </div>
        ) : (
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
                  // Check if this is a pending upload
                  const pendingPhoto = photo as PhotoMeta & { isPending?: boolean; task?: any };
                  
                  if (pendingPhoto.isPending && pendingPhoto.task) {
                    return (
                      <div key={photo.id} style={{ width, height }}>
                        <PendingPhotoThumbnail task={pendingPhoto.task} />
                      </div>
                    );
                  }

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
                      selectionMode={isSelectionMode}
                      showDelete={permissions.canDelete}
                      onClick={() => handlePhotoClick(photo)}
                      onSelectionChange={(selected: boolean) =>
                        handleSelectionChange(photo.id, selected)
                      }
                      onDelete={(thumbnailUrl) => handleDeletePhoto(photo, thumbnailUrl)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        )}
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
