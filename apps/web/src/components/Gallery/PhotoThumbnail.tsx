import { memo, useCallback, useMemo, useState } from 'react';
import {
  getCachedPlaceholderDataURL,
  isValidPlaceholderHash,
} from '../../lib/thumbhash-decoder';
import type { EpochHandleId, PhotoMeta } from '../../workers/types';
import { formatDuration } from '../../lib/video-frame-extractor';
import { useThumbnailShard } from '../../hooks/useThumbnailShard';

interface PhotoThumbnailProps {
  photo: PhotoMeta;
  /** Epoch handle id for decryption */
  epochReadKey?: EpochHandleId;
  /** Callback when thumbnail is clicked */
  onClick?: () => void;
  /** Whether this photo is selected (for bulk operations) */
  isSelected?: boolean;
  /** Callback when selection changes (includes event for shift-click detection) */
  onSelectionChange?: (
    selected: boolean,
    event?: React.MouseEvent | React.KeyboardEvent,
  ) => void;
  /** Callback to delete this photo (receives thumbnail blob URL if loaded) */
  onDelete?: (thumbnailUrl?: string) => void;
  /** Whether selection mode is active */
  selectionMode?: boolean;
  /** Optional style overrides */
  style?: React.CSSProperties;
  /** Whether to load full resolution shards (for lightbox/fullscreen) */
  loadFullResolution?: boolean;
}

/**
 * Photo Thumbnail Component
 * Displays a single photo in the grid with encrypted shard loading.
 *
 * Optimization: Uses embedded base64 thumbnails first when available,
 * only loading full shards when explicitly requested or when no thumbnail exists.
 *
 * Loading priority (instant to slow):
 * 1. BlurHash placeholder (instant, ~30 char string decoded in <1ms)
 * 2. Embedded thumbnail (fast, base64 in manifest)
 * 3. Full resolution shards (slow, network + decryption)
 */
