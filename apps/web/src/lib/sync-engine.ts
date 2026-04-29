import type { DecryptedManifest, EpochHandleId, PhotoMeta } from '../workers/types';
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
import { purgeLocalPhoto } from './local-purge';

const log = createLogger('SyncEngine');
const MAX_SYNC_PAGINATION_ITERATIONS = 1000;

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Sync cancelled', 'AbortError');
  }

  const error = new Error('Sync cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function keysMatch(left: Uint8Array, right: Uint8Array): boolean {
  // Public-key comparison only. Do not use this helper for secrets.
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function hasValidSigningKey(pubkey: Uint8Array): boolean {
  return pubkey.length === 32 && pubkey.some((byte) => byte !== 0);
}

function createDeletedManifestTombstone(manifest: {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  shardIds: string[];
  createdAt?: string;
  updatedAt?: string;
}): DecryptedManifest {
  const timestamp = manifest.updatedAt ?? manifest.createdAt ?? new Date(0).toISOString();
  return {
    id: manifest.id,
    albumId: manifest.albumId,
    versionCreated: manifest.versionCreated,
    isDeleted: true,
    meta: {
      id: manifest.id,
      assetId: manifest.id,
      albumId: manifest.albumId,
      filename: '',
      mimeType: '',
      width: 0,
      height: 0,
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      shardIds: [],
      epochId: 0,
    },
    shardIds: manifest.shardIds,
  };
}

/** Sync event types */
type SyncEventType =
  | 'sync-start'
  | 'sync-progress'
  | 'sync-complete'
  | 'sync-error'
  | 'content-conflict';

interface SyncEventDetail {
  albumId: string;
  count?: number;
  error?: Error;
}

/**
 * Event detail for `content-conflict` events. Dispatched whenever an
 * album-content save (story blocks document) hits a 409 from the server
 * and the resolver picked a winner per
 * `docs/specs/SPEC-SyncConflictResolution.md`. The payload is plaintext
 * but only carries opaque block ids and resolution categories — never
 * keys, never raw block content — so listening UI can show a generic
 * "conflict resolved" toast without breaking zero-knowledge invariants.
 */
export interface ContentConflictEventDetail {
  /** Album whose content document collided with a server update. */
  albumId: string;
  /** How the merge was resolved (LWW vs three-way block merge). */
  strategy: 'lww-server-wins' | 'three-way-block-merge';
  /** Number of blocks where merge surfaced a manual conflict. */
  manualConflictCount: number;
  /** Total number of merge decisions reported. */
  totalDecisionCount: number;
  /** Block ids of manually-resolved conflicts (opaque, server-known ids). */
  manualConflictBlockIds: readonly string[];
}

/** Queued sync request with deferred promise */
interface QueuedSyncRequest {
  readKey: Uint8Array | undefined;
  resolvers: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

/**
 * Sync Engine
 * Handles synchronization between local database and server
 */
class SyncEngine extends EventTarget {
  private syncing = false;
  private syncAbortController: AbortController | null = null;

  /** Queued sync requests - album IDs that need sync after current sync completes */
  private pendingSyncQueue = new Map<string, QueuedSyncRequest>();

  /** Whether sync is currently in progress */
  get isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * Sync an album from the server.
   * If sync is already in progress, queues the request and returns a promise
   * that resolves when the queued sync completes.
   * @param albumId - Album ID to sync
   * @param readKey - Epoch read key for decryption (optional if using cached keys)
   */
  async sync(albumId: string, readKey?: Uint8Array): Promise<void> {
    log.info(`Sync requested for album ${albumId}`, { hasReadKey: !!readKey });

    if (this.syncing) {
      // Queue this sync request - it will run after current sync completes
      // Return a promise that resolves when the queued sync actually completes
      log.debug(`Sync in progress, queueing sync for album ${albumId}`);

      return new Promise<void>((resolve, reject) => {
        const existing = this.pendingSyncQueue.get(albumId);
        if (existing) {
          // Album already queued - add this resolver to the list
          // Update readKey if provided (latest key takes precedence)
          if (readKey) existing.readKey = readKey;
          existing.resolvers.push({ resolve, reject });
        } else {
          // New queue entry
          this.pendingSyncQueue.set(albumId, {
            readKey,
            resolvers: [{ resolve, reject }],
          });
        }
      });
    }

    this.syncing = true;
    this.syncAbortController = new AbortController();

    this.dispatchSyncEvent('sync-start', { albumId });

    try {
      const db = await getDbClient();
      const crypto = await getCryptoClient();
      const api = getApi();
      const signal = this.syncAbortController.signal;

      let sinceVersion = await db.getAlbumVersion(albumId);
      let iterationCount = 0;

      while (true) {
        throwIfAborted(signal);

        if (iterationCount >= MAX_SYNC_PAGINATION_ITERATIONS) {
          const error = new Error(
            `Sync pagination iteration cap reached for album ${albumId}`,
          );
          log.error(error.message, { albumId, sinceVersion, iterationCount });
          throw error;
        }
        iterationCount += 1;

        const response = await api.syncAlbum(albumId, sinceVersion, { signal });
        throwIfAborted(signal);

        if (response.hasMore && response.albumVersion <= sinceVersion) {
          const error = new Error(
            `Sync pagination did not advance album version for album ${albumId}`,
          );
          log.error(error.message, {
            albumId,
            sinceVersion,
            responseAlbumVersion: response.albumVersion,
            iterationCount,
          });
          throw error;
        }

        throwIfAborted(signal);
        const epochBundle = await getOrFetchEpochKey(
          albumId,
          response.currentEpochId,
        );
        throwIfAborted(signal);

        if (!hasValidSigningKey(epochBundle.signPublicKey)) {
          throw new Error(
            `Missing valid epoch signing key for album ${albumId} epoch ${response.currentEpochId}`,
          );
        }

        const decrypted: DecryptedManifest[] = [];
        for (const manifest of response.manifests) {
          throwIfAborted(signal);

          if (manifest.isDeleted) {
            await purgeLocalPhoto({
              albumId: manifest.albumId,
              photoId: manifest.id,
              reason: 'sync-deleted',
            });
            decrypted.push(createDeletedManifestTombstone(manifest));
            continue;
          }

          try {
            const encryptedMeta = fromBase64(manifest.encryptedMeta);
            const signature = fromBase64(manifest.signature);
            const serverSignerPubkey = fromBase64(manifest.signerPubkey);

            if (!hasValidSigningKey(serverSignerPubkey)) {
              log.warn(`Manifest ${manifest.id} has empty signer pubkey`);
              continue;
            }

            if (!keysMatch(serverSignerPubkey, epochBundle.signPublicKey)) {
              log.warn(
                `Manifest ${manifest.id} signer pubkey mismatch for album ${albumId}`,
              );
              continue;
            }

            throwIfAborted(signal);
            const isValid = await crypto.verifyManifest(
              encryptedMeta,
              signature,
              epochBundle.signPublicKey,
            );

            if (!isValid) {
              log.warn(`Invalid signature for manifest ${manifest.id}`);
              continue;
            }

            throwIfAborted(signal);
            // Slice 4 — manifest decryption now routes through the Rust
            // epoch handle. The thumb-tier key is derived inside Rust;
            // the seed and the per-epoch sign-secret never cross Comlink.
            const epochHandleId = epochBundle.epochHandleId as EpochHandleId;
            const plaintextBytes = await crypto.decryptManifestWithEpoch(
              epochHandleId,
              encryptedMeta,
            );
            throwIfAborted(signal);

            let meta: PhotoMeta;
            try {
              meta = JSON.parse(new TextDecoder().decode(plaintextBytes)) as PhotoMeta;
            } catch (parseErr) {
              log.warn(`Manifest ${manifest.id} JSON parse failed`, {
                error: parseErr instanceof Error ? parseErr.message : String(parseErr),
              });
              continue;
            }

            decrypted.push({
              id: manifest.id,
              albumId: manifest.albumId,
              versionCreated: manifest.versionCreated,
              isDeleted: manifest.isDeleted,
              meta,
              shardIds: manifest.shardIds,
            });
          } catch (decryptErr) {
            log.warn(`Failed to process manifest ${manifest.id}`, {
              error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
            });
          }
        }

        throwIfAborted(signal);
        if (decrypted.length > 0) {
          await db.insertManifests(decrypted);
          this.dispatchSyncEvent('sync-progress', {
            albumId,
            count: decrypted.length,
          });
        }

        await db.setAlbumVersion(albumId, response.albumVersion);
        sinceVersion = response.albumVersion;
        throwIfAborted(signal);

        if (!response.hasMore) {
          break;
        }
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
   * Resolves all pending promises for each queued album.
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
    for (const [queuedAlbumId, request] of queuedSyncs) {
      try {
        await this.sync(queuedAlbumId, request.readKey);
        // Resolve all waiting promises for this album
        for (const { resolve } of request.resolvers) {
          resolve();
        }
      } catch (err) {
        log.error(`Queued sync failed for album ${queuedAlbumId}`, err);
        // Reject all waiting promises for this album
        const error = err instanceof Error ? err : new Error(String(err));
        for (const { reject } of request.resolvers) {
          reject(error);
        }
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
      const hasValidSignKeypair = existing.signKeypair.publicKey.some(
        (b) => b !== 0,
      );
      if (hasValidSignKeypair) {
        // Don't overwrite - we already have complete data
        log.debug(
          `Preserving existing epoch key ${epochId} with valid signKeypair`,
        );
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

  private dispatchSyncEvent(
    type: SyncEventType,
    detail: SyncEventDetail,
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Notify subscribers that an album-content save observed a server-side
   * collision and the local conflict resolver had to merge. The detail
   * payload is intentionally minimal and contains no key material or
   * plaintext block bodies — see `ContentConflictEventDetail` for the
   * exact shape. This is the central seam used by the React
   * `AlbumContentContext` after a 409, so the `SyncCoordinator` can
   * surface a single normalized event to the UI rather than every
   * caller having to discover its own listener path.
   */
  notifyContentConflict(detail: ContentConflictEventDetail): void {
    log.warn(
      `Content conflict resolved for album ${detail.albumId}` +
        ` (strategy=${detail.strategy}, manual=${detail.manualConflictCount},` +
        ` total=${detail.totalDecisionCount})`,
    );
    this.dispatchEvent(new CustomEvent('content-conflict', { detail }));
  }
}

/** Global sync engine instance */
export const syncEngine = new SyncEngine();

// Re-export types for convenience
export type { SyncEventDetail, SyncEventType };
