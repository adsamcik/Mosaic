import type { LinkDecryptionKey } from '../workers/types';
/**
 * Album Metadata Service
 *
 * Handles decryption and caching of album metadata (names, etc.)
 * that are encrypted with epoch-scoped tier keys.
 */

import { fromBase64 } from './api';
import { getCryptoClient } from './crypto-client';

/**
 * Error thrown when album metadata decryption fails
 */
export class AlbumMetadataError extends Error {
  constructor(
    message: string,
    public readonly albumId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'AlbumMetadataError';
  }
}

/** Decrypted album metadata */
export interface DecryptedAlbumMetadata {
  name: string;
}

/** In-memory cache for decrypted album metadata */
const metadataCache = new Map<string, DecryptedAlbumMetadata>();

/**
 * Decrypt an album name using a tier key directly (for share links).
 *
 * Use this function when you have the unwrapped tier key from a share link,
 * rather than an epoch seed. This is the correct method for SharedAlbumViewer
 * and other share link contexts where keys are already tier-specific.
 *
 * @param encryptedName - Base64-encoded encrypted name (or Uint8Array)
 * @param tierKey - Tier-specific decryption key (32 bytes, already derived)
 * @param albumId - Album ID for error context
 * @returns Decrypted album name
 * @throws AlbumMetadataError if decryption fails
 */
export async function decryptAlbumNameWithTierKey(
  encryptedName: string | Uint8Array,
  tierKey: LinkDecryptionKey,
  albumId: string,
): Promise<string> {
  try {
    // Convert base64 to Uint8Array if needed
    const encryptedBytes =
      typeof encryptedName === 'string'
        ? fromBase64(encryptedName)
        : encryptedName;

    // Validate inputs
    if (!encryptedBytes || encryptedBytes.length === 0) {
      throw new Error('Encrypted name is empty');
    }

    if (!tierKey || (typeof tierKey !== 'string' && tierKey.length !== 32)) {
      throw new Error('Invalid tier key handle/key');
    }

    // Decrypt using crypto worker with tier key directly (no derivation)
    const crypto = await getCryptoClient();
    const decryptedBytes = await crypto.decryptShardWithTierKey(
      encryptedBytes,
      tierKey,
    );

    // Decode UTF-8 text
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const name = decoder.decode(decryptedBytes);

    return name;
  } catch (err) {
    throw new AlbumMetadataError(
      `Failed to decrypt album name: ${err instanceof Error ? err.message : String(err)}`,
      albumId,
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Get decrypted album metadata from cache.
 *
 * @param albumId - Album ID
 * @returns Cached metadata or null if not cached
 */
export function getCachedMetadata(
  albumId: string,
): DecryptedAlbumMetadata | null {
  return metadataCache.get(albumId) ?? null;
}

/**
 * Cache decrypted album metadata.
 *
 * @param albumId - Album ID
 * @param metadata - Decrypted metadata to cache
 */
export function setCachedMetadata(
  albumId: string,
  metadata: DecryptedAlbumMetadata,
): void {
  metadataCache.set(albumId, metadata);
}

/**
 * Clear cached metadata for a specific album.
 *
 * @param albumId - Album ID
 */
export function clearCachedMetadata(albumId: string): void {
  metadataCache.delete(albumId);
}

/**
 * Clear all cached metadata.
 * Should be called on logout.
 */
export function clearAllCachedMetadata(): void {
  metadataCache.clear();
}

/**
 * Get encrypted album name from localStorage (temporary storage).
 *
 * This is used until the server supports album metadata in the API response.
 * Encrypted names are stored during album creation.
 *
 * @param albumId - Album ID
 * @returns Base64-encoded encrypted name or null if not found
 */
export function getStoredEncryptedName(albumId: string): string | null {
  return localStorage.getItem(`mosaic:album:${albumId}:encryptedName`);
}

/**
 * Store encrypted album name in localStorage (temporary storage).
 *
 * @param albumId - Album ID
 * @param encryptedName - Base64-encoded encrypted name
 */
export function setStoredEncryptedName(
  albumId: string,
  encryptedName: string,
): void {
  localStorage.setItem(`mosaic:album:${albumId}:encryptedName`, encryptedName);
}

/**
 * Clear stored encrypted name from localStorage.
 *
 * @param albumId - Album ID
 */
export function clearStoredEncryptedName(albumId: string): void {
  localStorage.removeItem(`mosaic:album:${albumId}:encryptedName`);
}
