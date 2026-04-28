import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeLocalAlbum, purgeLocalPhoto } from '../src/lib/local-purge';

function createDeps() {
  return {
    getDbClient: vi.fn().mockResolvedValue({
      clearAlbumPhotos: vi.fn().mockResolvedValue(undefined),
      deleteManifest: vi.fn().mockResolvedValue(undefined),
    }),
    clearAlbumKeys: vi.fn(),
    clearCachedMetadata: vi.fn(),
    clearStoredEncryptedName: vi.fn(),
    releaseCover: vi.fn(),
    releasePhoto: vi.fn(),
    releaseThumbnail: vi.fn(),
    photoStore: {
      getAlbumState: vi.fn().mockReturnValue({
        items: new Map([
          [
            'manifest-1',
            {
              assetId: 'manifest-1',
              albumId: 'album-1',
              status: 'stable',
              thumbnailUrl: 'blob:thumb-1',
            },
          ],
          [
            'pending-1',
            {
              assetId: 'pending-1',
              albumId: 'album-1',
              status: 'pending',
              localBlobUrl: 'blob:pending-1',
            },
          ],
        ]),
      }),
      purgeAlbum: vi.fn(),
      confirmDeleted: vi.fn(),
    },
    uploadQueue: {
      purgeAlbum: vi.fn().mockResolvedValue(2),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    syncCoordinator: {
      cancelPendingSync: vi.fn(),
    },
  };
}

describe('local purge helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('purges album-local decrypted metadata, thumbnails, queue references, and keys', async () => {
    const deps = createDeps();

    const result = await purgeLocalAlbum(
      { albumId: 'album-1', reason: 'sync-expired' },
      deps,
    );

    const db = await deps.getDbClient.mock.results[0]!.value;
    expect(db.clearAlbumPhotos).toHaveBeenCalledWith('album-1');
    expect(deps.clearAlbumKeys).toHaveBeenCalledWith('album-1');
    expect(deps.clearCachedMetadata).toHaveBeenCalledWith('album-1');
    expect(deps.clearStoredEncryptedName).toHaveBeenCalledWith('album-1');
    expect(deps.releaseCover).toHaveBeenCalledWith('album-1');
    expect(deps.releasePhoto).toHaveBeenCalledWith('manifest-1');
    expect(deps.releaseThumbnail).toHaveBeenCalledWith('manifest-1');
    expect(deps.uploadQueue.purgeAlbum).toHaveBeenCalledWith('album-1');
    expect(deps.photoStore.purgeAlbum).toHaveBeenCalledWith('album-1');
    expect(deps.syncCoordinator.cancelPendingSync).toHaveBeenCalledWith(
      'album-1',
      'pending-1',
    );
    expect(result).toEqual({
      albumId: 'album-1',
      purgedAlbum: true,
      purgedPhotoIds: ['manifest-1', 'pending-1'],
      removedUploadTasks: 2,
      blockers: [],
    });
  });

  it('purges a single sync-deleted photo without album-wide key removal', async () => {
    const deps = createDeps();

    const result = await purgeLocalPhoto(
      { albumId: 'album-1', photoId: 'manifest-1', reason: 'sync-deleted' },
      deps,
    );

    const db = await deps.getDbClient.mock.results[0]!.value;
    expect(db.deleteManifest).toHaveBeenCalledWith('manifest-1');
    expect(deps.photoStore.confirmDeleted).toHaveBeenCalledWith(
      'album-1',
      'manifest-1',
    );
    expect(deps.releasePhoto).toHaveBeenCalledWith('manifest-1');
    expect(deps.releaseThumbnail).toHaveBeenCalledWith('manifest-1');
    expect(deps.uploadQueue.cancel).toHaveBeenCalledWith('manifest-1');
    expect(deps.syncCoordinator.cancelPendingSync).toHaveBeenCalledWith(
      'album-1',
      'manifest-1',
    );
    expect(deps.clearAlbumKeys).not.toHaveBeenCalled();
    expect(result).toEqual({
      albumId: 'album-1',
      purgedAlbum: false,
      purgedPhotoIds: ['manifest-1'],
      removedUploadTasks: 1,
      blockers: [],
    });
  });
});
