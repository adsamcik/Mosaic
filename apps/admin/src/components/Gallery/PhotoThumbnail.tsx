import type { PhotoMeta } from '../../workers/types';

interface PhotoThumbnailProps {
  photo: PhotoMeta;
}

/**
 * Photo Thumbnail Component
 * Displays a single photo in the grid
 */
export function PhotoThumbnail({ photo }: PhotoThumbnailProps) {
  // TODO: Implement actual thumbnail loading from encrypted shards
  // For now, show a placeholder with photo metadata
  
  return (
    <div className="photo-thumbnail" data-testid="photo-thumbnail">
      <div className="photo-placeholder">
        <span className="photo-icon">🖼️</span>
      </div>
      <div className="photo-info">
        <span className="photo-filename" title={photo.filename}>
          {photo.filename}
        </span>
        {photo.takenAt && (
          <span className="photo-date">
            {new Date(photo.takenAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
