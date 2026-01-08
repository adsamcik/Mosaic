/**
 * Shared Photo Thumbnail Component
 *
 * Displays a photo thumbnail for anonymous share link viewers.
 * Uses tier keys instead of epoch read keys.
 *
 * Loading priority (instant to slow):
 * 1. Full resolution (if loaded from shards)
 * 2. Embedded thumbnail (fast, base64 in manifest)
 * 3. BlurHash placeholder (instant, ~30 char string decoded in <1ms)
 * 4. Loading/error states
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import { getCachedBlurhashDataURL, isValidBlurhash } from '../../lib/blurhash-decoder';
import type { PhotoMeta } from '../../workers/types';

export interface SharedPhotoThumbnailProps {
  /** Photo metadata */
  photo: PhotoMeta;
  /** Tier key for decryption */
  tierKey?: Uint8Array | undefined;
  /** Access tier for this share link */
  accessTier: AccessTierType;
  /** Click handler */
  onClick?: () => void;
}

/** Loading state for thumbnail */
type ThumbnailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; blobUrl: string }
  | { status: 'error'; error: Error };

/**
 * Shared Photo Thumbnail
 * Displays embedded base64 thumbnail or placeholder
 */
export function SharedPhotoThumbnail({
  photo,
  tierKey,
  onClick,
}: SharedPhotoThumbnailProps) {
  const [state, setState] = useState<ThumbnailState>({ status: 'idle' });

  // BlurHash placeholder - instant, decoded in <1ms
  const blurhashUrl = useMemo(() => {
    if (!photo.blurhash || !isValidBlurhash(photo.blurhash)) return null;
    try {
      return getCachedBlurhashDataURL(photo.blurhash, 32, 32);
    } catch {
      return null;
    }
  }, [photo.blurhash]);

  // Use embedded thumbnail immediately if available (no network request needed)
  const embeddedThumbnailUrl = useMemo(() => {
    if (!photo.thumbnail || photo.thumbnail.length === 0) return null;
    return `data:image/jpeg;base64,${photo.thumbnail}`;
  }, [photo.thumbnail]);

  useEffect(() => {
    // If photo has embedded thumbnail, mark as loaded
    if (embeddedThumbnailUrl) {
      setState({ status: 'loaded', blobUrl: embeddedThumbnailUrl });
      return;
    }

    // No embedded thumbnail - show placeholder or attempt to load
    if (!tierKey || !photo.shardIds || photo.shardIds.length === 0) {
      setState({ status: 'idle' });
      return;
    }

    // For now, just show placeholder if no embedded thumbnail
    // Full shard loading would require downloading encrypted shards
    setState({ status: 'idle' });
  }, [photo.id, embeddedThumbnailUrl, photo.shardIds, tierKey]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.();
      }
    },
    [onClick]
  );

  const renderContent = () => {
    switch (state.status) {
      case 'idle':
        // Use blurhash placeholder if available, otherwise show icon placeholder
        if (blurhashUrl) {
          return (
            <img
              src={blurhashUrl}
              alt={photo.filename}
              className="photo-image photo-blurhash"
              data-testid="photo-blurhash"
              loading="lazy"
            />
          );
        }
        return (
          <div className="photo-placeholder" data-testid="photo-placeholder">
            <span className="photo-icon">🖼️</span>
            {!tierKey && <span className="photo-locked">🔒</span>}
          </div>
        );

      case 'loading':
        return (
          <div className="photo-loading" data-testid="photo-loading">
            {blurhashUrl && (
              <img
                src={blurhashUrl}
                alt=""
                className="photo-image photo-blurhash"
                aria-hidden="true"
              />
            )}
            <div className="loading-spinner" />
          </div>
        );

      case 'loaded':
        return (
          <img
            src={state.blobUrl}
            alt={photo.filename}
            className="photo-image"
            data-testid="photo-image"
            loading="lazy"
          />
        );

      case 'error':
        return (
          <div className="photo-error" data-testid="photo-error">
            <span className="error-icon">⚠️</span>
            <span className="error-message">Failed</span>
          </div>
        );
    }
  };

  return (
    <div
      className="photo-thumbnail"
      data-testid="shared-photo-thumbnail"
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`View ${photo.filename}`}
    >
      {renderContent()}
    </div>
  );
}
