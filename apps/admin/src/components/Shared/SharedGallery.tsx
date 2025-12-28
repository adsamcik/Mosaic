/**
 * Shared Gallery Component
 *
 * Read-only gallery for anonymous share link viewers.
 * Fetches photos via public share link API and displays
 * based on the access tier granted by the link.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import type { PhotoMeta } from '../../workers/types';
import { SharedPhotoGrid } from './SharedPhotoGrid';
import type { TierKey } from '../../hooks/useLinkKeys';

interface SharedGalleryProps {
  /** Link ID for fetching photos */
  linkId: string;
  /** Album ID to display */
  albumId: string;
  /** Access tier granted by this link */
  accessTier: AccessTierType;
  /** Tier keys by epoch */
  tierKeys: Map<number, Map<AccessTierType, TierKey>>;
  /** Whether keys are still loading */
  isLoadingKeys?: boolean;
}

/** Photo response from share link API */
interface ShareLinkPhotoResponse {
  id: string;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: string; // Base64
  signature: string; // Base64
  signerPubkey: string; // Base64
  shardIds: string[];
}

/**
 * Shared Gallery
 * Fetches and displays photos for anonymous viewers
 */
export function SharedGallery({
  linkId,
  albumId,
  accessTier,
  tierKeys,
  isLoadingKeys = false,
}: SharedGalleryProps) {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Fetch photos from share link API
  useEffect(() => {
    let cancelled = false;

    async function fetchPhotos() {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetch(`/api/s/${linkId}/photos`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to fetch photos: ${response.status}`);
        }

        const photoResponses: ShareLinkPhotoResponse[] = await response.json();

        // Import crypto for decryption
        const { fromBase64 } = await import('@mosaic/crypto');
        const { getCryptoClient } = await import('../../lib/crypto-client');
        const crypto = await getCryptoClient();

        // Decrypt manifests and extract photo metadata
        const decryptedPhotos: PhotoMeta[] = [];

        for (const photoResp of photoResponses) {
          if (photoResp.isDeleted) continue;

          // Find the tier key for this manifest's epoch
          // We need to determine the epoch from the encrypted manifest
          // For now, we'll try each available epoch key
          let decrypted: PhotoMeta | null = null;

          for (const [epochId, epochTiers] of tierKeys) {
            // Try to decrypt with the highest available tier key
            for (const tier of [3, 2, 1] as AccessTierType[]) {
              const tierKey = epochTiers.get(tier);
              if (!tierKey) continue;

              try {
                const encryptedMeta = fromBase64(photoResp.encryptedMeta);
                decrypted = await crypto.decryptManifest(encryptedMeta, tierKey.key);
                // If successful, add epoch info
                decrypted.epochId = epochId;
                decrypted.shardIds = photoResp.shardIds;
                break;
              } catch {
                // Try next tier/epoch
              }
            }
            if (decrypted) break;
          }

          if (decrypted) {
            decryptedPhotos.push(decrypted);
          }
        }

        if (!cancelled) {
          setPhotos(decryptedPhotos);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    // Only fetch when we have tier keys
    if (tierKeys.size > 0 && !isLoadingKeys) {
      fetchPhotos();
    }

    return () => {
      cancelled = true;
    };
  }, [linkId, albumId, tierKeys, isLoadingKeys]);

  /**
   * Get tier key for a specific epoch and tier
   */
  const getTierKey = useCallback(
    (epochId: number, tier: AccessTierType): Uint8Array | undefined => {
      const epochTiers = tierKeys.get(epochId);
      if (!epochTiers) {
        // Try to find any epoch with keys (fallback for manifest decryption)
        for (const [, tiers] of tierKeys) {
          const key = tiers.get(tier);
          if (key) return key.key;
        }
        return undefined;
      }

      // Return requested tier or highest available
      const tierKey = epochTiers.get(tier);
      if (tierKey) return tierKey.key;

      // Fall back to highest available
      for (const t of [3, 2, 1] as AccessTierType[]) {
        const key = epochTiers.get(t);
        if (key) return key.key;
      }
      return undefined;
    },
    [tierKeys]
  );

  // Loading state
  if (isLoading || isLoadingKeys) {
    return (
      <div className="shared-gallery" data-testid="shared-gallery">
        <div className="gallery-loading">
          <div className="loading-spinner" />
          <p>{isLoadingKeys ? 'Loading encryption keys...' : 'Loading photos...'}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="shared-gallery" data-testid="shared-gallery">
        <div className="gallery-error">
          <span className="error-icon">⚠️</span>
          <p>Failed to load photos: {error.message}</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (photos.length === 0) {
    return (
      <div className="shared-gallery" data-testid="shared-gallery">
        <div className="gallery-empty">
          <span className="empty-icon">📷</span>
          <p>No photos in this album.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shared-gallery" data-testid="shared-gallery">
      <div className="gallery-header">
        <h2 className="gallery-title">
          Shared Album
          <span className="gallery-count">({photos.length} photos)</span>
        </h2>
        <div className="gallery-tier-badge">
          {accessTier === 1 && <span className="tier-badge tier-thumb">Thumbnails</span>}
          {accessTier === 2 && <span className="tier-badge tier-preview">Preview</span>}
          {accessTier === 3 && <span className="tier-badge tier-full">Full Access</span>}
        </div>
      </div>

      <div className="gallery-content">
        <SharedPhotoGrid
          photos={photos}
          accessTier={accessTier}
          getTierKey={getTierKey}
          isLoadingKeys={isLoadingKeys}
        />
      </div>
    </div>
  );
}
