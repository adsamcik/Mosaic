/**
 * Justified Photo Grid Component with Date Headers
 *
 * Displays photos in a Google Photos-style justified layout with virtualization.
 * Photos are grouped by date, and each group fills rows while maintaining aspect ratios.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import { useAnimatedItems } from '../../hooks/useAnimatedItems';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { usePhotoDelete } from '../../hooks/usePhotoDelete';
import type { UseSelectionReturn } from '../../hooks/useSelection';
import {
  computeJustifiedLayout,
  type JustifiedRow,
} from '../../lib/justified-layout';
import '../../styles/upload.css';
import type { PhotoMeta } from '../../workers/types';
import { AnimatedTile } from './AnimatedTile';
import { DeletePhotoDialog } from './DeletePhotoDialog';
import { JustifiedPhotoThumbnail } from './JustifiedPhotoThumbnail';
import { PhotoLightbox } from './PhotoLightbox';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Height of the date header in pixels */
const HEADER_HEIGHT = 44; // Approx 2.5rem + padding

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface PhotoGridProps {
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

type LayoutItem =
  | { type: 'header'; date: string; top: number; height: number; id: string }
  | {
      type: 'row';
      row: JustifiedRow;
      top: number;
      height: number;
      rowIndex: number;
      id: string;
    };

/**
 * Helper to format date groups
 */
function formatDateHeader(
  dateString: string,
  t: (key: string) => string,
): string {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return t('gallery.date.unknown');

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return t('gallery.date.today');
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return t('gallery.date.yesterday');
  }

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  }).format(date);
}

/**
 * Group photos by date string (YYYY-MM-DD)
 */
