import { useCallback, useMemo, useState } from 'react';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import { useLightbox } from '../../hooks/useLightbox';
import { useAlbumMembers } from '../../hooks/useMemberManagement';
import { usePhotos } from '../../hooks/usePhotos';
import type { GeoFeature, PhotoMeta } from '../../workers/types';
import { MemberList } from '../Members/MemberList';
import { ShareLinksPanel } from '../ShareLinks/ShareLinksPanel';
import { DropZone } from '../Upload/DropZone';
import { UploadButton } from '../Upload/UploadButton';
import { MapView } from './MapView';
import { PhotoGrid } from './PhotoGrid';
import { PhotoLightbox } from './PhotoLightbox';
import { SearchInput } from './SearchInput';

/** View mode for the gallery */
export type GalleryViewMode = 'grid' | 'map';

interface GalleryProps {
  albumId: string;
}

/**
 * Convert photos with geolocation to GeoFeatures for the map
 */
function photosToGeoFeatures(photos: PhotoMeta[]): GeoFeature[] {
  return photos
    .filter((p) => p.lat !== undefined && p.lng !== undefined)
    .map((p) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [p.lng!, p.lat!] as [number, number],
      },
      properties: {
        id: p.id,
      },
    }));
}

/**
 * Gallery View Component
 * Displays photos in a virtualized grid or map view with upload capability
 */
export function Gallery({ albumId }: GalleryProps) {
  const [showMembers, setShowMembers] = useState(false);
  const [showShareLinks, setShowShareLinks] = useState(false);
  const [viewMode, setViewMode] = useState<GalleryViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');

  const { photos, isLoading, error } = usePhotos(albumId, searchQuery);
  const { epochKeys } = useAlbumEpochKeys(albumId);
  const { isOwner } = useAlbumMembers(albumId);
  const lightbox = useLightbox(photos);

  // Convert photos to GeoFeatures for map view
  const geoFeatures = useMemo(() => photosToGeoFeatures(photos), [photos]);

  // Count geotagged photos
  const geotaggedCount = geoFeatures.length;

  // Handle photo click from map
  const handleMapPhotoClick = useCallback(
    (photoId: string) => {
      const index = photos.findIndex((p) => p.id === photoId);
      if (index >= 0) {
        lightbox.open(index);
      }
    },
    [photos, lightbox]
  );

  // Handle cluster click from map - open lightbox with first photo
  const handleMapClusterClick = useCallback(
    (photoIds: string[]) => {
      if (photoIds.length > 0) {
        const index = photos.findIndex((p) => p.id === photoIds[0]);
        if (index >= 0) {
          lightbox.open(index);
        }
      }
    },
    [photos, lightbox]
  );

  // Compute preload queue for lightbox
  const preloadQueue = useMemo((): PhotoMeta[] => {
    if (!lightbox.isOpen || !lightbox.currentPhoto) return [];

    const queue: PhotoMeta[] = [];
    const currentIdx = lightbox.currentIndex;
    const PRELOAD_COUNT = 2;

    for (let offset = 1; offset <= PRELOAD_COUNT; offset++) {
      const prevPhoto = photos[currentIdx - offset];
      const nextPhoto = photos[currentIdx + offset];
      if (prevPhoto) queue.push(prevPhoto);
      if (nextPhoto) queue.push(nextPhoto);
    }

    return queue;
  }, [lightbox.isOpen, lightbox.currentIndex, lightbox.currentPhoto, photos]);

  // Get epoch read key for current lightbox photo
  const currentEpochReadKey = lightbox.currentPhoto
    ? epochKeys.get(lightbox.currentPhoto.epochId)
    : undefined;

  // Loading state
  if (isLoading) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-loading">
          <div className="loading-spinner" />
          <p>Loading photos...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="gallery" data-testid="gallery">
        <div className="gallery-error">
          <p>Failed to load photos: {error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="gallery" data-testid="gallery">
      <div className="gallery-header">
        <h2 className="gallery-title">Photos</h2>
        
        {/* Search Input */}
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search photos by filename..."
          className="gallery-search"
        />
        
        <div className="gallery-actions">
          {/* View Mode Toggle */}
          <div className="view-toggle" role="group" aria-label="View mode">
            <button
              className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              title="Grid view"
              data-testid="view-toggle-grid"
            >
              <span className="view-toggle-icon">▦</span>
              <span className="view-toggle-label">Grid</span>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'map' ? 'view-toggle-btn--active' : ''}`}
              onClick={() => setViewMode('map')}
              aria-pressed={viewMode === 'map'}
              title={`Map view (${geotaggedCount} geotagged)`}
              data-testid="view-toggle-map"
            >
              <span className="view-toggle-icon">🗺️</span>
              <span className="view-toggle-label">Map</span>
              {geotaggedCount > 0 && (
                <span className="view-toggle-badge">{geotaggedCount}</span>
              )}
            </button>
          </div>

          <button
            className="button-secondary share-button"
            onClick={() => setShowMembers(true)}
            aria-label="Manage album members"
            data-testid="share-button"
          >
            <span className="share-icon">👥</span>
            Share
          </button>
          {isOwner && (
            <button
              className="button-secondary share-links-button"
              onClick={() => setShowShareLinks(true)}
              aria-label="Manage share links"
              data-testid="share-links-button"
            >
              <span className="share-links-icon">🔗</span>
              Links
            </button>
          )}
          <UploadButton albumId={albumId} />
        </div>
      </div>

      {/* Gallery Content - Wrapped in DropZone for drag-and-drop upload */}
      <DropZone albumId={albumId} className="gallery-content">
        {viewMode === 'grid' ? (
          <PhotoGrid albumId={albumId} />
        ) : (
          <MapView
            albumId={albumId}
            points={geoFeatures}
            photos={photos}
            onPhotoClick={handleMapPhotoClick}
            onClusterClick={handleMapClusterClick}
          />
        )}
      </DropZone>

      {/* Member List Modal */}
      <MemberList
        albumId={albumId}
        isOpen={showMembers}
        onClose={() => setShowMembers(false)}
      />

      {/* Share Links Panel (owners only) */}
      {isOwner && (
        <ShareLinksPanel
          albumId={albumId}
          isOpen={showShareLinks}
          onClose={() => setShowShareLinks(false)}
          isOwner={isOwner}
        />
      )}

      {/* Photo Lightbox */}
      {lightbox.isOpen && lightbox.currentPhoto && currentEpochReadKey && (
        <PhotoLightbox
          photo={lightbox.currentPhoto}
          epochReadKey={currentEpochReadKey}
          onClose={lightbox.close}
          {...(lightbox.hasNext && { onNext: lightbox.next })}
          {...(lightbox.hasPrevious && { onPrevious: lightbox.previous })}
          hasNext={lightbox.hasNext}
          hasPrevious={lightbox.hasPrevious}
          preloadQueue={preloadQueue}
        />
      )}
    </div>
  );
}
