/**
 * Shared Photo Grid Component
 *
 * Read-only photo grid for anonymous share link viewers.
 * No edit/delete/upload actions - just viewing.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { NavigationDirection } from '../../hooks/useLightbox';
import type { PhotoMeta } from '../../workers/types';
import { SharedPhotoLightbox } from './SharedPhotoLightbox';
import { SharedPhotoThumbnail } from './SharedPhotoThumbnail';



/** Estimated row height for virtualization */
const ROW_HEIGHT = 200;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface SharedPhotoGridProps {
  /** Photos to display */
  photos: PhotoMeta[];
  /** Share link ID for shard downloads */
  linkId: string;
  /** Maximum access tier for this share link */
  accessTier: AccessTierType;
  /** Get the tier key for an epoch */
  getTierKey: (epochId: number, tier: AccessTierType) => Uint8Array | undefined;
  /** Get sign pubkey for manifest verification */
  getSignPubkey?: (epochId: number) => Uint8Array | undefined;
  /** Whether keys are loading */
  isLoadingKeys?: boolean;
}

/**
 * Virtualized Photo Grid for Share Link Viewers
 * Read-only - no selection, delete, or upload actions
 */
export function SharedPhotoGrid({
  photos,
  linkId,
  accessTier,
  getTierKey,
  isLoadingKeys = false,
}: SharedPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  
  // Lightbox state
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [navigationDirection, setNavigationDirection] = useState<NavigationDirection>('initial');

  // Track container width for responsive layout
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
  const gap = 8;
  const cellWidth = containerWidth > 0 
    ? (containerWidth - (columns - 1) * gap) / columns 
    : ROW_HEIGHT;
  const rowHeight = cellWidth; 

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });

  // Current photo in lightbox
  const currentPhoto = lightboxIndex !== null ? photos[lightboxIndex] : null;

  // Direction-aware preload queue for lightbox
  // When navigating forward: prioritize N+1, N+2, then N-1
  // When navigating backward: prioritize N-1, N-2, then N+1
  // When initial (just opened): preload equally in both directions
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (lightboxIndex === null) return [];

    const queue: PhotoMeta[] = [];
    
    if (navigationDirection === 'forward') {
      // Moving forward: prioritize ahead, then add one behind
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const next = photos[lightboxIndex + offset];
        if (next?.shardIds?.length) queue.push(next);
      }
      const prev = photos[lightboxIndex - 1];
      if (prev?.shardIds?.length) queue.push(prev);
    } else if (navigationDirection === 'backward') {
      // Moving backward: prioritize behind, then add one ahead
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prev = photos[lightboxIndex - offset];
        if (prev?.shardIds?.length) queue.push(prev);
      }
      const next = photos[lightboxIndex + 1];
      if (next?.shardIds?.length) queue.push(next);
    } else {
      // Initial open: preload equally in both directions
      for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
        const prevPhoto = photos[lightboxIndex - offset];
        const nextPhoto = photos[lightboxIndex + offset];
        if (nextPhoto?.shardIds?.length) queue.push(nextPhoto);
        if (prevPhoto?.shardIds?.length) queue.push(prevPhoto);
      }
    }
    
    return queue;
  }, [lightboxIndex, navigationDirection, photos]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback((photoIndex: number) => {
    setNavigationDirection('initial');
    setLightboxIndex(photoIndex);
  }, []);

  // Lightbox navigation
  const handleLightboxClose = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const handleLightboxNext = useCallback(() => {
    setNavigationDirection('forward');
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev < photos.length - 1 ? prev + 1 : prev;
    });
  }, [photos.length]);

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
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowStartIndex = virtualRow.index * columns;
            const rowPhotos = photos.slice(rowStartIndex, rowStartIndex + columns);

            return (
              <div
                key={virtualRow.key}
                className="photo-grid-row"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: `repeat(${columns}, 1fr)`,
                  gap: '8px',
                  padding: '0 8px',
                }}
              >
                {rowPhotos.map((photo, colIndex) => {
                  const photoIndex = rowStartIndex + colIndex;
                  // Get the appropriate tier key for this photo
                  const tierKey = getTierKey(photo.epochId, accessTier);

                  return (
                    <SharedPhotoThumbnail
                      key={photo.id}
                      photo={photo}
                      tierKey={tierKey}
                      accessTier={accessTier}
                      onClick={() => handlePhotoClick(photoIndex)}
                    />
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
          tierKey={getTierKey(currentPhoto.epochId, accessTier)}
          accessTier={accessTier}
          onClose={handleLightboxClose}
          onNext={lightboxIndex < photos.length - 1 ? handleLightboxNext : undefined}
          onPrevious={lightboxIndex > 0 ? handleLightboxPrevious : undefined}
          hasNext={lightboxIndex < photos.length - 1}
          hasPrevious={lightboxIndex > 0}
          preloadQueue={preloadQueue}
          getTierKey={getTierKey}
        />
      )}
    </>
  );
}
