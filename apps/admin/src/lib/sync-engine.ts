import { deriveTierKeys, memzero } from '@mosaic/crypto';
import type { DecryptedManifest } from '../workers/types';
import { fromBase64, getApi } from './api';
import { getCryptoClient } from './crypto-client';
import { getDbClient } from './db-client';
import {
    fetchAndUnwrapEpochKeys,
    getOrFetchEpochKey,
} from './epoch-key-service';
import {
    clearAllEpochKeys,
    getEpochKey,
    setEpochKey as storeEpochKey,
} from './epoch-key-store';
import { createLogger } from './logger';

const log = createLogger('sync-engine');

/**
 * Get epoch thumb key for manifest decryption.
 * Derives the thumbKey from epochSeed for decrypting manifests.
 * 
 * IMPORTANT: Manifests are encrypted with the thumbKey (tier 1), not the raw epochSeed.
 * This ensures share link recipients (who only have tier keys) can decrypt manifests.
 *
 * @param albumId - Album ID
 * @param epochId - Epoch ID
 * @returns thumbKey if available, null otherwise. Caller must call memzero() after use.
 */
async function getEpochThumbKey(
  albumId: string,
  epochId: number
): Promise<Uint8Array | null> {
  // Check cache first via epoch-key-store
  const cached = getEpochKey(albumId, epochId);
  if (cached) {
    const { thumbKey } = deriveTierKeys(cached.epochSeed);
    return thumbKey;
  }

  // Fetch and unwrap epoch keys from server
  try {
    const bundle = await getOrFetchEpochKey(albumId, epochId);
    const { thumbKey } = deriveTierKeys(bundle.epochSeed);
    return thumbKey;
  } catch (err) {
    log.error(`Failed to get epoch key ${epochId} for album ${albumId}`, err);
    return null;
  }
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
  
  /** Queued sync requests - album IDs that need sync after current sync completes */
  private pendingSyncQueue = new Map<string, Uint8Array | undefined>();

  /** Whether sync is currently in progress */
  get isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * Sync an album from the server.
   * If sync is already in progress, queues the request for after completion.
   * @param albumId - Album ID to sync
   * @param readKey - Epoch read key for decryption (optional if using cached keys)
   */
  async sync(albumId: string, readKey?: Uint8Array): Promise<void> {
    log.info(`Sync requested for album ${albumId}`, { hasReadKey: !!readKey });
    
    if (this.syncing) {
      // Queue this sync request - it will run after current sync completes
      // If same album is already queued, this updates the readKey
      log.debug(`Sync in progress, queueing sync for album ${albumId}`);
      this.pendingSyncQueue.set(albumId, readKey);
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
        // Get epoch seed for this manifest, then derive thumbKey for decryption.
        // Manifests are encrypted with thumbKey (tier 1) to enable share link decryption.
        let epochSeed = readKey;
        if (!epochSeed) {
          const cachedKey = await getEpochThumbKey(albumId, response.currentEpochId);
          if (!cachedKey) {
            log.warn(`No epoch key available for album ${albumId} epoch ${response.currentEpochId}`);
            continue;
          }
          // getEpochThumbKey already returns the derived thumbKey
          epochSeed = cachedKey;
        } else {
          // Caller passed epochSeed, derive thumbKey from it
          const { thumbKey } = deriveTierKeys(epochSeed);
          epochSeed = thumbKey;
        }

        // Decode base64 values from API
        const encryptedMeta = fromBase64(m.encryptedMeta);
        const signature = fromBase64(m.signature);
        const signerPubkey = fromBase64(m.signerPubkey);

        // DEBUG: Log the verification key details
        log.debug('Verifying manifest signature', {
          manifestId: m.id,
          signerPubkeyPrefix: Array.from(signerPubkey.slice(0, 8)).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
          signaturePrefix: Array.from(signature.slice(0, 8)).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
          encryptedMetaLength: encryptedMeta.length,
        });

        // Verify signature before decryption
        const isValid = await crypto.verifyManifest(
          encryptedMeta,
          signature,
          signerPubkey
        );

        if (!isValid) {
          log.warn(`Invalid signature for manifest ${m.id}`);
          // Zero out derived key before continuing
          memzero(epochSeed);
          continue;
        }

        // Decrypt metadata using the thumbKey
        const meta = await crypto.decryptManifest(encryptedMeta, epochSeed);

        // Zero out derived key after use
        memzero(epochSeed);

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

      log.info(`Dispatching sync-complete event for album ${albumId}`);
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
      
      // Process queued sync requests
      void this.processQueuedSyncs();
    }
  }

  /**
   * Process any queued sync requests after current sync completes.
   * This ensures uploads that completed during a sync still get synced.
   */
  private async processQueuedSyncs(): Promise<void> {
    if (this.pendingSyncQueue.size === 0) {
      return;
    }
    
    // Take all queued requests and clear the queue
    const queuedSyncs = Array.from(this.pendingSyncQueue.entries());
    this.pendingSyncQueue.clear();
    
    log.info(`Processing ${queuedSyncs.length} queued sync request(s)`);
    
    // Process each queued album (they will queue themselves if another is in progress)
    for (const [queuedAlbumId, queuedReadKey] of queuedSyncs) {
      try {
        await this.sync(queuedAlbumId, queuedReadKey);
      } catch (err) {
        log.error(`Queued sync failed for album ${queuedAlbumId}`, err);
      }
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
    clearAllEpochKeys();
  }

  /**
   * Get epoch read key from cache (if available)
   * Returns null if key not cached - caller should trigger sync first
   */
  getEpochKey(albumId: string, epochId: number): Uint8Array | null {
    const bundle = getEpochKey(albumId, epochId);
    return bundle?.epochSeed ?? null;
  }

  /**
   * Store an epoch seed in the cache
   * Used when unwrapping keys after sync
   * 
   * IMPORTANT: This method preserves existing signKeypair if the epoch key
   * was already cached with complete data. This prevents overwriting a
   * correctly unwrapped bundle with one that has empty signKeypair.
   */
  setEpochKey(albumId: string, epochId: number, epochSeed: Uint8Array): void {
    // Check if we already have a cached bundle with complete signKeypair
    const existing = getEpochKey(albumId, epochId);
    if (existing) {
      // Check if existing bundle has a valid (non-zero) signKeypair
      const hasValidSignKeypair = existing.signKeypair.publicKey.some(b => b !== 0);
      if (hasValidSignKeypair) {
        // Don't overwrite - we already have complete data
        log.debug(`Preserving existing epoch key ${epochId} with valid signKeypair`);
        return;
      }
    }
    
    // Store minimal bundle (legacy compatibility)
    storeEpochKey(albumId, {
      epochId,
      epochSeed,
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
      },
    });
  }

  /**
   * Ensure epoch keys are loaded for an album before sync.
   * Fetches and unwraps keys from server if not cached.
   */
  async ensureEpochKeys(albumId: string): Promise<void> {
    try {
      await fetchAndUnwrapEpochKeys(albumId);
    } catch (err) {
      log.error(`Failed to load epoch keys for album ${albumId}`, err);
    }
  }

  private dispatchSyncEvent(type: SyncEventType, detail: SyncEventDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** Global sync engine instance */
export const syncEngine = new SyncEngine();

// Re-export types for convenience
export type { SyncEventDetail, SyncEventType };

