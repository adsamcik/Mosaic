/**
 * Enhanced Mosaic Photo Grid (v2)
 *
 * An improved photo grid that uses the enhanced mosaic layout algorithm with:
 * - Proper justified rows that fill container width exactly
 * - Smart map tile insertion for GPS-tagged photo clusters
 * - Smart story tiles for photos with descriptions
 * - Virtualized rendering for performance
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { useAnimatedItems } from '../../hooks/useAnimatedItems';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoActions } from '../../hooks/usePhotoActions';
import { usePhotos } from '../../hooks/usePhotos';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import {
  computeEnhancedMosaicLayout,
  type EnhancedMosaicItem,
  type MosaicLayoutConfig,
} from '../../lib/mosaic-layout-v2';
import '../../styles/upload.css';
import type { PhotoMeta } from '../../workers/types';
import { AnimatedTile } from './AnimatedTile';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { EnhancedMosaicTile } from './EnhancedMosaicTile';
import { JustifiedPhotoThumbnail } from './JustifiedPhotoThumbnail';
import { PhotoGridSkeleton } from './PhotoGridSkeleton';
import { PhotoLightbox } from './PhotoLightbox';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Height of the date header in pixels */
const HEADER_HEIGHT = 44;

/** Number of photos to preload */
const PRELOAD_COUNT = 2;

interface EnhancedMosaicPhotoGridProps {
  albumId: string;
  searchQuery?: string;
  onPhotosDeleted?: () => void;
  selection?: UseSelectionReturn;
  /** Enable smart map tile insertion for GPS-tagged photos */
  enableMapTiles?: boolean;
  /** Enable smart story tile insertion for photos with descriptions */
  enableDescriptionTiles?: boolean;
  /** Handler for when a map cluster is clicked */
  onMapClick?: (
    coordinates: Array<{ lat: number; lng: number; photoId: string }>,
  ) => void;
}

// Virtual item types
type VirtualItem =
  | { type: 'header'; date: string; id: string; height: number }
  | {
      type: 'mosaic-row';
      items: EnhancedMosaicItem[];
      height: number;
      id: string;
      top: number;
    };

function formatDateHeader(dateString: string): string {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'Unknown Date';

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  }).format(date);
}

