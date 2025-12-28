/**
 * Shared Photo Lightbox Component
 *
 * Full-screen photo viewer for anonymous share link viewers.
 * Displays photos based on available tier access.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { PhotoMeta } from '../../workers/types';
import { downloadShard } from '../../lib/shard-service';
import { getCryptoClient } from '../../lib/crypto-client';

export interface SharedPhotoLightboxProps {
  /** Current photo to display */
  photo: PhotoMeta;
  /** Tier key for decryption */
  tierKey?: Uint8Array | undefined;
  /** Access tier for this share link */
  accessTier: AccessTierType;
  /** Close handler */
  onClose: () => void;
  /** Next photo handler */
  onNext?: (() => void) | undefined;
  /** Previous photo handler */
  onPrevious?: (() => void) | undefined;
  /** Whether there is a next photo */
  hasNext: boolean;
  /** Whether there is a previous photo */
  hasPrevious: boolean;
  /** Queue of photos to preload */
  preloadQueue?: PhotoMeta[] | undefined;
  /** Get tier key for preloading */
  getTierKey?: ((epochId: number, tier: AccessTierType) => Uint8Array | undefined) | undefined;
}

/** Photo loading state */
type PhotoState =
  | { status: 'loading' }
  | { status: 'loaded'; blobUrl: string }
  | { status: 'error'; message: string };

/**
 * Shared Photo Lightbox
 * Full-screen viewer with keyboard navigation
 */
export function SharedPhotoLightbox({
  photo,
  tierKey,
  accessTier,
  onClose,
  onNext,
  onPrevious,
  hasNext,
  hasPrevious,
}: SharedPhotoLightboxProps) {
  const [state, setState] = useState<PhotoState>({ status: 'loading' });

  // Load photo when it changes
  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;

    async function loadPhoto() {
      setState({ status: 'loading' });

      // First try to use embedded thumbnail if available
      if (photo.thumbnail) {
        try {
          const binary = atob(photo.thumbnail);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          blobUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            setState({ status: 'loaded', blobUrl });
          }
          return;
        } catch {
          // Fall through to shard loading
        }
      }

      // Try to load from shards if we have a tier key
      if (!tierKey || !photo.shardIds || photo.shardIds.length === 0) {
        if (!cancelled) {
          setState({ status: 'error', message: 'No decryption key available' });
        }
        return;
      }

      try {
        // Download and decrypt shards
        const crypto = await getCryptoClient();
        const decryptedChunks: Uint8Array[] = [];

        for (const shardId of photo.shardIds) {
          const encryptedShard = await downloadShard(shardId);
          // Note: For tier-based access, we use the tier key directly
          // The tier key is derived from the epoch read key
          const plaintext = await crypto.decryptShard(encryptedShard, tierKey);
          decryptedChunks.push(plaintext);
        }

        // Combine chunks
        const totalSize = decryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const photoData = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of decryptedChunks) {
          photoData.set(chunk, offset);
          offset += chunk.length;
        }

        // Create blob URL
        const blob = new Blob([photoData], { type: photo.mimeType });
        blobUrl = URL.createObjectURL(blob);

        if (!cancelled) {
          setState({ status: 'loaded', blobUrl });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load photo',
          });
        }
      }
    }

    loadPhoto();

    return () => {
      cancelled = true;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [photo.id, photo.thumbnail, photo.shardIds, photo.mimeType, tierKey, accessTier]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowRight':
          if (hasNext && onNext) onNext();
          break;
        case 'ArrowLeft':
          if (hasPrevious && onPrevious) onPrevious();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNext, onPrevious, hasNext, hasPrevious]);

  // Prevent body scroll when lightbox is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="lightbox-overlay"
      data-testid="shared-photo-lightbox"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${photo.filename}`}
    >
      <div className="lightbox-content">
        {/* Close button */}
        <button
          className="lightbox-close"
          onClick={onClose}
          aria-label="Close lightbox"
          data-testid="lightbox-close"
        >
          ✕
        </button>

        {/* Navigation buttons */}
        {hasPrevious && onPrevious && (
          <button
            className="lightbox-nav lightbox-nav-prev"
            onClick={onPrevious}
            aria-label="Previous photo"
            data-testid="lightbox-prev"
          >
            ‹
          </button>
        )}

        {hasNext && onNext && (
          <button
            className="lightbox-nav lightbox-nav-next"
            onClick={onNext}
            aria-label="Next photo"
            data-testid="lightbox-next"
          >
            ›
          </button>
        )}

        {/* Photo content */}
        <div className="lightbox-image-container">
          {state.status === 'loading' && (
            <div className="lightbox-loading" data-testid="lightbox-loading">
              <div className="loading-spinner loading-spinner-large" />
            </div>
          )}

          {state.status === 'loaded' && (
            <img
              src={state.blobUrl}
              alt={photo.filename}
              className="lightbox-image"
              data-testid="lightbox-image"
            />
          )}

          {state.status === 'error' && (
            <div className="lightbox-error" data-testid="lightbox-error">
              <span className="error-icon">⚠️</span>
              <p>{state.message}</p>
            </div>
          )}
        </div>

        {/* Photo info */}
        <div className="lightbox-info">
          <span className="lightbox-filename">{photo.filename}</span>
          {photo.takenAt && (
            <span className="lightbox-date">
              {new Date(photo.takenAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
