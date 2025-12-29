import { useCallback, useEffect, useState } from 'react';
import { loadPhoto, releasePhoto, type PhotoLoadResult } from '../../lib/photo-service';
import type { PhotoMeta } from '../../workers/types';

interface PhotoThumbnailProps {
  photo: PhotoMeta;
  /** Epoch read key for decryption */
  epochReadKey?: Uint8Array;
  /** Callback when thumbnail is clicked */
  onClick?: () => void;
  /** Whether this photo is selected (for bulk operations) */
  isSelected?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selected: boolean) => void;
  /** Callback to delete this photo (receives thumbnail blob URL if loaded) */
  onDelete?: (thumbnailUrl?: string) => void;
  /** Whether selection mode is active */
  selectionMode?: boolean;
  /** Optional style overrides */
  style?: React.CSSProperties;
}

/** Loading state for thumbnail */
type ThumbnailState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number }
  | { status: 'loaded'; result: PhotoLoadResult }
  | { status: 'error'; error: Error };

/**
 * Photo Thumbnail Component
 * Displays a single photo in the grid with encrypted shard loading
 */
export function PhotoThumbnail({
  photo,
  epochReadKey,
  onClick,
  isSelected = false,
  onSelectionChange,
  onDelete,
  selectionMode = false,
  style,
}: PhotoThumbnailProps) {
  const [state, setState] = useState<ThumbnailState>({ status: 'idle' });
  const [isHovered, setIsHovered] = useState(false);

  // Load photo when component mounts or photo changes
  useEffect(() => {
    // Can't load without epoch key or shard IDs
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

    // Cleanup: release photo reference on unmount
    return () => {
      cancelled = true;
      releasePhoto(photo.id);
    };
  }, [photo.id, photo.shardIds, photo.mimeType, epochReadKey]);

  // Retry handler for failed loads
  const handleRetry = useCallback(() => {
    if (epochReadKey && photo.shardIds?.length > 0) {
      setState({ status: 'idle' });
      // Trigger re-load by updating state (useEffect will pick up the change)
      loadPhoto(photo.id, photo.shardIds, epochReadKey, photo.mimeType, {
        skipCache: true,
      })
        .then((result) => setState({ status: 'loaded', result }))
        .catch((error) => setState({ status: 'error', error }));
    }
  }, [photo.id, photo.shardIds, photo.mimeType, epochReadKey]);

  // Render based on state
  const renderContent = () => {
    switch (state.status) {
      case 'idle':
        // No epoch key or shard IDs - show placeholder
        return (
          <div className="photo-placeholder" data-testid="photo-placeholder">
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
          <div className="photo-loading" data-testid="photo-loading">
            <div className="loading-spinner" />
            {state.progress > 0 && (
              <div
                className="loading-progress"
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
            className="photo-image"
            data-testid="photo-image"
            loading="lazy"
          />
        );

      case 'error':
        return (
          <div className="photo-error" data-testid="photo-error">
            <span className="error-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </span>
            <span className="error-message">Failed to load</span>
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

  // Handle click - in selection mode, toggle selection; otherwise open photo
  const handleClick = useCallback(() => {
    if (selectionMode && onSelectionChange) {
      onSelectionChange(!isSelected);
    } else if (onClick && state.status === 'loaded') {
      onClick();
    }
  }, [selectionMode, onSelectionChange, isSelected, onClick, state.status]);

  // Handle checkbox click in selection mode
  const handleCheckboxClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (onSelectionChange) {
        onSelectionChange(!isSelected);
      }
    },
    [onSelectionChange, isSelected]
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (onDelete) {
        const url = state.status === 'loaded' ? state.result.blobUrl : undefined;
        onDelete(url);
      }
    },
    [onDelete, state]
  );

  // Handle keyboard activation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && onClick && state.status === 'loaded') {
        event.preventDefault();
        if (selectionMode && onSelectionChange) {
          onSelectionChange(!isSelected);
        } else {
          onClick();
        }
      }
      // Delete on Delete/Backspace key when focused
      if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
        event.preventDefault();
        const url = state.status === 'loaded' ? state.result.blobUrl : undefined;
        onDelete(url);
      }
    },
    [onClick, state, selectionMode, onSelectionChange, isSelected, onDelete]
  );

  // Get thumbnail URL for delete dialog if loaded
  const thumbnailUrl = state.status === 'loaded' ? state.result.blobUrl : undefined;

  return (
    <div
      className={`photo-thumbnail ${isSelected ? 'photo-thumbnail-selected' : ''} ${selectionMode ? 'photo-thumbnail-selection-mode' : ''}`}
      data-testid="photo-thumbnail"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && state.status === 'loaded' ? 0 : undefined}
      aria-label={onClick ? `View ${photo.filename}` : undefined}
      aria-selected={isSelected}
      data-photo-id={photo.id}
      data-thumbnail-url={thumbnailUrl}
      style={style}
    >
      {/* Selection checkbox (shown in selection mode or on hover) */}
      {(selectionMode || (isHovered && onSelectionChange)) && (
        <div className="photo-selection-overlay">
          <input
            type="checkbox"
            className="photo-checkbox"
            checked={isSelected}
            onChange={() => onSelectionChange?.(!isSelected)}
            onClick={handleCheckboxClick}
            aria-label={`Select ${photo.filename}`}
            data-testid="photo-checkbox"
          />
        </div>
      )}

      {/* Delete button (shown on hover when not in selection mode) */}
      {isHovered && !selectionMode && onDelete && (
        <button
          className="photo-delete-button"
          onClick={handleDeleteClick}
          aria-label={`Delete ${photo.filename}`}
          title="Delete photo"
          data-testid="photo-delete-button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      )}

      <div className="photo-content">{renderContent()}</div>
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