function groupPhotosByDate(photos: PhotoMeta[]) {
  const groups: Record<string, PhotoMeta[]> = {};
  const sorted = [...photos].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  for (const photo of sorted) {
    const dateKey = new Date(photo.createdAt).toDateString();
    if (!groups[dateKey]) {
      groups[dateKey] = [];
    }
    groups[dateKey].push(photo);
  }

  return Object.entries(groups).sort(
    (a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime(),
  );
}

export function EnhancedMosaicPhotoGrid({
  albumId,
  searchQuery,
  onPhotosDeleted,
  selection,
  enableMapTiles = true,
  enableDescriptionTiles = true,
  onMapClick,
}: EnhancedMosaicPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Resize observer
  useEffect(() => {
    const node = parentRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { photos, isLoading, error, refetch } = usePhotos(albumId, searchQuery);
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
  const photoActions = usePhotoActions();
  const permissions = useAlbumPermissions();

  // Create a map for quick photo lookup
  const photosMap = useMemo(() => {
    const map = new Map<string, PhotoMeta>();
    for (const photo of photos) {
      map.set(photo.id, photo);
    }
    return map;
  }, [photos]);

  // Animation state tracking for smooth enter/exit transitions
  const {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
    hasBeenSeen,
    isInitialLoad,
  } = useAnimatedItems(photos, {
    getKey: (photo) => photo.id,
    onRemoveComplete: (key) => {
      // Cleanup resources for removed photo if needed
      photosMap.delete(key);
    },
  });

  // Create animation lookup map for quick access during render
  const animationLookup = useMemo(() => {
    const lookup = new Map<
      string,
      { isExiting: boolean; staggerDelay: number; hasBeenSeen: boolean }
    >();
    for (const item of animatedItems) {
      lookup.set(item.key, {
        isExiting: item.isExiting,
        staggerDelay: getStaggerDelay(item.key),
        hasBeenSeen: hasBeenSeen(item.key),
      });
    }
    return lookup;
  }, [animatedItems, getStaggerDelay, hasBeenSeen]);

  const isSelectionMode = selection?.isSelectionMode ?? false;
  const selectedIds = selection?.selectedIds ?? new Set<string>();
  const [deleteTarget, setDeleteTarget] = useState<PhotoMeta[] | null>(null);
  const [deleteThumbnailUrl, setDeleteThumbnailUrl] = useState<
    string | undefined
  >();

  // Compute layout using the enhanced algorithm
  const virtualRows = useMemo(() => {
    if (containerWidth <= 0 || photos.length === 0) return [];

    const grouped = groupPhotosByDate(photos);
    const rows: VirtualItem[] = [];

    const layoutConfig: MosaicLayoutConfig = {
      containerWidth,
      gap: PHOTO_GAP,
      targetRowHeight: TARGET_ROW_HEIGHT,
      enableMapTiles,
      enableDescriptionTiles,
      minDescriptionLength: 20,
      minPhotosForMapTile: 3,
    };

    for (const [dateString, groupPhotos] of grouped) {
      // Add date header
      rows.push({
        type: 'header',
        date: formatDateHeader(dateString),
        id: `header-${dateString}`,
        height: HEADER_HEIGHT,
      });

      // Compute enhanced mosaic layout for this date group
      const mosaicItems = computeEnhancedMosaicLayout(
        groupPhotos,
        layoutConfig,
      );

      // Group mosaic items by their top coordinate to form virtual rows
      const byTop = new Map<number, EnhancedMosaicItem[]>();
      for (const item of mosaicItems) {
        const t = Math.round(item.rect.top);
        if (!byTop.has(t)) byTop.set(t, []);
        byTop.get(t)!.push(item);
      }

      // Sort by top and create row entries
      const sortedTops = Array.from(byTop.keys()).sort((a, b) => a - b);

      for (const top of sortedTops) {
        const items = byTop.get(top)!;

        // Calculate row height from items
        let maxBottom = 0;
        for (const item of items) {
          const bottom = item.rect.top + item.rect.height;
          if (bottom > maxBottom) maxBottom = bottom;
        }
        const rowHeight = maxBottom - top;

        rows.push({
          type: 'mosaic-row',
          items: items.map((it) => ({
            ...it,
            rect: { ...it.rect, top: it.rect.top - top }, // Relative to this row
          })),
          height: rowHeight + PHOTO_GAP,
          id: `row-${dateString}-${top}`,
          top: 0,
        });
      }
    }

    return rows;
  }, [photos, containerWidth, enableMapTiles, enableDescriptionTiles]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => virtualRows[i]?.height ?? 0,
    overscan: 3, // Number of extra rows to render above/below viewport
  });

  // Event handlers
  const handlePhotoClick = useCallback(
    (photo: PhotoMeta) => {
      if (!isSelectionMode) {
        // Find index in the sorted photos array (matches display order)
        const index = sortedPhotos.findIndex((p) => p.id === photo.id);
        if (index >= 0) lightbox.open(index);
      }
    },
    [isSelectionMode, lightbox, sortedPhotos],
  );

  // Handle selection change for a single photo
  // Supports shift-click for range selection
  const handleSelectionChange = useCallback(
    (
      photoId: string,
      selected: boolean,
      event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
      if (selection) {
        if (selected) {
          // Check for shift-click range selection
          if (event?.shiftKey && selection.lastSelectedId) {
            selection.selectRange(photoId, sortedPhotoIds);
          } else {
            selection.selectPhoto(photoId);
          }
        } else {
          selection.deselectPhoto(photoId);
        }
      }
    },
    [selection, sortedPhotoIds],
  );

  const handleDeletePhoto = useCallback(
    (photo: PhotoMeta, thumbnailUrl?: string) => {
      setDeleteTarget([photo]);
      setDeleteThumbnailUrl(thumbnailUrl);
    },
    [],
  );

  const handleDeleteFromLightbox = useCallback(() => {
    if (lightbox.currentPhoto) {
      setDeleteTarget([lightbox.currentPhoto]);
      setDeleteThumbnailUrl(undefined);
    }
  }, [lightbox.currentPhoto]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteTarget.length === 0) return;
    try {
      const firstPhoto = deleteTarget[0];
      if (deleteTarget.length === 1 && firstPhoto) {
        await photoActions.deletePhoto(firstPhoto.id, albumId);
      } else {
        await photoActions.deletePhotos(
          deleteTarget.map((p) => p.id),
          albumId,
        );
      }
      setDeleteTarget(null);
      selection?.clearSelection();
      lightbox.close();
      refetch();
      onPhotosDeleted?.();
    } catch {
      /* Error handled in hook */
    }
  }, [
    deleteTarget,
    photoActions,
    albumId,
    lightbox,
    refetch,
    onPhotosDeleted,
    selection,
  ]);

  const handleMapClick = useCallback(
    (coordinates: Array<{ lat: number; lng: number; photoId: string }>) => {
      if (onMapClick) {
        onMapClick(coordinates);
      }
    },
    [onMapClick],
  );

  // Preload queue for lightbox - direction-aware for smarter preloading
  // When navigating forward: prioritize N+1, N+2, then N-1
  // When navigating backward: prioritize N-1, N-2, then N+1
  // When initial (just opened): preload equally in both directions
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    const direction = lightbox.navigationDirection;

    if (direction === 'forward') {
      // Moving forward: prioritize ahead, then add one behind
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const next = sortedPhotos[currentIdx + offset];
        if (next?.shardIds?.length) queue.push(next);
      }
      // Also preload one behind in case user goes back
      const prev = sortedPhotos[currentIdx - 1];
      if (prev?.shardIds?.length) queue.push(prev);
    } else if (direction === 'backward') {
      // Moving backward: prioritize behind, then add one ahead
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prev = sortedPhotos[currentIdx - offset];
        if (prev?.shardIds?.length) queue.push(prev);
      }
      // Also preload one ahead in case user goes forward
      const next = sortedPhotos[currentIdx + 1];
      if (next?.shardIds?.length) queue.push(next);
    } else {
      // Initial open: preload equally in both directions
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const next = sortedPhotos[currentIdx + offset];
        const prev = sortedPhotos[currentIdx - offset];
        if (next?.shardIds?.length) queue.push(next);
        if (prev?.shardIds?.length) queue.push(prev);
      }
    }

    return queue;
  }, [
    lightbox.isOpen,
    lightbox.currentIndex,
    lightbox.currentPhoto,
    lightbox.navigationDirection,
    sortedPhotos,
  ]);

  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  // Loading state - show skeleton
  if (isLoading || keysLoading) {
    return (
      <div
        className="photo-grid-container"
        data-testid="enhanced-mosaic-photo-grid-loading"
      >
        <PhotoGridSkeleton count={12} columns={4} />
      </div>
    );
  }

  // Error state
  if (error) return <div className="photo-grid-error">{error.message}</div>;

  // Render thumbnail helper
  const renderThumbnail = (
    photo: PhotoMeta,
    width: number,
    height: number,
    onClick?: () => void,
  ) => {
    const epochKey = epochKeys.get(photo.epochId);
    const isSelected = selectedIds.has(photo.id);

    return (
      <div style={{ width: '100%', height: '100%' }}>
        <JustifiedPhotoThumbnail
          photo={photo}
          epochReadKey={epochKey}
          isSelected={isSelected}
          selectionMode={isSelectionMode}
          showDelete={!photo.isPending}
          onSelectionChange={(selected, event) =>
            handleSelectionChange(photo.id, selected, event)
          }
          onClick={() => onClick?.()}
          width={width}
          height={height}
          onDelete={(url) => handleDeletePhoto(photo, url)}
        />
      </div>
    );
  };

  return (
    <>
      <div
        ref={parentRef}
        className={`photo-grid-container ${isSelectionMode ? 'selection-mode' : ''}`}
        style={{ height: '100%', overflowY: 'auto' }}
        data-testid="enhanced-mosaic-photo-grid"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = virtualRows[virtualRow.index];
            if (!item) return null;

            // Render date header
            if (item.type === 'header') {
              return (
                <div
                  key={item.id}
                  className="photo-grid-header"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${item.height}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingLeft: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    zIndex: 1,
                  }}
                >
                  {item.date}
                </div>
              );
            }

            // Render mosaic row
            if (item.type !== 'mosaic-row') return null;

            return (
              <div
                key={item.id}
                className="mosaic-row enhanced-mosaic-row"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${item.height}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {item.items.map((mosaicItem) => {
                  const photo = mosaicItem.photoId
                    ? photosMap.get(mosaicItem.photoId)
                    : undefined;

                  // Get animation state for this photo
                  const animState = photo
                    ? animationLookup.get(photo.id)
                    : undefined;
                  const skipAnimation = isInitialLoad || !animState;

                  const tileProps = {
                    item: mosaicItem,
                    photos: photosMap,
                    onMapClick: handleMapClick,
                    renderThumbnail: ({
                      photo: p,
                      width,
                      height,
                      onClick,
                    }: {
                      photo: PhotoMeta;
                      width: number;
                      height: number;
                      onClick?: () => void;
                    }) => renderThumbnail(p, width, height, onClick),
                  };

                  // Wrap photo tiles with animation, but not map/story tiles
                  if (photo) {
                    return (
                      <AnimatedTile
                        key={photo.id}
                        itemKey={photo.id}
                        skipAnimation={skipAnimation}
                        isExiting={animState?.isExiting ?? false}
                        onExitComplete={() => handleExitComplete(photo.id)}
                        staggerDelay={animState?.staggerDelay ?? 0}
                        hasBeenSeen={animState?.hasBeenSeen ?? false}
                        style={{
                          position: 'absolute',
                          top: mosaicItem.rect.top,
                          left: mosaicItem.rect.left,
                          width: mosaicItem.rect.width,
                          height: mosaicItem.rect.height,
                        }}
                      >
                        <EnhancedMosaicTile
                          {...tileProps}
                          photo={photo}
                          onClick={() => handlePhotoClick(photo)}
                          skipPositioning
                        />
                      </AnimatedTile>
                    );
                  }

                  // Non-photo tiles (map, story) don't need animation wrapper
                  return (
                    <EnhancedMosaicTile key={mosaicItem.id} {...tileProps} />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Lightbox */}
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

      {/* Delete confirmation dialog */}
      {deleteTarget && deleteTarget.length > 0 && (
        <DeletePhotoDialog
          photos={deleteTarget}
          thumbnailUrl={deleteThumbnailUrl}
          isDeleting={photoActions.isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setDeleteTarget(null);
            photoActions.clearError();
          }}
          error={photoActions.error}
        />
      )}
    </>
  );
}
