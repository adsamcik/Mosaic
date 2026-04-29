/**
 * Shared Gallery Component
 *
 * Read-only gallery for anonymous share link viewers.
 * Fetches photos via public share link API and displays
 * based on the access tier granted by the link.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAlbumDownload } from '../../hooks/useAlbumDownload';
import type { TierKey } from '../../hooks/useLinkKeys';
import type { AccessTier as AccessTierType } from '../../lib/api-types';
import { createLogger } from '../../lib/logger';
import { createShareLinkOriginalResolver } from '../../lib/shared-album-download';
import type { PhotoMeta } from '../../workers/types';
import { DownloadProgressOverlay } from '../Gallery/DownloadProgressOverlay';
import { SharedMosaicPhotoGrid } from './SharedMosaicPhotoGrid';
import { SharedPhotoGrid } from './SharedPhotoGrid';

const log = createLogger('SharedGallery');

interface SharedGalleryProps {
  /** Link ID for fetching photos */
  linkId: string;
  /** Album ID to display */
  albumId: string;
  /** Access tier granted by this link */
  accessTier: AccessTierType;
  /** Short-lived grant token for limited-use links */
  grantToken?: string | null | undefined;
  /** Tier keys by epoch */
  tierKeys: Map<number, Map<AccessTierType, TierKey>>;
  /** Whether keys are still loading */
  isLoadingKeys?: boolean;
  /** Decrypted album name (optional) */
  albumName?: string | null;
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
  grantToken,
  tierKeys,
  isLoadingKeys = false,
  albumName,
}: SharedGalleryProps) {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'mosaic'>('grid');

  // Determine default layout based on metadata when photos load
  useEffect(() => {
    if (photos.length === 0) return;

    // Check if we have sufficient metadata for Mosaic
    const hasDescriptions = photos.some(
      (p) => !!p.description && p.description.length > 20,
    );
    // You could also check for location variety, etc.

    if (hasDescriptions) {
      setViewMode('mosaic');
    }
  }, [photos]);

  // Fetch photos from share link API
  useEffect(() => {
    let cancelled = false;

    async function fetchPhotos() {
      try {
        setIsLoading(true);
        setError(null);

        // Backend caps `take` at 100 per request; page until we receive a
        // short page so all photos in the album are loaded (fixes the bug
        // where only the first 50 photos were ever shown).
        const pageSize = 100;
        const fetchInit: RequestInit = grantToken
          ? { headers: { 'X-Share-Grant': grantToken } }
          : {};
        const photoResponses: ShareLinkPhotoResponse[] = [];
        for (let skip = 0; ; skip += pageSize) {
          const response = await fetch(
            `/api/s/${linkId}/photos?skip=${skip}&take=${pageSize}`,
            fetchInit,
          );
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
              errorData.error || `Failed to fetch photos: ${response.status}`,
            );
          }

          const page: ShareLinkPhotoResponse[] = await response.json();
          photoResponses.push(...page);
          if (cancelled) return;
          if (page.length < pageSize) break;
        }

        // Slice 4 — manifest decryption no longer needs the legacy
        // `@mosaic/crypto` `fromBase64` helper. Browser `atob` plus
        // `Uint8Array.from` is sufficient and keeps SharedGallery off
        // the TypeScript-crypto compatibility allowlist.
        const { getCryptoClient } = await import('../../lib/crypto-client');
        const crypto = await getCryptoClient();
        const decodeBase64 = (value: string): Uint8Array =>
          Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

        // Decrypt manifests and extract photo metadata
        const decryptedPhotos: PhotoMeta[] = [];
        const textDecoder = new TextDecoder();

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
                const encryptedMeta = decodeBase64(photoResp.encryptedMeta);
                // Slice 4 — share-link viewers don't hold an epoch handle;
                // they decrypt the manifest envelope with the unwrapped
                // tier key directly. The worker returns plaintext bytes
                // and we JSON-parse them here (the legacy
                // `decryptManifest` did the parse inside the worker).
                const plaintextBytes = await crypto.decryptShardWithTierKey(
                  encryptedMeta,
                  tierKey.key,
                );
                const meta = JSON.parse(
                  textDecoder.decode(plaintextBytes),
                ) as PhotoMeta;
                decrypted = {
                  ...meta,
                  // If successful, add epoch info
                  epochId,
                  shardIds: photoResp.shardIds,
                };
                break;
              } catch {
                // Try next tier/epoch
              }
            }
            if (decrypted) break;
          }

          if (decrypted) {
            log.debug('Decrypted photo manifest', {
              photoId: decrypted.id,
              epochId: decrypted.epochId,
              shardCount: decrypted.shardIds?.length ?? 0,
            });
            decryptedPhotos.push(decrypted);
          }
        }

        log.info('Photos loaded', {
          total: photoResponses.length,
          decrypted: decryptedPhotos.length,
          failed: photoResponses.length - decryptedPhotos.length,
        });

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
  }, [linkId, albumId, grantToken, tierKeys, isLoadingKeys]);

  /**
   * Get tier key for a specific epoch and tier
   */
  const getTierKey = useCallback(
    (epochId: number, tier: AccessTierType): Uint8Array | undefined => {
      log.debug('getTierKey called', {
        epochId,
        requestedTier: tier,
        availableEpochs: Array.from(tierKeys.keys()),
        availableTiers: Array.from(tierKeys.entries()).map(([e, tiers]) => ({
          epoch: e,
          tiers: Array.from(tiers.keys()),
        })),
      });

      const epochTiers = tierKeys.get(epochId);
      if (!epochTiers) {
        log.debug('Epoch not found, trying fallback', { epochId });
        // Try to find any epoch with keys (fallback for manifest decryption)
        for (const [fallbackEpochId, tiers] of tierKeys) {
          const key = tiers.get(tier);
          if (key) {
            log.debug('Found key via fallback', {
              originalEpoch: epochId,
              fallbackEpoch: fallbackEpochId,
              tier,
            });
            return key.key;
          }
        }
        log.warn('No tier key found', { epochId, tier });
        return undefined;
      }

      // Return requested tier or highest available
      const tierKey = epochTiers.get(tier);
      if (tierKey) {
        log.debug('Found exact tier key', {
          epochId,
          tier,
        });
        return tierKey.key;
      }

      // Fall back to highest available
      for (const t of [3, 2, 1] as AccessTierType[]) {
        const key = epochTiers.get(t);
        if (key) {
          log.debug('Using fallback tier', {
            epochId,
            requestedTier: tier,
            actualTier: t,
          });
          return key.key;
        }
      }
      log.warn('No tier key found after fallback', { epochId, tier });
      return undefined;
    },
    [tierKeys],
  );

  const albumDownload = useAlbumDownload();

  const downloadResolver = useMemo(
    () =>
      createShareLinkOriginalResolver({
        linkId,
        grantToken: grantToken ?? undefined,
        getTierKey,
      }),
    [linkId, grantToken, getTierKey],
  );

  const handleDownloadAll = useCallback(() => {
    if (photos.length === 0) return;
    void albumDownload.startDownload(
      albumId,
      albumName ?? 'Shared Album',
      photos,
      downloadResolver,
    );
  }, [photos, albumId, albumName, albumDownload, downloadResolver]);

  // Loading state
  if (isLoading || isLoadingKeys) {
    return (
      <div className="shared-gallery" data-testid="shared-gallery">
        <div className="gallery-loading">
          <div className="loading-spinner" />
          <p>
            {isLoadingKeys ? 'Loading encryption keys...' : 'Loading photos...'}
          </p>
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
          {albumName || 'Shared Album'}
          <span className="gallery-count">({photos.length} photos)</span>
        </h2>
        <div className="gallery-tier-badge">
          {accessTier === 1 && (
            <span className="tier-badge tier-thumb">Thumbnails</span>
          )}
          {accessTier === 2 && (
            <span className="tier-badge tier-preview">Preview</span>
          )}
          {accessTier === 3 && (
            <span className="tier-badge tier-full">Full Access</span>
          )}
        </div>

        {accessTier === 3 && photos.length > 0 && (
          <button
            type="button"
            className="button-secondary gallery-download-all-btn"
            onClick={handleDownloadAll}
            disabled={albumDownload.isDownloading}
            data-testid="shared-gallery-download-all"
            title="Download all photos as ZIP"
          >
            {albumDownload.isDownloading
              ? 'Downloading...'
              : `Download all (${photos.length})`}
          </button>
        )}

        {/* View Toggle */}
        <div className="view-toggle" role="group" aria-label="View mode">
          <button
            className={`view-toggle-btn ${viewMode === 'grid' ? 'view-toggle-btn--active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid View"
            aria-pressed={viewMode === 'grid'}
          >
            <span className="view-toggle-icon">
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
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </span>
            <span className="view-toggle-label">Grid</span>
          </button>
          <button
            className={`view-toggle-btn ${viewMode === 'mosaic' ? 'view-toggle-btn--active' : ''}`}
            onClick={() => setViewMode('mosaic')}
            title="Mosaic View"
            aria-pressed={viewMode === 'mosaic'}
          >
            <span className="view-toggle-icon">
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
                <path d="M4 4h8v8H4z" />
                <path d="M4 16h8v4H4z" />
                <path d="M16 4h4v4h-4z" />
                <path d="M16 12h4v8h-4z" />
              </svg>
            </span>
            <span className="view-toggle-label">Mosaic</span>
          </button>
        </div>
      </div>

      <div className="gallery-content">
        {viewMode === 'mosaic' ? (
          <SharedMosaicPhotoGrid
            photos={photos}
            linkId={linkId}
            accessTier={accessTier}
            grantToken={grantToken}
            getTierKey={getTierKey}
            isLoadingKeys={isLoadingKeys}
          />
        ) : (
          <SharedPhotoGrid
            photos={photos}
            linkId={linkId}
            accessTier={accessTier}
            grantToken={grantToken}
            getTierKey={getTierKey}
            isLoadingKeys={isLoadingKeys}
          />
        )}
      </div>

      {albumDownload.isDownloading && albumDownload.progress && (
        <DownloadProgressOverlay
          progress={albumDownload.progress}
          onCancel={albumDownload.cancel}
        />
      )}
    </div>
  );
}
