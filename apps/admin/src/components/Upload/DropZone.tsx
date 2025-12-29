import { useCallback, useRef, useState } from 'react';
import { useUploadContext } from '../../contexts/UploadContext';
import { createLogger } from '../../lib/logger';

const log = createLogger('DropZone');

interface DropZoneProps {
  albumId: string;
  children: React.ReactNode;
  className?: string;
  /** Whether drop is disabled (e.g., user doesn't have upload permission) */
  disabled?: boolean;
}

/**
 * Drop Zone Component
 * Wraps content and provides drag-and-drop file upload functionality.
 * Shows visual feedback when files are dragged over.
 */
export function DropZone({ albumId, children, className = '', disabled = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const { upload } = useUploadContext();

  // Handle drag enter
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    
    dragCounterRef.current += 1;
    
    // Check if dragged items contain files
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, [disabled]);

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
      
      if (disabled) return;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // Filter for image files
      const imageFiles = Array.from(files).filter((file) =>
        file.type.startsWith('image/')
      );

      if (imageFiles.length === 0) {
        log.warn('No image files found in drop');
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
            <span className="drop-zone-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </span>
            <span className="drop-zone-text">Drop photos here</span>
          </div>
        </div>
      )}


    </div>
  );
}
