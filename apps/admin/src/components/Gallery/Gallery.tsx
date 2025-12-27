import { PhotoGrid } from './PhotoGrid';
import { UploadButton } from '../Upload/UploadButton';

interface GalleryProps {
  albumId: string;
}

/**
 * Gallery View Component
 * Displays photos in a virtualized grid with upload capability
 */
export function Gallery({ albumId }: GalleryProps) {
  return (
    <div className="gallery">
      <div className="gallery-header">
        <h2 className="gallery-title">Photos</h2>
        <UploadButton albumId={albumId} />
      </div>
      <PhotoGrid albumId={albumId} />
    </div>
  );
}
