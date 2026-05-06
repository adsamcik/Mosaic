/**
 * Justified Photo Thumbnail Component
 *
 * A photo thumbnail designed for the justified grid layout.
 * Displays at specified dimensions while loading encrypted content.
 *
 * Optimization: Uses embedded base64 thumbnails first when available,
 * only loading full shards when explicitly requested or when no thumbnail exists.
 *
 * Loading priority (instant to slow):
 * 1. BlurHash placeholder (instant, ~30 char string decoded in <1ms)
 * 2. Embedded thumbnail (fast, base64 in manifest)
 * 3. Full resolution shards (slow, network + decryption)
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  getCachedPlaceholderDataURL,
  isValidPlaceholderHash,
} from '../../lib/thumbhash-decoder';
import type { EpochHandleId, PhotoMeta } from '../../workers/types';
import { formatDuration } from '../../lib/video-frame-extractor';
import { useThumbnailShard } from '../../hooks/useThumbnailShard';

interface JustifiedPhotoThumbnailProps {
  photo: PhotoMeta;
  /** Display width in pixels */
  width: number;
  /** Display height in pixels */
  height: number;
  /** Epoch handle id for decryption (undefined if key not yet loaded) */
  epochReadKey: EpochHandleId | undefined;
  /** Callback when thumbnail is clicked */
  onClick?: () => void;
  /** Whether this photo is selected */
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
  /** Whether to show delete button on hover */
  showDelete?: boolean;
  /** Whether to load full resolution shards (for lightbox/fullscreen) */
  loadFullResolution?: boolean;
}

/**
 * Justified Photo Thumbnail Component
 * Displays a single photo in the justified grid with encrypted loading
 */
export const JustifiedPhotoThumbnail = memo(function JustifiedPhotoThumbnail({
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
  loadFullResolution = false,
}: JustifiedPhotoThumbnailProps) {
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
  // Handles both base64 thumbnails and blob URLs from pending uploads
  const embeddedThumbnailUrl = useMemo(() => {
    if (!photo.thumbnail || photo.thumbnail.length === 0) return null;
    // Check if it's already a URL (blob: or data: or http:)
    if (
      photo.thumbnail.startsWith('blob:') ||
      photo.thumbnail.startsWith('data:') ||
      photo.thumbnail.startsWith('http')
    ) {
      return photo.thumbnail;
    }
    // Otherwise treat as base64
    return `data:image/jpeg;base64,${photo.thumbnail}`;
  }, [photo.thumbnail]);

  // Handle click - allow clicking when any visual is available (blurhash, embedded thumbnail, or fully loaded)
  const isClickable =
    placeholderUrl || embeddedThumbnailUrl || state.status === 'loaded';

  // For 90°/270° rotations the rotated thumbnail may overflow its tile slightly. v1 trade-off: accept the visual imperfection rather than re-laying out the justified grid for rotated photos.
  const rotationStyle = {
    transform: `rotate(${photo.rotation ?? 0}deg)`,
    transformOrigin: 'center',
  };

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

  // Handle checkbox click
  const handleCheckboxClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSelectionChange?.(!isSelected, event);
    },
    [onSelectionChange, isSelected],
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const thumbnailUrl =
        state.status === 'loaded'
          ? state.result.blobUrl
          : (embeddedThumbnailUrl ?? undefined);
      onDelete?.(thumbnailUrl);
    },
    [onDelete, state, embeddedThumbnailUrl],
  );

  // Handle keyboard activation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && isClickable) {
        event.preventDefault();
        if (selectionMode && onSelectionChange) {
          onSelectionChange(!isSelected, event);
        } else if (onClick) {
          onClick();
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
        event.preventDefault();
        const thumbnailUrl =
          state.status === 'loaded'
            ? state.result.blobUrl
            : (embeddedThumbnailUrl ?? undefined);
        onDelete(thumbnailUrl);
      }
    },
    [
      isClickable,
      selectionMode,
      onSelectionChange,
      isSelected,
      onClick,
      onDelete,
      state,
      embeddedThumbnailUrl,
    ],
  );

  // Render content based on state
  // Priority: full resolution > embedded thumbnail > blurhash > placeholder
  const renderContent = () => {
    // If fully loaded, show full resolution image
    if (state.status === 'loaded') {
      return (
        <img
          src={state.result.blobUrl}
          alt={photo.filename}
          className="justified-photo-image"
          data-testid="photo-image"
          loading="lazy"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            ...rotationStyle,
          }}
        />
      );
    }

    // If we have an embedded thumbnail and aren't loading full resolution, show it
    if (embeddedThumbnailUrl && !loadFullResolution) {
      return (
        <img
          src={embeddedThumbnailUrl}
          alt={photo.filename}
          className="justified-photo-image justified-photo-thumbnail-embedded"
          data-testid="photo-image-embedded"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            ...rotationStyle,
          }}
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
        <div
          className="justified-photo-upgrading"
          data-testid="photo-upgrading"
        >
          <img
            src={embeddedThumbnailUrl}
            alt={photo.filename}
            className="justified-photo-image justified-photo-thumbnail-embedded"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              ...rotationStyle,
            }}
          />
          <div className="justified-photo-upgrade-overlay">
            <div className="loading-spinner-small" />
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
        <div className="justified-photo-blurhash" data-testid="photo-blurhash">
          <img
            src={placeholderUrl}
            alt=""
            aria-hidden="true"
            className="justified-photo-blurhash-image"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(0px)',
            }}
          />
          {state.status === 'loading' && state.progress > 0 && (
            <div
              className="loading-progress-bar"
              style={{ width: `${state.progress * 100}%` }}
            />
          )}
        </div>
      );
    }

    switch (state.status) {
      case 'idle':
        return (
          <div
            className="justified-photo-placeholder"
            data-testid="photo-placeholder"
          >
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

      case 'error':
        return (
          <div className="justified-photo-error" data-testid="photo-error">
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
      tabIndex={onClick && isClickable ? 0 : undefined}
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
      {isHovered &&
        !selectionMode &&
        showDelete &&
        onDelete &&
        !photo.isPending && (
          <button
            className="justified-photo-delete"
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

      {/* Pending upload overlay */}
      {photo.isPending && (
        <div
          className="justified-photo-pending-overlay"
          data-testid="photo-pending-overlay"
        >
          {/* Progress bar */}
          <div className="pending-progress-container">
            <div
              className={`pending-progress-bar ${photo.uploadAction === 'encrypting' ? 'encrypting' : ''} ${photo.isSyncing ? 'syncing' : ''}`}
              style={{
                width: `${photo.isSyncing ? 100 : (photo.uploadProgress ?? 0)}%`,
              }}
            />
          </div>

          {/* Status with icon */}
          <div className="pending-status">
            {photo.uploadError ? (
              <span className="pending-status-error">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <span>Failed</span>
              </span>
            ) : photo.isSyncing ? (
              <span className="pending-status-syncing">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                <span>Syncing</span>
              </span>
            ) : photo.uploadAction === 'waiting' ? (
              <span className="pending-status-waiting">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>Waiting</span>
              </span>
            ) : photo.uploadAction === 'encrypting' ? (
              <span className="pending-status-encrypting">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
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
                <span>Encrypting</span>
              </span>
            ) : photo.uploadAction === 'uploading' ? (
              <span className="pending-status-uploading">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{Math.round(photo.uploadProgress ?? 0)}%</span>
              </span>
            ) : (
              <span className="pending-status-finalizing">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Finalizing</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Photo content */}
      <div className="justified-photo-content">{renderContent()}</div>

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
});
