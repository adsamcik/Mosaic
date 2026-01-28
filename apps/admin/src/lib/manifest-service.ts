/**
 * Manifest creation service for uploads.
 * Shared between UploadContext and useUpload hook.
 */

import { getApi, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';
import type { EpochKeyBundle } from './epoch-key-store';
import type { UploadTask } from './upload-queue';
import type { PhotoMeta, TieredShardIds } from '../workers/types';

/**
 * Create a manifest after all shards are uploaded.
 * This ties the uploaded shards together and makes the photo visible.
 */
export async function createManifestForUpload(
  task: UploadTask,
  shardIds: string[],
  epochKey: EpochKeyBundle,
  tieredShards?: TieredShardIds,
): Promise<void> {
  const crypto = await getCryptoClient();
  const api = getApi();

  // Build shard hashes array (in order of shard index)
  const sortedShards = [...task.completedShards].sort(
    (a, b) => a.index - b.index,
  );
  const shardHashes = sortedShards.map((s) => s.sha256);

  // Use detected MIME type (from magic bytes) over browser-reported type
  // This is more reliable for formats like HEIC
  const mimeType =
    task.detectedMimeType || task.file.type || 'application/octet-stream';

  // Build photo metadata with tier-specific shard IDs
  const now = new Date().toISOString();
  const photoMeta: PhotoMeta = {
    id: globalThis.crypto.randomUUID(),
    assetId: task.id,
    albumId: task.albumId,
    filename: task.file.name,
    mimeType,
    width: task.originalWidth ?? 0,
    height: task.originalHeight ?? 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    shardIds: shardIds, // Legacy: flat array for backward compatibility
    shardHashes: shardHashes, // For integrity verification during download
    epochId: task.epochId,
    // Only set optional fields if they have values
    ...(task.thumbnailBase64 && { thumbnail: task.thumbnailBase64 }),
    ...(task.thumbWidth && { thumbWidth: task.thumbWidth }),
    ...(task.thumbHeight && { thumbHeight: task.thumbHeight }),
    ...(task.thumbhash && { thumbhash: task.thumbhash }),
    // New tier-specific shard IDs
    ...(tieredShards && {
      thumbnailShardId: tieredShards.thumbnail.shardId,
      thumbnailShardHash: tieredShards.thumbnail.sha256,
      previewShardId: tieredShards.preview.shardId,
      previewShardHash: tieredShards.preview.sha256,
      originalShardIds: tieredShards.original.map((s) => s.shardId),
      originalShardHashes: tieredShards.original.map((s) => s.sha256),
    }),
  };

  // Encrypt the manifest metadata
  const encrypted = await crypto.encryptManifest(
    photoMeta,
    epochKey.epochSeed,
    task.epochId,
  );

  // Sign the encrypted manifest with the epoch signing key
  const signature = await crypto.signManifest(
    encrypted.ciphertext,
    epochKey.signKeypair.secretKey,
  );

  // Get signer public key
  const signerPubkey = epochKey.signKeypair.publicKey;

  // Build tiered shard info for backend if available
  const tieredShardInfo = tieredShards
    ? [
        { shardId: tieredShards.thumbnail.shardId, tier: 1 },
        { shardId: tieredShards.preview.shardId, tier: 2 },
        ...tieredShards.original.map((s) => ({ shardId: s.shardId, tier: 3 })),
      ]
    : undefined;

  // Create manifest via API
  await api.createManifest({
    albumId: task.albumId,
    encryptedMeta: toBase64(encrypted.ciphertext),
    signature: toBase64(signature),
    signerPubkey: toBase64(signerPubkey),
    shardIds: shardIds,
    // Send tier info to backend for new uploads
    ...(tieredShardInfo && { tieredShards: tieredShardInfo }),
  });
}
