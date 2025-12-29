/**
 * Shared Photo Grid Component
 *
 * Read-only photo grid for anonymous share link viewers.
 * No edit/delete/upload actions - just viewing.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { PhotoMeta } from '../../workers/types';
import { SharedPhotoThumbnail } from './SharedPhotoThumbnail';
import { SharedPhotoLightbox } from './SharedPhotoLightbox';

/** Number of columns in the grid */
const COLUMNS = 4;

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
  const parentRef = useRef<HTMLDivElement>(null);
  
  // Lightbox state
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const rowCount = Math.ceil(photos.length / COLUMNS);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Current photo in lightbox
  const currentPhoto = lightboxIndex !== null ? photos[lightboxIndex] : null;

  // Preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (lightboxIndex === null) return [];

    const queue: PhotoMeta[] = [];
    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = photos[lightboxIndex - offset];
      const nextPhoto = photos[lightboxIndex + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
    }
    return queue;
  }, [lightboxIndex, photos]);

  // Handle photo click to open lightbox
  const handlePhotoClick = useCallback((photoIndex: number) => {
    setLightboxIndex(photoIndex);
  }, []);

  // Lightbox navigation
  const handleLightboxClose = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const handleLightboxNext = useCallback(() => {
    setLightboxIndex((prev) => {
      if (prev === null) return null;
      return prev < photos.length - 1 ? prev + 1 : prev;
    });
  }, [photos.length]);

  const handleLightboxPrevious = useCallback(() => {
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
        ref={parentRef}
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
            const rowStartIndex = virtualRow.index * COLUMNS;
            const rowPhotos = photos.slice(rowStartIndex, rowStartIndex + COLUMNS);

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
                  gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
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
