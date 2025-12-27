import { getDbClient } from './db-client';
import { getCryptoClient } from './crypto-client';
import type { ManifestRecord, DecryptedManifest } from '../workers/types';

/**
 * Mock API client for parallel development
 * Will be replaced with real API when Stream B (Backend) is complete
 */
const mockApi = {
  async getAlbum(id: string) {
    return { id, currentVersion: 100 };
  },

  async syncDelta(
    _albumId: string,
    _since: number
  ): Promise<{
    manifests: ManifestRecord[];
    albumVersion: number;
    hasMore: boolean;
  }> {
    // Return empty data for mock
    return { manifests: [], albumVersion: 100, hasMore: false };
  },
};

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
   * @param readKey - Epoch read key for decryption
   */
  async sync(albumId: string, readKey: Uint8Array): Promise<void> {
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

      // Get local version
      const localVersion = await db.getAlbumVersion(albumId);

      // Fetch delta from server
      const response = await mockApi.syncDelta(albumId, localVersion);

      // Decrypt manifests
      const decrypted: DecryptedManifest[] = [];
      for (const m of response.manifests) {
        // Verify signature before decryption
        const isValid = await crypto.verifyManifest(
          m.encryptedMeta,
          new TextEncoder().encode(m.signature),
          new TextEncoder().encode(m.signerPubkey)
        );

        if (!isValid) {
          console.warn(`Invalid signature for manifest ${m.id}`);
          continue;
        }

        // Decrypt metadata
        const meta = await crypto.decryptManifest(m.encryptedMeta, readKey);

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

  private dispatchSyncEvent(type: SyncEventType, detail: SyncEventDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** Global sync engine instance */
export const syncEngine = new SyncEngine();

// Re-export types for convenience
export type { SyncEventType, SyncEventDetail };
