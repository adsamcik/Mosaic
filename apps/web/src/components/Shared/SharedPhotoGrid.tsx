/**
 * Shared Photo Grid Component
 *
 * Read-only photo grid for anonymous share link viewers.
 * No edit/delete/upload actions - just viewing.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NavigationDirection } from '../../hooks/useLightbox';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import {
  computeJustifiedLayout,
  type JustifiedRow,
} from '../../lib/justified-layout';
import { formatDateHeader, groupPhotosByDate } from '../../lib/photo-date-utils';
import type { PhotoMeta } from '../../workers/types';
import { SharedPhotoLightbox } from './SharedPhotoLightbox';
import { SharedPhotoThumbnail } from './SharedPhotoThumbnail';

/** Gap between photos in pixels */
const PHOTO_GAP = 4;

/** Target row height in pixels */
const TARGET_ROW_HEIGHT = 220;

/** Height of the date header in pixels */
const HEADER_HEIGHT = 44;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface SharedPhotoGridProps {
  /** Photos to display */
  photos: PhotoMeta[];
  /** Share link ID for shard downloads */
  linkId: string;
  /** Maximum access tier for this share link */
  accessTier: AccessTierType;
  /** Short-lived grant token for limited-use links */
  grantToken?: string | null | undefined;
  /** Get the tier key for an epoch */
  getTierKey: (epochId: number, tier: AccessTierType) => Uint8Array | undefined;
  /** Get sign pubkey for manifest verification */
  getSignPubkey?: (epochId: number) => Uint8Array | undefined;
  /** Whether keys are loading */
  isLoadingKeys?: boolean;
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
 * Virtualized Photo Grid for Share Link Viewers
 * Read-only - no selection, delete, or upload actions
 */
export function SharedPhotoGrid({
  photos,
  linkId,
  accessTier,
  grantToken,
  getTierKey,
  isLoadingKeys = false,
}: SharedPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Store ResizeObserver instance so we can clean it up
  const observerRef = useRef<ResizeObserver | null>(null);

  // Lightbox state
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [navigationDirection, setNavigationDirection] =
    useState<NavigationDirection>('initial');

  // Track container width for responsive layout
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
        date: formatDateHeader(dateString),
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
  }, [photos, containerWidth]);

  // Get total grid height
  const totalHeight = useMemo(() => {
    if (layoutItems.length === 0) return 0;
    const lastItem = layoutItems[layoutItems.length - 1];
    if (!lastItem) return 0;
    return lastItem.top + lastItem.height + PHOTO_GAP;
  }, [layoutItems]);

  const virtualizer = useVirtualizer({
    count: layoutItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => layoutItems[i]?.height ?? HEADER_HEIGHT,
    overscan: 5,
  });

  // Current photo in lightbox
  // We need to find the photo in the sorted list (since layout sorts by date)
  // But for now, let's assume photos prop is not necessarily sorted, so we should use the sorted order from the layout
  // Actually, lightbox navigation relies on an index. We should probably sort photos once and use that for lightbox.

  const sortedPhotos = useMemo(
    () =>
      [...photos].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [photos],
  );

  const currentPhoto =
    lightboxIndex !== null ? sortedPhotos[lightboxIndex] : null;

  // Direction-aware preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (lightboxIndex === null) return [];

    const queue: PhotoMeta[] = [];

    if (navigationDirection === 'forward') {
      // Moving forward: prioritize ahead, then add one behind
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const next = sortedPhotos[lightboxIndex + offset];
        if (next?.shardIds?.length) queue.push(next);
      }
      const prev = sortedPhotos[lightboxIndex - 1];
      if (prev?.shardIds?.length) queue.push(prev);
    } else if (navigationDirection === 'backward') {
      // Moving backward: prioritize behind, then add one ahead
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prev = sortedPhotos[lightboxIndex - offset];
        if (prev?.shardIds?.length) queue.push(prev);
      }
      const next = sortedPhotos[lightboxIndex + 1];
      if (next?.shardIds?.length) queue.push(next);
    } else {
      // Initial open: preload equally in both directions
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prevPhoto = sortedPhotos[lightboxIndex - offset];
        const nextPhoto = sortedPhotos[lightboxIndex + offset];
        if (nextPhoto?.shardIds?.length) queue.push(nextPhoto);
        if (prevPhoto?.shardIds?.length) queue.push(prevPhoto);
      }
    }

    return queue;
  }, [lightboxIndex, navigationDirection, sortedPhotos]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback(
    (photo: PhotoMeta) => {
      // Find index in sortedPhotos
      const index = sortedPhotos.findIndex((p) => p.id === photo.id);
      if (index >= 0) {
        setNavigationDirection('initial');
        setLightboxIndex(index);
      }
    },
    [sortedPhotos],
  );

  // Lightbox navigation
  const handleLightboxClose = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const handleLightboxNext = useCallback(() => {
    setNavigationDirection('forward');
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev < sortedPhotos.length - 1 ? prev + 1 : prev;
    });
  }, [sortedPhotos.length]);

  const handleLightboxPrevious = useCallback(() => {
    setNavigationDirection('backward');
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev > 0 ? prev - 1 : prev;
    });
  }, []);

  // Loading state for keys
  if (isLoadingKeys) {
    return (
      <div className="photo-grid" data-testid="shared-photo-grid">
        <div className="photo-grid-loading">
          <div className="loading-spinner" />
          <p>Loading encryption keys...</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (photos.length === 0) {
    return (
      <div className="photo-grid" data-testid="shared-photo-grid">
        <div className="photo-grid-empty">
          <span className="empty-icon">📷</span>
          <p>No photos in this album yet.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className="photo-grid"
        data-testid="shared-photo-grid"
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div
          style={{
            height: totalHeight,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = layoutItems[virtualItem.index];
            if (!item) return null;

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

            // Row
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
              >
                {item.row.photos.map(({ photo, width, height }) => {
                  // Get the appropriate tier key for this photo
                  const tierKey = getTierKey(photo.epochId, accessTier);

                  return (
                    <div
                      key={photo.id}
                      style={{ width, height, overflow: 'hidden' }}
                    >
                      <SharedPhotoThumbnail
                        key={photo.id}
                        photo={photo}
                        tierKey={tierKey}
                        accessTier={accessTier}
                        onClick={() => handlePhotoClick(photo)}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Photo Lightbox */}
      {lightboxIndex !== null && currentPhoto && (
        <SharedPhotoLightbox
          photo={currentPhoto}
          linkId={linkId}
          grantToken={grantToken}
          tierKey={getTierKey(currentPhoto.epochId, accessTier)}
          accessTier={accessTier}
          onClose={handleLightboxClose}
          onNext={
            lightboxIndex < sortedPhotos.length - 1
              ? handleLightboxNext
              : undefined
          }
          onPrevious={lightboxIndex > 0 ? handleLightboxPrevious : undefined}
          hasNext={lightboxIndex < sortedPhotos.length - 1}
          hasPrevious={lightboxIndex > 0}
          preloadQueue={preloadQueue}
          getTierKey={getTierKey}
        />
      )}
    </>
  );
}
