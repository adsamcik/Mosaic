import { getDbClient } from './db-client';
import { getCryptoClient } from './crypto-client';
import { getApi, fromBase64 } from './api';
import type { DecryptedManifest } from '../workers/types';

/** Epoch key cache: albumId -> epochId -> readKey */
const epochKeyCache = new Map<string, Map<number, Uint8Array>>();

/**
 * Get or fetch epoch read key for an album/epoch
 */
async function getEpochReadKey(
  albumId: string,
  epochId: number
): Promise<Uint8Array | null> {
  // Check cache first
  let albumKeys = epochKeyCache.get(albumId);
  if (albumKeys?.has(epochId)) {
    return albumKeys.get(epochId)!;
  }

  // Fetch epoch keys from server
  const api = getApi();
  const epochKeys = await api.getEpochKeys(albumId);

  // Initialize cache for album if needed
  if (!albumKeys) {
    albumKeys = new Map();
    epochKeyCache.set(albumId, albumKeys);
  }

  // For now, store the encrypted key bundles
  // TODO: When crypto worker has identity key support, unwrap these
  for (const ek of epochKeys) {
    // The epoch key needs to be unwrapped using the user's identity key
    // For now, we'll need to extend the crypto worker to support this
    // This is a placeholder that stores the encrypted bundle
    const bundle = fromBase64(ek.encryptedKeyBundle);
    
    // TODO: Properly unwrap using crypto.openEpochKeyBundle
    // For now, we can't proceed without identity key support
    // albumKeys.set(ek.epochId, await crypto.openEpochKeyBundle(bundle, ...));
    
    // Temporary: skip if we can't unwrap
    console.warn(`Epoch key ${ek.epochId} needs unwrapping (${bundle.length} bytes)`);
  }

  return albumKeys.get(epochId) ?? null;
}

/** Sync event types */
type SyncEventType = 'sync-start' | 'sync-progress' | 'sync-complete' | 'sync-error';

interface SyncEventDetail {
  albumId: string;
  count?: number;
  error?: Error;
}

/**
 * Sync Engine
 * Handles synchronization between local database and server
 */
class SyncEngine extends EventTarget {
  private syncing = false;
  private syncAbortController: AbortController | null = null;

  /** Whether sync is currently in progress */
  get isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * Sync an album from the server
   * @param albumId - Album ID to sync
   * @param readKey - Epoch read key for decryption (optional if using cached keys)
   */
  async sync(albumId: string, readKey?: Uint8Array): Promise<void> {
    if (this.syncing) {
      console.warn('Sync already in progress');
      return;
    }

    this.syncing = true;
    this.syncAbortController = new AbortController();

    this.dispatchSyncEvent('sync-start', { albumId });

    try {
      const db = await getDbClient();
      const crypto = await getCryptoClient();
      const api = getApi();

      // Get local version
      const localVersion = await db.getAlbumVersion(albumId);

      // Fetch delta from server
      const response = await api.syncAlbum(albumId, localVersion);

      // Decrypt manifests
      const decrypted: DecryptedManifest[] = [];
      for (const m of response.manifests) {
        // Get epoch read key for this manifest
        let epochReadKey = readKey;
        if (!epochReadKey) {
          const cachedKey = await getEpochReadKey(albumId, m.versionCreated);
          if (!cachedKey) {
            console.warn(`No epoch key available for manifest ${m.id}`);
            continue;
          }
          epochReadKey = cachedKey;
        }

        // Decode base64 values from API
        const encryptedMeta = fromBase64(m.encryptedMeta);
        const signature = fromBase64(m.signature);
        const signerPubkey = fromBase64(m.signerPubkey);

        // Verify signature before decryption
        const isValid = await crypto.verifyManifest(
          encryptedMeta,
          signature,
          signerPubkey
        );

        if (!isValid) {
          console.warn(`Invalid signature for manifest ${m.id}`);
          continue;
        }

        // Decrypt metadata
        const meta = await crypto.decryptManifest(encryptedMeta, epochReadKey);

        decrypted.push({
          id: m.id,
          albumId: m.albumId,
          versionCreated: m.versionCreated,
          isDeleted: m.isDeleted,
          meta,
          shardIds: m.shardIds,
        });
      }

      // Store in local database
      if (decrypted.length > 0) {
        await db.insertManifests(decrypted);
        await db.setAlbumVersion(albumId, response.albumVersion);

        this.dispatchSyncEvent('sync-progress', {
          albumId,
          count: decrypted.length,
        });
      }

      // Continue if more data available
      if (response.hasMore) {
        await this.sync(albumId, readKey);
        return;
      }

      this.dispatchSyncEvent('sync-complete', { albumId });
    } catch (error) {
      this.dispatchSyncEvent('sync-error', {
        albumId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    } finally {
      this.syncing = false;
      this.syncAbortController = null;
    }
  }

  /**
   * Cancel ongoing sync
   */
  cancel(): void {
    if (this.syncAbortController) {
      this.syncAbortController.abort();
    }
  }

  /**
 * Clear cached epoch keys (call on logout)
 */
clearCache(): void {
  epochKeyCache.clear();
}

/**
 * Get epoch read key from cache (if available)
 * Returns null if key not cached - caller should trigger sync first
 */
getEpochKey(albumId: string, epochId: number): Uint8Array | null {
  const albumKeys = epochKeyCache.get(albumId);
  return albumKeys?.get(epochId) ?? null;
}

/**
 * Store an epoch read key in the cache
 * Used when unwrapping keys after sync
 */
setEpochKey(albumId: string, epochId: number, readKey: Uint8Array): void {
  let albumKeys = epochKeyCache.get(albumId);
  if (!albumKeys) {
    albumKeys = new Map();
    epochKeyCache.set(albumId, albumKeys);
  }
  albumKeys.set(epochId, readKey);
}

private dispatchSyncEvent(type: SyncEventType, detail: SyncEventDetail): void {
  this.dispatchEvent(new CustomEvent(type, { detail }));
}
}

/** Global sync engine instance */
export const syncEngine = new SyncEngine();

// Re-export types for convenience
export type { SyncEventType, SyncEventDetail };
