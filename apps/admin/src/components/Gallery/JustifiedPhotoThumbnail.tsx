/**
 * Justified Photo Thumbnail Component
 *
 * A photo thumbnail designed for the justified grid layout.
 * Displays at specified dimensions while loading encrypted content.
 */

import { useCallback, useEffect, useState } from 'react';
import { loadPhoto, releasePhoto, type PhotoLoadResult } from '../../lib/photo-service';
import type { PhotoMeta } from '../../workers/types';

interface JustifiedPhotoThumbnailProps {
  photo: PhotoMeta;
  /** Display width in pixels */
  width: number;
  /** Display height in pixels */
  height: number;
  /** Epoch read key for decryption (undefined if key not yet loaded) */
  epochReadKey: Uint8Array | undefined;
  /** Callback when thumbnail is clicked */
  onClick?: () => void;
  /** Whether this photo is selected */
  isSelected?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selected: boolean) => void;
  /** Callback to delete this photo (receives thumbnail blob URL if loaded) */
  onDelete?: (thumbnailUrl?: string) => void;
  /** Whether selection mode is active */
  selectionMode?: boolean;
  /** Whether to show delete button on hover */
  showDelete?: boolean;
}

/** Loading state for thumbnail */
type ThumbnailState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number }
  | { status: 'loaded'; result: PhotoLoadResult }
  | { status: 'error'; error: Error };

/**
 * Justified Photo Thumbnail Component
 * Displays a single photo in the justified grid with encrypted loading
 */
export function JustifiedPhotoThumbnail({
  photo,
  width,
  height,
  epochReadKey,
  onClick,
  isSelected = false,
  onSelectionChange,
  onDelete,
  selectionMode = false,
  showDelete = true,
}: JustifiedPhotoThumbnailProps) {
  const [state, setState] = useState<ThumbnailState>({ status: 'idle' });
  const [isHovered, setIsHovered] = useState(false);

  // Load photo when component mounts or photo changes
  useEffect(() => {
    if (!epochReadKey || !photo.shardIds || photo.shardIds.length === 0) {
      return;
    }

    let cancelled = false;

    async function load() {
      setState({ status: 'loading', progress: 0 });

      try {
        const result = await loadPhoto(
          photo.id,
          photo.shardIds,
          epochReadKey!,
          photo.mimeType,
          {
            onProgress: (loaded, total) => {
              if (!cancelled) {
                const progress = total > 0 ? loaded / total : 0;
                setState({ status: 'loading', progress });
              }
            },
          }
        );

        if (!cancelled) {
          setState({ status: 'loaded', result });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      releasePhoto(photo.id);
    };
  }, [photo.id, photo.shardIds, photo.mimeType, epochReadKey]);

  // Retry handler for failed loads
  const handleRetry = useCallback(() => {
    if (epochReadKey && photo.shardIds?.length > 0) {
      setState({ status: 'idle' });
      loadPhoto(photo.id, photo.shardIds, epochReadKey, photo.mimeType, {
        skipCache: true,
      })
        .then((result) => setState({ status: 'loaded', result }))
        .catch((error) => setState({ status: 'error', error }));
    }
  }, [photo.id, photo.shardIds, photo.mimeType, epochReadKey]);

  // Handle click
  const handleClick = useCallback(() => {
    if (selectionMode && onSelectionChange) {
      onSelectionChange(!isSelected);
    } else if (onClick && state.status === 'loaded') {
      onClick();
    }
  }, [selectionMode, onSelectionChange, isSelected, onClick, state.status]);

  // Handle checkbox click
  const handleCheckboxClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSelectionChange?.(!isSelected);
    },
    [onSelectionChange, isSelected]
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const thumbnailUrl = state.status === 'loaded' ? state.result.blobUrl : undefined;
      onDelete?.(thumbnailUrl);
    },
    [onDelete, state]
  );

  // Handle keyboard activation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && state.status === 'loaded') {
        event.preventDefault();
        if (selectionMode && onSelectionChange) {
          onSelectionChange(!isSelected);
        } else if (onClick) {
          onClick();
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
        event.preventDefault();
        const thumbnailUrl = state.status === 'loaded' ? state.result.blobUrl : undefined;
        onDelete(thumbnailUrl);
      }
    },
    [state.status, selectionMode, onSelectionChange, isSelected, onClick, onDelete]
  );

  // Render content based on state
  const renderContent = () => {
    switch (state.status) {
      case 'idle':
        return (
          <div className="justified-photo-placeholder" data-testid="photo-placeholder">
            <span className="photo-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </span>
            {!epochReadKey && <span className="photo-locked">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>}
          </div>
        );

      case 'loading':
        return (
          <div className="justified-photo-loading" data-testid="photo-loading">
            <div className="loading-spinner-small" />
            {state.progress > 0 && (
              <div
                className="loading-progress-bar"
                style={{ width: `${state.progress * 100}%` }}
              />
            )}
          </div>
        );

      case 'loaded':
        return (
          <img
            src={state.result.blobUrl}
            alt={photo.filename}
            className="justified-photo-image"
            data-testid="photo-image"
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        );

      case 'error':
        return (
          <div className="justified-photo-error" data-testid="photo-error">
            <span className="error-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </span>
            <button
              className="retry-button"
              onClick={(e) => {
                e.stopPropagation();
                handleRetry();
              }}
              title="Retry loading"
            >
              ↻
            </button>
          </div>
        );
    }
  };

  return (
    <div
      className={`justified-photo-thumbnail ${isSelected ? 'justified-photo-selected' : ''} ${selectionMode ? 'justified-photo-selection-mode' : ''}`}
      data-testid="justified-photo-thumbnail"
      style={{ width, height, flexShrink: 0 }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && state.status === 'loaded' ? 0 : undefined}
      aria-label={onClick ? `View ${photo.filename}` : undefined}
      aria-selected={isSelected}
      data-photo-id={photo.id}
    >
      {/* Selection checkbox */}
      {(selectionMode || (isHovered && onSelectionChange)) && (
        <div className="justified-photo-selection-overlay">
          <input
            type="checkbox"
            className="justified-photo-checkbox"
            checked={isSelected}
            onChange={() => onSelectionChange?.(!isSelected)}
            onClick={handleCheckboxClick}
            aria-label={`Select ${photo.filename}`}
            data-testid="photo-checkbox"
          />
        </div>
      )}

      {/* Delete button */}
      {isHovered && !selectionMode && showDelete && onDelete && (
        <button
          className="justified-photo-delete"
          onClick={handleDeleteClick}
          aria-label={`Delete ${photo.filename}`}
          title="Delete photo"
          data-testid="photo-delete-button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      )}

      {/* Photo content */}
      <div className="justified-photo-content">{renderContent()}</div>

      {/* Photo info overlay on hover */}
      {isHovered && state.status === 'loaded' && (
        <div className="justified-photo-info-overlay">
          <span className="justified-photo-filename">{photo.filename}</span>
          {photo.takenAt && (
            <span className="justified-photo-date">
              {new Date(photo.takenAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
