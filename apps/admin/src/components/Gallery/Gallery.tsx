import { useState } from 'react';
import { PhotoGrid } from './PhotoGrid';
import { UploadButton } from '../Upload/UploadButton';
import { MemberList } from '../Members/MemberList';

interface GalleryProps {
  albumId: string;
}

/**
 * Gallery View Component
 * Displays photos in a virtualized grid with upload capability
 */
export function Gallery({ albumId }: GalleryProps) {
  const [showMembers, setShowMembers] = useState(false);

  return (
    <div className="gallery" data-testid="gallery">
      <div className="gallery-header">
        <h2 className="gallery-title">Photos</h2>
        <div className="gallery-actions">
          <button
            className="button-secondary share-button"
            onClick={() => setShowMembers(true)}
            aria-label="Manage album members"
            data-testid="share-button"
          >
            <span className="share-icon">👥</span>
            Share
          </button>
          <UploadButton albumId={albumId} />
        </div>
      </div>
      <PhotoGrid albumId={albumId} />
      <MemberList
        albumId={albumId}
        isOpen={showMembers}
        onClose={() => setShowMembers(false)}
      />
    </div>
  );
}
