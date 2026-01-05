/**
 * Shared Photo Lightbox Component
 *
 * Full-screen photo viewer for anonymous share link viewers.
 * Displays photos based on available tier access.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { PhotoMeta } from '../../workers/types';
import { downloadShardViaShareLink } from '../../lib/shard-service';
import { getCryptoClient } from '../../lib/crypto-client';

export interface SharedPhotoLightboxProps {
  /** Current photo to display */
  photo: PhotoMeta;
  /** Share link ID for shard downloads */
  linkId: string;
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
  | { status: 'loaded'; blobUrl: string; isFullRes: boolean }
  | { status: 'error'; message: string };

/**
 * Shared Photo Lightbox
 * Full-screen viewer with keyboard navigation
 */
export function SharedPhotoLightbox({
  photo,
  linkId,
  tierKey,
  accessTier,
  onClose,
  onNext,
  onPrevious,
  hasNext,
  hasPrevious,
  getTierKey,
}: SharedPhotoLightboxProps) {
  const [state, setState] = useState<PhotoState>({ status: 'loading' });
  const [loadProgress, setLoadProgress] = useState(0);

  // Load photo when it changes
  // Strategy: Show thumbnail immediately, then load full-res shards in background
  useEffect(() => {
    let cancelled = false;
    let thumbnailBlobUrl: string | null = null;
    let fullResBlobUrl: string | null = null;

    async function loadPhoto() {
      setState({ status: 'loading' });
      setLoadProgress(0);

      // Phase 1: Show embedded thumbnail immediately for fast perceived load
      if (photo.thumbnail) {
        try {
          const binary = atob(photo.thumbnail);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          thumbnailBlobUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            // Show thumbnail immediately, but mark as not full-res
            setState({ status: 'loaded', blobUrl: thumbnailBlobUrl, isFullRes: false });
          }
        } catch {
          // Thumbnail decode failed, continue to shard loading
        }
      }

      // Phase 2: Load full-resolution from shards if we have a tier key
      if (!tierKey || !photo.shardIds || photo.shardIds.length === 0) {
        // No tier key or shards available - thumbnail is all we have
        if (!thumbnailBlobUrl && !cancelled) {
          setState({ status: 'error', message: 'No image available' });
        }
        return;
      }

      try {
        // Download and decrypt shards via share link endpoint
        // Only decrypt shards that match our access tier
        const crypto = await getCryptoClient();
        const decryptedChunks: Uint8Array[] = [];
        
        // First pass: download all shards and peek at their tier to find matching ones
        const downloadedShards: { shardId: string; data: Uint8Array; tier: number }[] = [];
        
        for (let i = 0; i < photo.shardIds.length; i++) {
          if (cancelled) return;
          
          const shardId = photo.shardIds[i]!;
          const encryptedShard = await downloadShardViaShareLink(linkId, shardId);
          
          // Peek at the shard header to determine its tier
          const header = await crypto.peekHeader(encryptedShard);
          downloadedShards.push({ shardId, data: encryptedShard, tier: header.tier });
          
          // Update progress (download phase)
          if (!cancelled) {
            setLoadProgress(((i + 1) / photo.shardIds.length) * 50);
          }
        }
        
        if (cancelled) return;
        
        // Filter to shards matching our access tier
        // Access tier determines the highest tier we can decrypt:
        // - Tier 1 (thumb): can only decrypt tier 1 shards
        // - Tier 2 (preview): can decrypt tier 1 and 2 shards
        // - Tier 3 (full): can decrypt all tiers
        // For lightbox, we want the BEST available quality, so pick the highest tier <= accessTier
        const matchingShards = downloadedShards.filter(s => s.tier <= accessTier);
        
        if (matchingShards.length === 0) {
          // No matching shards found - this shouldn't happen normally
          if (!thumbnailBlobUrl && !cancelled) {
            setState({ status: 'error', message: 'No accessible shards for this tier' });
          }
          return;
        }
        
        // Sort by tier descending to get highest quality first
        matchingShards.sort((a, b) => b.tier - a.tier);
        
        // For single-photo viewing, we only need ONE shard (the best quality one)
        // If photos were chunked across multiple shards, we'd need all of the same tier
        // Group by tier and take the highest tier group
        const bestTier = matchingShards[0]!.tier;
        const shardsToDecrypt = matchingShards.filter(s => s.tier === bestTier);
        
        // Get the appropriate tier key for decryption
        // If getTierKey is available, use it to get the exact key for this tier
        // Otherwise fall back to the provided tierKey (should match accessTier)
        const decryptionKey = getTierKey 
          ? getTierKey(photo.epochId, bestTier as AccessTierType)
          : tierKey;
        
        if (!decryptionKey) {
          if (!thumbnailBlobUrl && !cancelled) {
            setState({ status: 'error', message: 'No decryption key available for this tier' });
          }
          return;
        }
        
        // Decrypt the matching shards
        for (let i = 0; i < shardsToDecrypt.length; i++) {
          if (cancelled) return;
          
          const shard = shardsToDecrypt[i]!;
          const plaintext = await crypto.decryptShardWithTierKey(shard.data, decryptionKey);
          decryptedChunks.push(plaintext);
          
          // Update progress (decrypt phase)
          if (!cancelled) {
            setLoadProgress(50 + ((i + 1) / shardsToDecrypt.length) * 50);
          }
        }

        if (cancelled) return;

        // Combine chunks
        const totalSize = decryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const photoData = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of decryptedChunks) {
          photoData.set(chunk, offset);
          offset += chunk.length;
        }

        // Create blob URL for full-res image
        const blob = new Blob([photoData], { type: photo.mimeType });
        fullResBlobUrl = URL.createObjectURL(blob);

        if (!cancelled) {
          // Replace thumbnail with full-res
          setState({ status: 'loaded', blobUrl: fullResBlobUrl, isFullRes: true });
          // Revoke thumbnail URL now that we have full-res
          if (thumbnailBlobUrl) {
            URL.revokeObjectURL(thumbnailBlobUrl);
            thumbnailBlobUrl = null;
          }
        }
      } catch (err) {
        // Shard decryption failed - this is expected if user's tier key
        // doesn't have access to the shard tier (e.g., preview key can't decrypt original shards)
        // If we have a thumbnail, just keep showing it (no error)
        if (!thumbnailBlobUrl && !cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load photo',
          });
        }
        // If we have thumbnail, we already set state to show it, so do nothing
      }
    }

    loadPhoto();

    return () => {
      cancelled = true;
      if (thumbnailBlobUrl) {
        URL.revokeObjectURL(thumbnailBlobUrl);
      }
      if (fullResBlobUrl) {
        URL.revokeObjectURL(fullResBlobUrl);
      }
    };
  }, [photo.id, photo.thumbnail, photo.shardIds, photo.mimeType, photo.epochId, tierKey, accessTier, linkId, getTierKey]);

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
      className="lightbox-backdrop"
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
            <>
              <img
                src={state.blobUrl}
                alt={photo.filename}
                className="lightbox-image"
                data-testid="lightbox-image"
              />
              {/* Show progress overlay while loading full-res */}
              {!state.isFullRes && loadProgress > 0 && loadProgress < 100 && (
                <div 
                  className="lightbox-progress-overlay"
                  data-testid="lightbox-progress-overlay"
                >
                  <div className="lightbox-progress-bar">
                    <div 
                      className="lightbox-progress-fill"
                      style={{ width: `${loadProgress}%` }}
                    />
                  </div>
                  <span className="lightbox-progress-text">
                    Loading full resolution... {Math.round(loadProgress)}%
                  </span>
                </div>
              )}
            </>
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