function groupPhotosByDate(photos: PhotoMeta[]) {
  const groups: Record<string, PhotoMeta[]> = {};
  const sorted = [...photos].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  for (const photo of sorted) {
    // Use local date string for grouping to avoid timezone splits if possible,
    // but ISO string split is safer for consistency if timezones aren't strict.
    // Assuming createdAt is ISO UTC.
    const dateKey = new Date(photo.createdAt).toDateString();
    if (!groups[dateKey]) {
      groups[dateKey] = [];
    }
    groups[dateKey].push(photo);
  }

  // Sort keys descending (newest first)
  return Object.entries(groups).sort(
    (a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime(),
  );
}

/**
 * Virtualized Justified Photo Grid Component
 * Uses a Google Photos-style layout with efficient rendering
 */
export function PhotoGrid({
  albumId,
  photos,
  isLoading,
  error,
  refetch,
  onPhotosDeleted,
  selection,
}: PhotoGridProps) {
  const { t } = useTranslation();
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

  // Animation system for photo tiles
  const {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
    hasBeenSeen,
    isInitialLoad,
  } = useAnimatedItems(sortedPhotos, {
    getKey: (photo) => photo.id,
    onRemoveComplete: () => {
      // Photo removed from animation system
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

  const lightbox = useLightbox(sortedPhotos);
  const permissions = useAlbumPermissions();

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

  // Compute Layout: Headers and Justified Rows
  // Note: photos prop already includes pending photos from PhotoStore
  const layoutItems = useMemo((): LayoutItem[] => {
    if (containerWidth <= 0 || photos.length === 0) return [];

    const grouped = groupPhotosByDate(photos);
    const items: LayoutItem[] = [];
    let currentTop = 0;
    // Add top padding
    currentTop += PHOTO_GAP;

    for (const [dateString, groupPhotos] of grouped) {
      // Add Header
      items.push({
        type: 'header',
        date: formatDateHeader(dateString, t),
        top: currentTop,
        height: HEADER_HEIGHT,
        id: `header-${dateString}`,
      });
      currentTop += HEADER_HEIGHT;

      // Compute rows for this group
      const rows = computeJustifiedLayout(groupPhotos, {
        containerWidth,
        targetRowHeight: TARGET_ROW_HEIGHT,
        gap: PHOTO_GAP,
      });

      // Add Rows
      rows.forEach((row, idx) => {
        items.push({
          type: 'row',
          row,
          top: currentTop,
          height: row.height,
          rowIndex: idx,
          id: `row-${dateString}-${idx}`,
        });
        currentTop += row.height + PHOTO_GAP;
      });
    }

    return items;
  }, [photos, containerWidth, t]);

  // Get total grid height
  const totalHeight = useMemo(() => {
    if (layoutItems.length === 0) return 0;
    const lastItem = layoutItems[layoutItems.length - 1];
    if (!lastItem) return 0;
    return lastItem.top + lastItem.height + PHOTO_GAP;
  }, [layoutItems]);

  // Get viewport height
  const viewportHeight = containerElementRef.current?.clientHeight ?? 800;

  // Compute visible items for virtualization
  const visibleItems = useMemo(() => {
    const overscan = 500; // pixels
    const startY = Math.max(0, scrollTop - overscan);
    const endY = scrollTop + viewportHeight + overscan;

    // Binary search could be faster, but linear scan is fine for typical album sizes (<10k rows)
    // since we only render visible ones. Optimization: find start index via binary search.

    let startIndex = 0;
    let endIndex = layoutItems.length - 1;

    // Simple find
    for (let i = 0; i < layoutItems.length; i++) {
      if (layoutItems[i]!.top + layoutItems[i]!.height >= startY) {
        startIndex = i;
        break;
      }
    }

    for (let i = startIndex; i < layoutItems.length; i++) {
      if (layoutItems[i]!.top > endY) {
        endIndex = i - 1;
        break;
      }
      endIndex = i;
    }

    if (layoutItems.length === 0) return [];

    return layoutItems.slice(startIndex, endIndex + 1);
  }, [layoutItems, scrollTop, viewportHeight]);

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
      const prevPhoto = sortedPhotos[currentIdx - offset];
      const nextPhoto = sortedPhotos[currentIdx + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
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

  // Handle selection change for a single photo (checkbox click)
  const handleSelectionChange = useCallback(
    (photoId: string, selected: boolean) => {
      if (selection) {
        if (selected) {
          // Enter selection mode if not already in it
          if (!selection.isSelectionMode) {
            selection.enterSelectionMode();
          }
          selection.selectPhoto(photoId);
        } else {
          selection.deselectPhoto(photoId);
        }
      }
    },
    [selection],
  );

  // Loading state
  if (isLoading || keysLoading) {
    return (
      <div className="photo-grid-loading" data-testid="photo-grid-loading">
        <div className="loading-spinner" />
        <p>{t('gallery.loading')}</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="photo-grid-error" data-testid="photo-grid-error">
        <p>
          {t('gallery.error.loadFailed')}: {error.message}
        </p>
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
        className={`photo-grid-container ${isSelectionMode ? 'selection-mode' : ''}`} // Reusing photo-grid classes or creating new ones
        onScroll={handleScroll}
        data-testid="photo-grid"
      >
        {photos.length === 0 ? (
          <div className="photo-grid-empty" data-testid="photo-grid-empty">
            {/* Using existing empty state styles */}
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
            {permissions.canUpload ? (
              <p>Upload some photos to get started</p>
            ) : (
              <p>This album is empty</p>
            )}
          </div>
        ) : (
          <div
            className="photo-grid-content"
            style={{ height: totalHeight, position: 'relative' }}
          >
            {visibleItems.map((item) => {
              if (item.type === 'header') {
                return (
                  <div
                    key={item.id}
                    className="photo-grid-header"
                    style={{
                      position: 'absolute',
                      top: item.top,
                      left: 0,
                      right: 0,
                      height: item.height,
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

              // It's a row
              return (
                <div
                  key={item.id}
                  className="photo-grid-row"
                  style={{
                    position: 'absolute',
                    top: item.top,
                    left: 0,
                    right: 0,
                    height: item.height,
                    display: 'flex',
                    gap: PHOTO_GAP,
                  }}
                  data-testid="photo-grid-row"
                >
                  {item.row.photos.map(({ photo, width, height }) => {
                    const epochReadKey = epochKeys.get(photo.epochId);
                    const isSelected = selectedIds.has(photo.id);

                    // Get animation state for this photo
                    const animState = animationLookup.get(photo.id);
                    const skipAnimation = isInitialLoad || !animState;

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
                          width,
                          height,
                          flexShrink: 0,
                        }}
                      >
                        <JustifiedPhotoThumbnail
                          photo={photo}
                          width={width}
                          height={height}
                          epochReadKey={epochReadKey}
                          isSelected={isSelected}
                          selectionMode={isSelectionMode}
                          showDelete={permissions.canDelete && !photo.isPending}
                          onClick={() => handlePhotoClick(photo)}
                          onSelectionChange={(selected: boolean) =>
                            handleSelectionChange(photo.id, selected)
                          }
                          onDelete={(thumbnailUrl) =>
                            handleDeletePhoto(photo, thumbnailUrl)
                          }
                        />
                      </AnimatedTile>
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
          isDeleting={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          error={deleteError}
        />
      )}
    </>
  );
}