export const PhotoThumbnail = memo(function PhotoThumbnail({
  photo,
  epochReadKey,
  onClick,
  isSelected = false,
  onSelectionChange,
  onDelete,
  selectionMode = false,
  style,
  loadFullResolution = false,
}: PhotoThumbnailProps) {
  const { state, handleRetry } = useThumbnailShard({
    photoId: photo.id,
    shardIds: photo.shardIds,
    mimeType: photo.mimeType,
    hasThumbnail: !!photo.thumbnail,
    epochReadKey,
    loadFullResolution,
  });

  const [isHovered, setIsHovered] = useState(false);

  // Placeholder (ThumbHash or legacy BlurHash) - instant, decoded in <1ms
  const placeholderUrl = useMemo(() => {
    const hash = photo.thumbhash || photo.blurhash;
    if (!hash || !isValidPlaceholderHash(hash)) return null;
    return getCachedPlaceholderDataURL(hash);
  }, [photo.thumbhash, photo.blurhash]);

  // Use embedded thumbnail immediately if available (no network request needed)
  const embeddedThumbnailUrl = useMemo(() => {
    if (!photo.thumbnail || photo.thumbnail.length === 0) return null;
    return `data:image/jpeg;base64,${photo.thumbnail}`;
  }, [photo.thumbnail]);

  // Render based on state
  // Priority: full resolution > embedded thumbnail > blurhash > placeholder
  const renderContent = () => {
    // If fully loaded, show full resolution image
    if (state.status === 'loaded') {
      return (
        <img
          src={state.result.blobUrl}
          alt={photo.filename}
          className="photo-image"
          data-testid="photo-image"
          loading="lazy"
        />
      );
    }

    // If we have an embedded thumbnail and aren't loading full resolution, show it
    if (embeddedThumbnailUrl && !loadFullResolution) {
      return (
        <img
          src={embeddedThumbnailUrl}
          alt={photo.filename}
          className="photo-image photo-thumbnail-embedded"
          data-testid="photo-image-embedded"
        />
      );
    }

    // If loading full resolution and have embedded thumbnail, show it as placeholder while loading
    if (
      embeddedThumbnailUrl &&
      loadFullResolution &&
      state.status === 'loading'
    ) {
      return (
        <div className="photo-upgrading" data-testid="photo-upgrading">
          <img
            src={embeddedThumbnailUrl}
            alt={photo.filename}
            className="photo-image photo-thumbnail-embedded"
          />
          <div className="photo-upgrade-overlay">
            <div className="loading-spinner" />
          </div>
        </div>
      );
    }

    // If we have a blurhash, show it as instant placeholder while loading
    if (
      placeholderUrl &&
      (state.status === 'idle' || state.status === 'loading')
    ) {
      return (
        <div className="photo-blurhash" data-testid="photo-blurhash">
          <img
            src={placeholderUrl}
            alt=""
            aria-hidden="true"
            className="photo-blurhash-image"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(0px)',
            }}
          />
          {state.status === 'loading' && state.progress > 0 && (
            <div
              className="loading-progress"
              style={{ width: `${state.progress * 100}%` }}
            />
          )}
        </div>
      );
    }

    switch (state.status) {
      case 'idle':
        // No epoch key or shard IDs - show placeholder
        return (
          <div className="photo-placeholder" data-testid="photo-placeholder">
            <span className="photo-icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </span>
            {!epochReadKey && (
              <span className="photo-locked">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
            )}
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

      case 'error':
        return (
          <div className="photo-error" data-testid="photo-error">
            <span className="error-icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
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

  // Allow clicking when any visual is available (blurhash, embedded thumbnail, or fully loaded)
  const isClickable =
    placeholderUrl || embeddedThumbnailUrl || state.status === 'loaded';

  // Handle click - in selection mode, toggle selection; otherwise open photo
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (selectionMode && onSelectionChange) {
        onSelectionChange(!isSelected, event);
      } else if (onClick && isClickable) {
        onClick();
      }
    },
    [selectionMode, onSelectionChange, isSelected, onClick, isClickable],
  );

  // Handle checkbox click in selection mode
  const handleCheckboxClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (onSelectionChange) {
        onSelectionChange(!isSelected, event);
      }
    },
    [onSelectionChange, isSelected],
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (onDelete) {
        const url =
          state.status === 'loaded'
            ? state.result.blobUrl
            : (embeddedThumbnailUrl ?? undefined);
        onDelete(url);
      }
    },
    [onDelete, state, embeddedThumbnailUrl],
  );

  // Handle keyboard activation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        onClick &&
        isClickable
      ) {
        event.preventDefault();
        if (selectionMode && onSelectionChange) {
          onSelectionChange(!isSelected, event);
        } else {
          onClick();
        }
      }
      // Delete on Delete/Backspace key when focused
      if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
        event.preventDefault();
        const url =
          state.status === 'loaded'
            ? state.result.blobUrl
            : (embeddedThumbnailUrl ?? undefined);
        onDelete(url);
      }
    },
    [
      onClick,
      isClickable,
      selectionMode,
      onSelectionChange,
      isSelected,
      onDelete,
      state,
      embeddedThumbnailUrl,
    ],
  );

  // Get thumbnail URL for delete dialog if loaded or embedded
  const thumbnailUrl =
    state.status === 'loaded'
      ? state.result.blobUrl
      : (embeddedThumbnailUrl ?? undefined);

  return (
    <div
      className={`photo-thumbnail ${isSelected ? 'photo-thumbnail-selected' : ''} ${selectionMode ? 'photo-thumbnail-selection-mode' : ''}`}
      data-testid="photo-thumbnail"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && isClickable ? 0 : undefined}
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}

      <div className="photo-content">{renderContent()}</div>

      {/* Video indicators */}
      {photo.isVideo && (
        <>
          <div className="video-play-overlay" data-testid="video-play-overlay">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <polygon points="6,3 20,12 6,21" />
            </svg>
          </div>
          {photo.duration != null && photo.duration > 0 && (
            <span className="video-duration-badge" data-testid="video-duration-badge">
              {formatDuration(photo.duration)}
            </span>
          )}
        </>
      )}

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
});
