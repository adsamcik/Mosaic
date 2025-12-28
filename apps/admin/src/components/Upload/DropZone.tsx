import { useCallback, useRef, useState } from 'react';
import { useUploadContext } from '../../contexts/UploadContext';

interface DropZoneProps {
  albumId: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Drop Zone Component
 * Wraps content and provides drag-and-drop file upload functionality.
 * Shows visual feedback when files are dragged over.
 */
export function DropZone({ albumId, children, className = '' }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const { upload, isUploading, progress } = useUploadContext();

  // Handle drag enter
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    
    // Check if dragged items contain files
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  // Handle drag leave
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  // Handle drag over (required to allow drop)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Handle drop
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // Filter for image files
      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith('image/')
      );

      if (imageFiles.length === 0) {
        console.warn('No image files found in drop');
        return;
      }

      // Upload all image files
      for (const file of imageFiles) {
        await upload(file, albumId);
      }
    },
    [upload, albumId]
  );

  return (
    <div
      className={`drop-zone ${isDragging ? 'drop-zone--active' : ''} ${className}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-testid="drop-zone"
    >
      {children}

      {/* Drag overlay */}
      {isDragging && (
        <div className="drop-zone-overlay" data-testid="drop-zone-overlay">
          <div className="drop-zone-indicator">
            <span className="drop-zone-icon">📷</span>
            <span className="drop-zone-text">Drop photos here</span>
          </div>
        </div>
      )}

      {/* Upload progress indicator */}
      {isUploading && (
        <div className="drop-zone-progress" data-testid="upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="drop-zone-progress-bar">
            <div
              className="drop-zone-progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="drop-zone-progress-text">
            Uploading... {progress}%
          </span>
        </div>
      )}
    </div>
  );
}
