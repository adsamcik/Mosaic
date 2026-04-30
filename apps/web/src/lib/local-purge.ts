import { releaseCover } from './album-cover-service';
import {
  clearCachedMetadata,
  clearStoredEncryptedName,
} from './album-metadata-service';
import { getDbClient } from './db-client';
import { clearAlbumKeys } from './epoch-key-store';
import { releasePhoto, releaseThumbnail } from './photo-service';
import { syncCoordinator } from './sync-coordinator';
import { uploadQueue } from './upload-queue';
import { usePhotoStore, type AlbumPhotoState } from '../stores/photo-store';

export type LocalPurgeReason =
  | 'sync-expired'
  | 'sync-deleted'
  | 'album-404'
  | 'album-410'
  | 'user-deleted';

export interface LocalAlbumPurgeTarget {
  albumId: string;
  reason: LocalPurgeReason;
}

export interface LocalPhotoPurgeTarget extends LocalAlbumPurgeTarget {
  photoId: string;
}

export interface LocalPurgeResult {
  albumId: string;
  purgedAlbum: boolean;
  purgedPhotoIds: string[];
  removedUploadTasks: number;
  blockers: string[];
}

interface DbPurgeClient {
  clearAlbumPhotos(albumId: string): Promise<void>;
  deleteManifest(manifestId: string): Promise<void>;
}

type PhotoStorePurge = Pick<
  ReturnType<typeof usePhotoStore.getState>,
  'getAlbumState' | 'purgeAlbum' | 'confirmDeleted'
>;

interface UploadQueuePurge {
  purgeAlbum?: (albumId: string) => Promise<number> | number;
  cancel?: (taskId: string) => Promise<void> | void;
}

interface SyncCoordinatorPurge {
  cancelPendingSync?: (albumId: string, assetId: string) => void;
}

export interface LocalPurgeDeps {
  getDbClient: () => Promise<DbPurgeClient>;
  clearAlbumKeys: (albumId: string) => void;
  clearCachedMetadata: (albumId: string) => void;
  clearStoredEncryptedName: (albumId: string) => void;
  releaseCover: (albumId: string) => void;
  releasePhoto: (photoId: string) => void;
  releaseThumbnail: (photoId: string) => void;
  photoStore: PhotoStorePurge;
  uploadQueue: UploadQueuePurge;
  syncCoordinator: SyncCoordinatorPurge;
}

function defaultDeps(): LocalPurgeDeps {
  return {
    getDbClient,
    clearAlbumKeys,
    clearCachedMetadata,
    clearStoredEncryptedName,
    releaseCover,
    releasePhoto,
    releaseThumbnail,
    photoStore: usePhotoStore.getState(),
    uploadQueue,
    syncCoordinator,
  };
}

function collectAlbumPhotoIds(albumState: AlbumPhotoState | undefined): string[] {
  if (!albumState) return [];

  const ids = new Set<string>();
  for (const [storeId, item] of albumState.items) {
    ids.add(storeId);
    ids.add(item.assetId);
  }
  return Array.from(ids);
}

function releasePhotoCaches(photoId: string, deps: LocalPurgeDeps): void {
  deps.releasePhoto(photoId);
  deps.releasePhoto(`${photoId}:full`);
  deps.releaseThumbnail(photoId);
}

function addBlocker(blockers: string[], blocker: string): void {
  if (!blockers.includes(blocker)) {
    blockers.push(blocker);
  }
}

/**
 * Purge all local client-side state for an album after sync observes that the
 * server has deleted or expired it. This never handles plaintext photo content;
 * it removes decrypted metadata caches, thumbnails, queued upload references,
 * local DB rows, and in-memory keys.
 */
export async function purgeLocalAlbum(
  target: LocalAlbumPurgeTarget,
  deps: LocalPurgeDeps = defaultDeps(),
): Promise<LocalPurgeResult> {
  const blockers: string[] = [];
  const albumState = deps.photoStore.getAlbumState(target.albumId);
  const photoIds = collectAlbumPhotoIds(albumState);

  for (const photoId of photoIds) {
    releasePhotoCaches(photoId, deps);
    deps.syncCoordinator.cancelPendingSync?.(target.albumId, photoId);
  }

  try {
    deps.releaseCover(target.albumId);
    deps.clearCachedMetadata(target.albumId);
    deps.clearStoredEncryptedName(target.albumId);
    deps.clearAlbumKeys(target.albumId);
  } catch {
    addBlocker(blockers, 'memory-cache-purge-failed');
  }

  try {
    const db = await deps.getDbClient();
    await db.clearAlbumPhotos(target.albumId);
  } catch {
    addBlocker(blockers, 'local-db-purge-failed');
  }

  let removedUploadTasks = 0;
  try {
    removedUploadTasks = Number(
      (await deps.uploadQueue.purgeAlbum?.(target.albumId)) ?? 0,
    );
  } catch {
    addBlocker(blockers, 'upload-queue-purge-failed');
  }

  try {
    deps.photoStore.purgeAlbum(target.albumId);
  } catch {
    addBlocker(blockers, 'photo-store-purge-failed');
  }

  return {
    albumId: target.albumId,
    purgedAlbum: true,
    purgedPhotoIds: photoIds,
    removedUploadTasks,
    blockers,
  };
}

/**
 * Purge local state for one photo tombstone observed during sync. This removes
 * decrypted metadata and cached thumbnails without touching album epoch keys.
 */
export async function purgeLocalPhoto(
  target: LocalPhotoPurgeTarget,
  deps: LocalPurgeDeps = defaultDeps(),
): Promise<LocalPurgeResult> {
  const blockers: string[] = [];

  releasePhotoCaches(target.photoId, deps);
  deps.syncCoordinator.cancelPendingSync?.(target.albumId, target.photoId);

  try {
    const db = await deps.getDbClient();
    await db.deleteManifest(target.photoId);
  } catch {
    addBlocker(blockers, 'local-db-purge-failed');
  }

  let removedUploadTasks = 0;
  try {
    if (deps.uploadQueue.cancel) {
      await deps.uploadQueue.cancel(target.photoId);
      removedUploadTasks = 1;
    }
  } catch {
    addBlocker(blockers, 'upload-queue-purge-failed');
  }

  try {
    deps.photoStore.confirmDeleted(target.albumId, target.photoId);
  } catch {
    addBlocker(blockers, 'photo-store-purge-failed');
  }

  return {
    albumId: target.albumId,
    purgedAlbum: false,
    purgedPhotoIds: [target.photoId],
    removedUploadTasks,
    blockers,
  };
}
