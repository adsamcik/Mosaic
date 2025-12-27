import { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePhotos } from '../../hooks/usePhotos';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { PhotoThumbnail } from './PhotoThumbnail';
import { PhotoLightbox } from './PhotoLightbox';
import type { PhotoMeta } from '../../workers/types';

/** Number of columns in the grid */
const COLUMNS = 4;

/** Estimated row height for virtualization */
const ROW_HEIGHT = 200;

/** Number of photos to preload ahead/behind in lightbox */
const PRELOAD_COUNT = 2;

interface PhotoGridProps {
  albumId: string;
}

/**
 * Virtualized Photo Grid Component
 * Uses TanStack Virtual for efficient rendering of large photo collections
 */
export function PhotoGrid({ albumId }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { photos, isLoading, error } = usePhotos(albumId);
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);
  const lightbox = useLightbox(photos);

  const rowCount = Math.ceil(photos.length / COLUMNS);

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
  const handlePhotoClick = (photoIndex: number) => {
    lightbox.open(photoIndex);
  };

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
                const photo = photos[photoIndex];
                if (!photo) return null;
                // Get epoch read key for this photo
                const epochReadKey = epochKeys.get(photo.epochId);
                return epochReadKey ? (
                  <PhotoThumbnail
                    key={photo.id}
                    photo={photo}
                    epochReadKey={epochReadKey}
                    onClick={() => handlePhotoClick(photoIndex)}
                  />
                ) : (
                  <PhotoThumbnail
                    key={photo.id}
                    photo={photo}
                    onClick={() => handlePhotoClick(photoIndex)}
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
        />
      )}
    </>
  );
}

