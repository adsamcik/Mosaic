import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePhotos } from '../../hooks/usePhotos';
import { PhotoThumbnail } from './PhotoThumbnail';

/** Number of columns in the grid */
const COLUMNS = 4;

/** Estimated row height for virtualization */
const ROW_HEIGHT = 200;

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

  const rowCount = Math.ceil(photos.length / COLUMNS);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  if (isLoading) {
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

  return (
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
              const photo = photos[virtualRow.index * COLUMNS + colIndex];
              return photo ? (
                <PhotoThumbnail key={photo.id} photo={photo} />
              ) : null;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
