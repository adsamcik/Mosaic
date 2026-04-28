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
import { isVideoMimeType } from '../../lib/image-decoder';
import { createLogger } from '../../lib/logger';
import { rotatePhoto, updatePhotoDescription } from '../../lib/photo-edit-service';
import type { PhotoMeta } from '../../workers/types';

const log = createLogger('PhotoLightbox');

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
  | { status: 'loading'; photoId: string; progress: number; thumbnailUrl?: string | undefined }
  | { status: 'loaded'; photoId: string; result: PhotoLoadResult }
  | { status: 'error'; photoId: string; error: Error };

/**
 * Translate a `<video>` MediaError into a human-readable, actionable message.
 * Covers the common "user uploaded an iPhone HEVC .mov that Chrome/Firefox
 * can't decode" case so the UI can offer a download fallback rather than
 * a blank "Video playback failed".
 *
 * Uses numeric MediaError codes from the HTMLMediaElement spec instead of
 * `MediaError.MEDIA_ERR_*` constants because the latter aren't exposed by
 * non-browser test runtimes (happy-dom, jsdom).
 */
function describeMediaError(error: MediaError, mimeType: string): string {
  switch (error.code) {
    case 1: // MEDIA_ERR_ABORTED
      return 'Video playback was interrupted.';
    case 2: // MEDIA_ERR_NETWORK
      return 'Network error while loading the video.';
    case 3: // MEDIA_ERR_DECODE
      return 'This video could not be decoded — the file may be corrupted.';
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return `Your browser cannot play this video format (${mimeType}). HEVC/H.265 inside .mov files is unsupported by most browsers; download the file to view it locally.`;
    default:
      return error.message || 'Video playback failed.';
  }
}

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
    photoId: photo.id,
    progress: 0,
  });
  const [showInfo, setShowInfo] = useState(false);
  const [showHints, setShowHints] = useState(true);
  const [displayRotation, setDisplayRotation] = useState(photo.rotation ?? 0);
  const [isRotating, setIsRotating] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [draftDescription, setDraftDescription] = useState(photo.description ?? '');
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  // When a video fails to play (typically: HEVC inside a .mov file that the
  // user's browser can't decode) we want to surface a clear message AND
  // keep the underlying blob available so the user can still download the
  // file. Storing the playback error separately preserves loadState.result.
  const [videoPlaybackError, setVideoPlaybackError] =
    useState<MediaError | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const justCancelledDescriptionRef = useRef(false);

  const isVideo = photo.isVideo === true || isVideoMimeType(photo.mimeType);

  useEffect(() => {
    setDisplayRotation(photo.rotation ?? 0);
  }, [photo.id, photo.rotation]);

  useEffect(() => {
    justCancelledDescriptionRef.current = false;
    setIsEditingDescription(false);
    setDraftDescription(photo.description ?? '');
  }, [photo.id, photo.description]);

  // Reset any video playback error when the user navigates to a different
  // photo so the new one starts from a clean slate.
  useEffect(() => {
    setVideoPlaybackError(null);
  }, [photo.id]);

  // Auto-hide keyboard hints after 3 seconds
  useEffect(() => {
    if (showHints) {
      const timer = setTimeout(() => setShowHints(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showHints]);

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
        photoId: photo.id,
        error: new Error('Missing epoch key or shard IDs'),
      });
      return;
    }

    // Check if photo is already cached - if so, use it immediately without showing loading state
    const cached = getCachedPhoto(fullResPhotoId);
    if (cached) {
      setLoadState({ status: 'loaded', photoId: photo.id, result: cached });
      return () => {
        releasePhoto(fullResPhotoId);
      };
    }

    let cancelled = false;

    async function loadFullResolution() {
      // Set loading state with embedded thumbnail for immediate display
      setLoadState({ 
        status: 'loading', 
        photoId: photo.id,
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
                  photoId: photo.id,
                  progress,
                  thumbnailUrl: embeddedThumbnailUrl,
                });
              }
            },
          },
        );

        if (!cancelled) {
          setLoadState({ status: 'loaded', photoId: photo.id, result });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState({
            status: 'error',
            photoId: photo.id,
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
  }, [fullResPhotoId, originalShards, photo.id, photo.mimeType, epochReadKey, embeddedThumbnailUrl]);

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

    setLoadState({ status: 'loading', photoId: photo.id, progress: 0, thumbnailUrl: embeddedThumbnailUrl });

    loadPhoto(fullResPhotoId, originalShards, epochReadKey, photo.mimeType, {
      skipCache: true,
      onProgress: (loaded, total) => {
        const progress = total > 0 ? loaded / total : 0;
        setLoadState({ status: 'loading', photoId: photo.id, progress, thumbnailUrl: embeddedThumbnailUrl });
      },
    })
      .then((result) => setLoadState({ status: 'loaded', photoId: photo.id, result }))
      .catch((error) =>
        setLoadState({
          status: 'error',
          photoId: photo.id,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
  }, [fullResPhotoId, originalShards, photo.id, photo.mimeType, epochReadKey, embeddedThumbnailUrl]);

  // Get album permissions for download/edit capabilities
  const { canDownload, canUpload } = useAlbumPermissions();
  const effectiveLoadState: LoadState =
    loadState.photoId === photo.id
      ? loadState
      : {
          status: 'loading',
          photoId: photo.id,
          progress: 0,
          thumbnailUrl: embeddedThumbnailUrl,
        };

  // Handle download button click
  const handleDownload = useCallback(() => {
    if (loadState.status !== 'loaded' || loadState.photoId !== photo.id) return;

    // Create a temporary anchor element to trigger download
    const link = document.createElement('a');
    link.href = loadState.result.blobUrl;
    link.download = photo.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [loadState, photo.id, photo.filename]);

  const handleRotate = useCallback(async () => {
    if (isRotating) return;

    const previous = displayRotation;
    const optimistic = (previous + 90) % 360;
    setDisplayRotation(optimistic);
    setIsRotating(true);

    try {
      await rotatePhoto(photo, 90);
    } catch (err) {
      log.error('Rotation failed', err);
      setDisplayRotation(previous);
    } finally {
      setIsRotating(false);
    }
  }, [photo, displayRotation, isRotating]);

  const handleStartEditDescription = useCallback(() => {
    if (!canUpload) return;
    justCancelledDescriptionRef.current = false;
    setDraftDescription(photo.description ?? '');
    setIsEditingDescription(true);
  }, [canUpload, photo.description]);

  const handleCancelEditDescription = useCallback(() => {
    justCancelledDescriptionRef.current = true;
    setIsEditingDescription(false);
    setDraftDescription(photo.description ?? '');
  }, [photo.description]);

  const handleSaveDescription = useCallback(async () => {
    if (justCancelledDescriptionRef.current) {
      justCancelledDescriptionRef.current = false;
      return;
    }
    if (!isEditingDescription) return;
    const trimmed = draftDescription.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    const previous = photo.description ?? null;
    if (normalized === previous) {
      setIsEditingDescription(false);
      return;
    }
    setIsSavingDescription(true);
    try {
      await updatePhotoDescription(photo, normalized);
      setIsEditingDescription(false);
    } catch (err) {
      log.error('Failed to update description', err);
      setDraftDescription(photo.description ?? '');
      setIsEditingDescription(false);
    } finally {
      setIsSavingDescription(false);
    }
  }, [draftDescription, photo, isEditingDescription]);

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

  // Pause video when navigating away or closing
  const pauseVideo = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
  }, []);

  // Pause video on close or navigation
  useEffect(() => {
    return () => {
      pauseVideo();
    };
  }, [photo.id, pauseVideo]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      // Let the video element handle its own keyboard events (space, etc.)
      if (isVideo && event.target instanceof HTMLVideoElement) {
        if (event.key === 'Escape') {
          pauseVideo();
          onClose();
        }
        return;
      }

      switch (event.key) {
        case 'Escape':
          pauseVideo();
          onClose();
          break;
        case 'ArrowLeft':
          if (hasPrevious && onPrevious) {
            pauseVideo();
            onPrevious();
          }
          break;
        case 'ArrowRight':
          if (hasNext && onNext) {
            pauseVideo();
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
        case 'r':
        case 'R':
          if (canUpload) {
            event.preventDefault();
            void handleRotate();
          }
          break;
        case ' ':
          // Prevent spacebar from scrolling when video is playing
          if (isVideo) {
            event.preventDefault();
            if (videoRef.current) {
              if (videoRef.current.paused) {
                void videoRef.current.play();
              } else {
                videoRef.current.pause();
              }
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, hasPrevious, onPrevious, hasNext, onNext, onDelete, toggleInfo, isVideo, pauseVideo, canUpload, handleRotate]);

  // Render loading state - shows thumbnail as background if available
  const renderLoading = () => {
    const loadingState = effectiveLoadState as { progress: number; thumbnailUrl?: string };
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
        Failed to load photo: {(effectiveLoadState as { error: Error }).error.message}
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

  // Render loaded photo or video
  const renderPhoto = () => {
    const blobUrl = (effectiveLoadState as { result: PhotoLoadResult }).result.blobUrl;

    if (isVideo) {
      return (
        <>
          <video
            // Force a fresh element per blob URL so we never inherit a
            // pending error event from the previously-mounted video.
            key={blobUrl}
            ref={videoRef}
            controls
            autoPlay
            playsInline
            className="lightbox-video"
            style={{ transform: `rotate(${displayRotation}deg)` }}
            src={blobUrl}
            data-testid="lightbox-video"
            onLoadedData={() => setVideoPlaybackError(null)}
            onError={(event) => {
              const el = event.currentTarget;
              setVideoPlaybackError(el.error ?? null);
            }}
          />
          {videoPlaybackError && (
            <div className="lightbox-video-error" data-testid="lightbox-video-error">
              <p>{describeMediaError(videoPlaybackError, photo.mimeType)}</p>
              {canDownload && (
                <button
                  type="button"
                  className="button-primary"
                  onClick={handleDownload}
                  data-testid="lightbox-video-error-download"
                >
                  {t('lightbox.downloadFile', { defaultValue: 'Download file' })}
                </button>
              )}
            </div>
          )}
        </>
      );
    }

    return (
      <img
        key={photo.id}
        src={blobUrl}
        alt={photo.filename}
        className="lightbox-image"
        style={{ transform: `rotate(${displayRotation}deg)` }}
        data-testid="lightbox-image"
        data-photo-id={photo.id}
      />
    );
  };

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
        {effectiveLoadState.status === 'loaded' && (
          <>
            <dt>{t('lightbox.metadata.fileSize')}</dt>
            <dd>{formatFileSize(effectiveLoadState.result.size)}</dd>
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
        {(canUpload || photo.description) && (
          <>
            <dt>{t('lightbox.metadata.description')}</dt>
            {isEditingDescription ? (
              <dd>
                <textarea
                  value={draftDescription}
                  onChange={(event) => setDraftDescription(event.target.value)}
                  onBlur={() => void handleSaveDescription()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      handleCancelEditDescription();
                      return;
                    }
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void handleSaveDescription();
                    }
                  }}
                  maxLength={2000}
                  autoFocus
                  disabled={isSavingDescription}
                  data-testid="lightbox-description-textarea"
                  className="lightbox-description-edit"
                />
              </dd>
            ) : (
              <dd
                className={[
                  'lightbox-info-description',
                  canUpload ? 'lightbox-description-clickable' : '',
                  !photo.description && canUpload ? 'lightbox-description-placeholder' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={canUpload ? handleStartEditDescription : undefined}
              >
                {photo.description || t('lightbox.description.placeholder')}
              </dd>
            )}
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
        {effectiveLoadState.status === 'loading' && renderLoading()}
        {effectiveLoadState.status === 'error' && renderError()}
        {effectiveLoadState.status === 'loaded' && renderPhoto()}
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
      {canDownload && effectiveLoadState.status === 'loaded' && (
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

      {/* Rotate button */}
      {canUpload && effectiveLoadState.status === 'loaded' && (
        <button
          className="lightbox-rotate-button"
          onClick={() => void handleRotate()}
          disabled={isRotating}
          aria-label={t('lightbox.rotate', { defaultValue: 'Rotate 90° clockwise' })}
          title={t('lightbox.rotate', { defaultValue: 'Rotate 90° clockwise' })}
          data-testid="lightbox-rotate-button"
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
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
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

      {/* Keyboard hints - shown briefly on open */}
      {showHints && (
        <div className="lightbox-hints" data-testid="lightbox-hints">
          <span className="lightbox-hint">
            <kbd>←</kbd><kbd>→</kbd> {t('lightbox.hints.navigate')}
          </span>
          <span className="lightbox-hint">
            <kbd>I</kbd> {t('lightbox.hints.info')}
          </span>
          <span className="lightbox-hint">
            <kbd>Esc</kbd> {t('lightbox.hints.close')}
          </span>
        </div>
      )}

      {/* Photo counter */}
      <div className="lightbox-counter" data-testid="lightbox-counter">
        {photo.filename}
      </div>
    </div>
  );
}
