import type { AccessTier as AccessTierType } from './api-types';
import type { AlbumDownloadResolver } from './album-download-service';
import { getCryptoClient } from './crypto-client';
import { createLogger } from './logger';
import { downloadShardViaShareLink } from './shard-service';
import type { PhotoMeta } from '../workers/types';

const log = createLogger('SharedAlbumDownload');

export interface SharedAlbumDownloadStrategyOptions {
  linkId: string;
  grantToken?: string | null | undefined;
  /**
   * Look up the tier-specific decryption key for the given epoch. Mirrors
   * the lookup used by SharedPhotoLightbox so identical access rules apply.
   */
  getTierKey: (
    epochId: number,
    tier: AccessTierType,
  ) => Uint8Array | undefined;
}

/**
 * Resolve the original-tier (tier 3) bytes for a photo via a share link.
 *
 * Used by the shared-album "Download All" flow when the link grants full
 * access. Mirrors the per-shard fetch + tier-key decrypt path that
 * SharedPhotoLightbox uses for individual photos so that any photo viewable
 * in the lightbox is also downloadable through the bulk ZIP flow.
 */
export function createShareLinkOriginalResolver(
  opts: SharedAlbumDownloadStrategyOptions,
): AlbumDownloadResolver {
  const { linkId, grantToken, getTierKey } = opts;
  const grant = grantToken ?? undefined;

  return async (photo: PhotoMeta): Promise<Uint8Array> => {
    const crypto = await getCryptoClient();

    // Prefer the explicit tier-3 shard list when present (current upload
    // pipeline). Fall back to the legacy combined `shardIds` array, where
    // shard tiers are discovered by peeking at each header.
    const originalShardIds = photo.originalShardIds ?? [];

    let shardIds: string[];
    if (originalShardIds.length > 0) {
      shardIds = originalShardIds;
    } else {
      // Legacy fallback: download every shard, peek headers, keep tier-3.
      const downloaded: { id: string; data: Uint8Array; tier: number }[] = [];
      for (let i = 0; i < photo.shardIds.length; i++) {
        const id = photo.shardIds[i]!;
        const data = grant
          ? await downloadShardViaShareLink(linkId, id, grant)
          : await downloadShardViaShareLink(linkId, id);
        const expectedHash = photo.shardHashes?.[i];
        if (expectedHash) {
          const isValid = await crypto.verifyShard(data, expectedHash);
          if (!isValid) {
            log.warn(
              `Shard integrity check failed for photo ${photo.id}, shard ${i}`,
            );
          }
        }
        const header = await crypto.peekHeader(data);
        downloaded.push({ id, data, tier: header.tier });
      }

      const originals = downloaded.filter((s) => s.tier === 3);
      if (originals.length === 0) {
        throw new Error(
          `No original-tier shards available for photo ${photo.id}`,
        );
      }

      const decryptionKey = getTierKey(photo.epochId, 3);
      if (!decryptionKey) {
        throw new Error(
          `No tier 3 decryption key available for epoch ${photo.epochId}`,
        );
      }

      const chunks: Uint8Array[] = [];
      for (const s of originals) {
        chunks.push(
          await crypto.decryptShardWithTierKey(s.data, decryptionKey),
        );
      }
      return concat(chunks);
    }

    const decryptionKey = getTierKey(photo.epochId, 3);
    if (!decryptionKey) {
      throw new Error(
        `No tier 3 decryption key available for epoch ${photo.epochId}`,
      );
    }

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < shardIds.length; i++) {
      const id = shardIds[i]!;
      const data = grant
        ? await downloadShardViaShareLink(linkId, id, grant)
        : await downloadShardViaShareLink(linkId, id);
      const expectedHash = photo.originalShardHashes?.[i];
      if (expectedHash) {
        const isValid = await crypto.verifyShard(data, expectedHash);
        if (!isValid) {
          log.warn(
            `Shard integrity check failed for photo ${photo.id}, shard ${i}`,
          );
        }
      }
      try {
        chunks.push(await crypto.decryptShardWithTierKey(data, decryptionKey));
      } catch (err) {
        log.error(
          `Failed to decrypt original shard ${id} for photo ${photo.id}`,
          err,
        );
        throw err;
      }
    }
    return concat(chunks);
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
