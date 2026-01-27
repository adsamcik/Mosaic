/**
 * Photo Lightbox Component
 *
 * Full-screen overlay for viewing full-resolution photos.
 * Supports keyboard navigation, touch gestures, and preloading.
 * 
 * Features:
 * - In-memory caching prevents re-downloading viewed photos
 * - Shows embedded thumbnail immediately while loading full-res
 * - Preloads adjacent photos for instant navigation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';
import {
  getCachedPhoto,
  loadPhoto,
  preloadPhotos,
  releasePhoto,
  type PhotoLoadResult,
} from '../../lib/photo-service';
import type { PhotoMeta } from '../../workers/types';

/** Props for the PhotoLightbox component */
export interface PhotoLightboxProps {
  /** The photo to display */
  photo: PhotoMeta;
  /** Epoch read key for decryption */
  epochReadKey: Uint8Array;
  /** Callback to close the lightbox */
  onClose: () => void;
  /** Callback to navigate to next photo */
  onNext?: () => void;
  /** Callback to navigate to previous photo */
  onPrevious?: () => void;
  /** Whether there is a next photo */
  hasNext?: boolean;
  /** Whether there is a previous photo */
  hasPrevious?: boolean;
  /** Photos to preload (next/previous) */
  preloadQueue?: PhotoMeta[];
  /** Show photo metadata */
  showMetadata?: boolean;
  /** Callback to delete the current photo */
  onDelete?: () => void;
}

/** Loading state for the full-resolution photo */
type LoadState =
  | { status: 'loading'; progress: number; thumbnailUrl?: string | undefined }
  | { status: 'loaded'; result: PhotoLoadResult }
  | { status: 'error'; error: Error };

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format date for display
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Photo Lightbox Component
 *
 * Displays a full-resolution photo in a modal overlay with navigation controls.
 */
