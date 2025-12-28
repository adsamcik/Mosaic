/**
 * Shared Photo Thumbnail Component
 *
 * Displays a photo thumbnail for anonymous share link viewers.
 * Uses tier keys instead of epoch read keys.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { PhotoMeta } from '../../workers/types';

interface SharedPhotoThumbnailProps {
  /** Photo metadata */
  photo: PhotoMeta;
  /** Tier key for decryption */
  tierKey?: Uint8Array;
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

  useEffect(() => {
    // If photo has embedded thumbnail, use it directly
    if (photo.thumbnail) {
      // Create blob URL from base64 thumbnail
      try {
        const binary = atob(photo.thumbnail);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const blobUrl = URL.createObjectURL(blob);
        setState({ status: 'loaded', blobUrl });

        return () => {
          URL.revokeObjectURL(blobUrl);
        };
      } catch {
        setState({ status: 'error', error: new Error('Invalid thumbnail data') });
        return;
      }
    }

    // No embedded thumbnail - show placeholder or attempt to load
    if (!tierKey || !photo.shardIds || photo.shardIds.length === 0) {
      setState({ status: 'idle' });
      return;
    }

    // For now, just show placeholder if no embedded thumbnail
    // Full shard loading would require downloading encrypted shards
    setState({ status: 'idle' });
  }, [photo.id, photo.thumbnail, photo.shardIds, tierKey]);

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
        return (
          <div className="photo-placeholder" data-testid="photo-placeholder">
            <span className="photo-icon">🖼️</span>
            {!tierKey && <span className="photo-locked">🔒</span>}
          </div>
        );

      case 'loading':
        return (
          <div className="photo-loading" data-testid="photo-loading">
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