export function PhotoLightbox({
  photo,
  epochReadKey,
  onClose,
  onNext,
  onPrevious,
  hasNext = false,
  hasPrevious = false,
  preloadQueue = [],
  showMetadata = true,
  onDelete,
}: PhotoLightboxProps) {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<LoadState>({
    status: 'loading',
    progress: 0,
  });
  const [showInfo, setShowInfo] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Generate a unique cache key for full-resolution photos (separate from thumbnails)
  const fullResPhotoId = `${photo.id}:full`;

  // For tiered uploads, shardIds = [thumb, preview, original]
  // Use originalShardIds if available, otherwise extract original from legacy shardIds
  // Memoize to prevent useEffect infinite loop (array reference stability)
  const originalShards = useMemo(() => {
    if (photo.originalShardIds && photo.originalShardIds.length > 0) {
      return photo.originalShardIds;
    }
    if (photo.shardIds.length === 3) {
      return [photo.shardIds[2]!]; // New tiered format: [thumb, preview, original]
    }
    return photo.shardIds; // Legacy format: all shards are original chunks
  }, [photo.originalShardIds, photo.shardIds]);

  // Create a data URL from the embedded thumbnail for immediate display
  const embeddedThumbnailUrl = useMemo(() => {
    if (!photo.thumbnail) return undefined;
    return `data:image/jpeg;base64,${photo.thumbnail}`;
  }, [photo.thumbnail]);

  // Load the full-resolution photo
  useEffect(() => {
    if (!epochReadKey || !originalShards || originalShards.length === 0) {
      setLoadState({
        status: 'error',
        error: new Error('Missing epoch key or shard IDs'),
      });
      return;
    }

    // Check if photo is already cached - if so, use it immediately without showing loading state
    const cached = getCachedPhoto(fullResPhotoId);
    if (cached) {
      setLoadState({ status: 'loaded', result: cached });
      return () => {
        releasePhoto(fullResPhotoId);
      };
    }

    let cancelled = false;

    async function loadFullResolution() {
      // Set loading state with embedded thumbnail for immediate display
      setLoadState({ 
        status: 'loading', 
        progress: 0,
        thumbnailUrl: embeddedThumbnailUrl,
      });

      try {
        const result = await loadPhoto(
          fullResPhotoId,
          originalShards,
          epochReadKey,
          photo.mimeType,
          {
            onProgress: (loaded, total) => {
              if (!cancelled) {
                const progress = total > 0 ? loaded / total : 0;
                setLoadState({ 
                  status: 'loading', 
                  progress,
                  thumbnailUrl: embeddedThumbnailUrl,
                });
              }
            },
          },
        );

        if (!cancelled) {
          setLoadState({ status: 'loaded', result });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    void loadFullResolution();

    return () => {
      cancelled = true;
      releasePhoto(fullResPhotoId);
    };
  }, [fullResPhotoId, originalShards, photo.mimeType, epochReadKey, embeddedThumbnailUrl]);

  // Preload next/previous photos - use original shards only
  useEffect(() => {
    if (preloadQueue.length === 0 || !epochReadKey) return;

    void preloadPhotos(
      preloadQueue.map((p) => {
        // Extract original shards for preloading
        const origShards =
          p.originalShardIds && p.originalShardIds.length > 0
            ? p.originalShardIds
            : p.shardIds.length === 3
              ? [p.shardIds[2]!]
              : p.shardIds;
        return {
          id: `${p.id}:full`,
          shardIds: origShards,
          mimeType: p.mimeType,
        };
      }),
      epochReadKey,
    );
  }, [preloadQueue, epochReadKey]);

  // Retry loading on error
  const handleRetry = useCallback(() => {
    if (!epochReadKey || !originalShards?.length) return;

    setLoadState({ status: 'loading', progress: 0, thumbnailUrl: embeddedThumbnailUrl });

    loadPhoto(fullResPhotoId, originalShards, epochReadKey, photo.mimeType, {
      skipCache: true,
      onProgress: (loaded, total) => {
        const progress = total > 0 ? loaded / total : 0;
        setLoadState({ status: 'loading', progress, thumbnailUrl: embeddedThumbnailUrl });
      },
    })
      .then((result) => setLoadState({ status: 'loaded', result }))
      .catch((error) =>
        setLoadState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
  }, [fullResPhotoId, originalShards, photo.mimeType, epochReadKey, embeddedThumbnailUrl]);

  // Get album permissions for download capability
  const { canDownload } = useAlbumPermissions();

  // Handle download button click
  const handleDownload = useCallback(() => {
    if (loadState.status !== 'loaded') return;

    // Create a temporary anchor element to trigger download
    const link = document.createElement('a');
    link.href = loadState.result.blobUrl;
    link.download = photo.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [loadState, photo.filename]);

  // Handle backdrop click (close on click outside photo)
  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === backdropRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  // Touch handlers for swipe navigation
  const handleTouchStart = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (touch) {
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    }
  }, []);

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      if (!touchStartRef.current) return;

      const touch = event.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      // Minimum swipe distance (50px) and more horizontal than vertical
      const minSwipeDistance = 50;
      if (
        Math.abs(deltaX) > minSwipeDistance &&
        Math.abs(deltaX) > Math.abs(deltaY)
      ) {
        if (deltaX > 0 && hasPrevious && onPrevious) {
          onPrevious();
        } else if (deltaX < 0 && hasNext && onNext) {
          onNext();
        }
      }

      touchStartRef.current = null;
    },
    [hasNext, hasPrevious, onNext, onPrevious],
  );

  // Toggle metadata panel
  const toggleInfo = useCallback(() => {
    setShowInfo((prev) => !prev);
  }, []);

  // Handle delete button click
  const handleDelete = useCallback(() => {
    if (onDelete) {
      onDelete();
    }
  }, [onDelete]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          if (hasPrevious && onPrevious) {
            onPrevious();
          }
          break;
        case 'ArrowRight':
          if (hasNext && onNext) {
            onNext();
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (onDelete) {
            event.preventDefault();
            onDelete();
          }
          break;
        case 'i':
        case 'I':
          toggleInfo();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, hasPrevious, onPrevious, hasNext, onNext, onDelete, toggleInfo]);

  // Render loading state - shows thumbnail as background if available
  const renderLoading = () => {
    const loadingState = loadState as { progress: number; thumbnailUrl?: string };
    const hasThumbnail = !!loadingState.thumbnailUrl;
    
    return (
      <div 
        className={`lightbox-loading ${hasThumbnail ? 'lightbox-loading-with-thumbnail' : ''}`} 
        data-testid="lightbox-loading"
      >
        {/* Show thumbnail as placeholder while loading full-res */}
        {hasThumbnail && (
          <img
            src={loadingState.thumbnailUrl}
            alt={photo.filename}
            className="lightbox-thumbnail-placeholder"
            data-testid="lightbox-thumbnail-placeholder"
          />
        )}
        {/* Loading overlay */}
        <div className="lightbox-loading-overlay">
          <div className="lightbox-spinner" />
          <div className="lightbox-progress">
            <div
              className="lightbox-progress-bar"
              style={{
                width: `${loadingState.progress * 100}%`,
              }}
            />
          </div>
          <span className="lightbox-progress-text">
            {t('lightbox.loadingProgress', {
              percent: Math.round(loadingState.progress * 100),
            })}
          </span>
        </div>
      </div>
    );
  };

  // Render error state
  const renderError = () => (
    <div className="lightbox-error" data-testid="lightbox-error">
      <span className="lightbox-error-icon">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
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
      <p className="lightbox-error-message">
        Failed to load photo: {(loadState as { error: Error }).error.message}
      </p>
      <button
        className="button-primary lightbox-retry-button"
        onClick={handleRetry}
        data-testid="lightbox-retry"
      >
        {t('common.retry')}
      </button>
    </div>
  );

  // Render loaded photo
  const renderPhoto = () => (
    <img
      src={(loadState as { result: PhotoLoadResult }).result.blobUrl}
      alt={photo.filename}
      className="lightbox-image"
      data-testid="lightbox-image"
    />
  );

  // Render photo metadata panel
  const renderMetadata = () => (
    <div
      className={`lightbox-metadata ${showInfo ? 'lightbox-metadata-visible' : ''}`}
      data-testid="lightbox-metadata"
    >
      <h3 className="lightbox-metadata-title">{photo.filename}</h3>
      <dl className="lightbox-metadata-list">
        {photo.takenAt && (
          <>
            <dt>{t('lightbox.metadata.dateTaken')}</dt>
            <dd>{formatDate(photo.takenAt)}</dd>
          </>
        )}
        {photo.width > 0 && photo.height > 0 && (
          <>
            <dt>{t('lightbox.metadata.dimensions')}</dt>
            <dd>
              {photo.width.toLocaleString()} × {photo.height.toLocaleString()}
            </dd>
          </>
        )}
        {loadState.status === 'loaded' && (
          <>
            <dt>{t('lightbox.metadata.fileSize')}</dt>
            <dd>{formatFileSize(loadState.result.size)}</dd>
          </>
        )}
        <dt>{t('lightbox.metadata.format')}</dt>
        <dd>{photo.mimeType}</dd>
        {photo.lat != null && photo.lng != null && (
          <>
            <dt>{t('lightbox.metadata.location')}</dt>
            <dd>
              {photo.lat.toFixed(5)}, {photo.lng.toFixed(5)}
            </dd>
          </>
        )}
        {photo.tags.length > 0 && (
          <>
            <dt>{t('lightbox.metadata.tags')}</dt>
            <dd>{photo.tags.join(', ')}</dd>
          </>
        )}
        {photo.description && (
          <>
            <dt>{t('lightbox.metadata.description')}</dt>
            <dd className="lightbox-info-description">{photo.description}</dd>
          </>
        )}
      </dl>
    </div>
  );

  return (
    <div
      ref={backdropRef}
      className="lightbox-backdrop"
      onClick={handleBackdropClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo: ${photo.filename}`}
      data-testid="lightbox"
    >
      {/* Close button */}
      <button
        className="lightbox-close"
        onClick={onClose}
        aria-label={t('lightbox.close')}
        data-testid="lightbox-close"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Navigation buttons */}
      {hasPrevious && onPrevious && (
        <button
          className="lightbox-nav lightbox-nav-prev"
          onClick={onPrevious}
          aria-label={t('lightbox.previous')}
          data-testid="lightbox-prev"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      {hasNext && onNext && (
        <button
          className="lightbox-nav lightbox-nav-next"
          onClick={onNext}
          aria-label={t('lightbox.next')}
          data-testid="lightbox-next"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* Photo container */}
      <div className="lightbox-content">
        {loadState.status === 'loading' && renderLoading()}
        {loadState.status === 'error' && renderError()}
        {loadState.status === 'loaded' && renderPhoto()}
      </div>

      {/* Info toggle button */}
      {showMetadata && (
        <button
          className={`lightbox-info-toggle ${showInfo ? 'lightbox-info-toggle-active' : ''}`}
          onClick={toggleInfo}
          aria-label={
            showInfo ? t('lightbox.hideMetadata') : t('lightbox.showMetadata')
          }
          aria-pressed={showInfo}
          data-testid="lightbox-info-toggle"
        >
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
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>
      )}

      {/* Download button */}
      {canDownload && loadState.status === 'loaded' && (
        <button
          className="lightbox-download-button"
          onClick={handleDownload}
          aria-label={t('lightbox.download')}
          title={t('lightbox.download')}
          data-testid="lightbox-download"
        >
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
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      )}

      {/* Delete button */}
      {onDelete && (
        <button
          className="lightbox-delete-button"
          onClick={handleDelete}
          aria-label={t('lightbox.delete')}
          title={t('lightbox.delete')}
          data-testid="lightbox-delete"
        >
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
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}

      {/* Metadata panel */}
      {showMetadata && renderMetadata()}

      {/* Photo counter */}
      <div className="lightbox-counter" data-testid="lightbox-counter">
        {photo.filename}
      </div>
    </div>
  );
}
