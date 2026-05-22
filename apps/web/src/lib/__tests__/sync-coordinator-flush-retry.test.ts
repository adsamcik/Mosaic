/**
 * Regression test for validation-final-gate-v101-cert-02:
 * sequential uploads where the first manifest insert isn't visible
 * to the subsequent `loadAllAlbumPhotos` read. Without retry, the
 * pending overlay sticks until the 30s sync timeout fires and the
 * upload is marked failed. With retry, the second pass picks up the
 * manifest and promotes the pending item to stable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

const ALBUM_ID = 'album-test';
const ASSET_ID_1 = '018f0000-0000-7000-8000-000000000001';

interface PhotoRow {
  id: string;
  assetId: string;
  albumId: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  tags: string[];
  shardIds: string[];
  epochId: number;
  createdAt: string;
  updatedAt: string;
}

function makePhoto(assetId: string): PhotoRow {
  return {
    id: assetId,
    assetId,
    albumId: ALBUM_ID,
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    tags: [],
    shardIds: [],
    epochId: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const mocks = vi.hoisted(() => ({
  db: {
    getPhotos: vi.fn(),
  },
  syncEngine: {
    sync: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db-client', () => ({
  getDbClient: () => Promise.resolve(mocks.db),
}));

vi.mock('../sync-engine', () => ({
  syncEngine: mocks.syncEngine,
}));

vi.mock('../logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../sync-types', () => ({
  registerSyncCoordinatorPurge: vi.fn(),
}));

describe('SyncCoordinator.flushSyncCompleteNow retry (v101-cert-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('promotes a pending item that only appears in DB on a retry pass', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    // Reset store between tests
    usePhotoStore.setState({ albums: new Map() }, false);

    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, ASSET_ID_1, 'blob:local/fake');
    store.transitionToSyncing(ALBUM_ID, ASSET_ID_1);
    syncCoordinator.registerPendingSync(ALBUM_ID, ASSET_ID_1);

    // First DB read: empty (manifest insert not yet visible).
    // Second DB read (after retry sync): manifest visible.
    mocks.db.getPhotos
      .mockResolvedValueOnce([] as PhotoMeta[])
      .mockResolvedValueOnce([makePhoto(ASSET_ID_1)] as unknown as PhotoMeta[])
      .mockResolvedValue([makePhoto(ASSET_ID_1)] as unknown as PhotoMeta[]);

    mocks.syncEngine.sync.mockResolvedValue(undefined);

    await syncCoordinator.flushSyncCompleteNow(ALBUM_ID);

    // The pending item must have been promoted to stable.
    const finalState = usePhotoStore.getState();
    const album = finalState.albums.get(ALBUM_ID);
    expect(album).toBeDefined();
    const item = album!.items.get(ASSET_ID_1);
    expect(item?.status).toBe('stable');

    // syncEngine.sync must have been called at least once for the retry path.
    expect(mocks.syncEngine.sync).toHaveBeenCalled();

    // Cleanup pendingSyncs to avoid leaking timers between tests.
    syncCoordinator.cancelPendingSync(ALBUM_ID, ASSET_ID_1);
  });

  it('skips retry when first pass already promoted (no extra syncs)', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);

    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, ASSET_ID_1, 'blob:local/fake');
    store.transitionToSyncing(ALBUM_ID, ASSET_ID_1);
    syncCoordinator.registerPendingSync(ALBUM_ID, ASSET_ID_1);

    mocks.db.getPhotos.mockResolvedValue([
      makePhoto(ASSET_ID_1),
    ] as unknown as PhotoMeta[]);
    mocks.syncEngine.sync.mockResolvedValue(undefined);

    await syncCoordinator.flushSyncCompleteNow(ALBUM_ID);

    const item = usePhotoStore
      .getState()
      .albums.get(ALBUM_ID)
      ?.items.get(ASSET_ID_1);
    expect(item?.status).toBe('stable');

    // No retry needed - syncEngine.sync should NOT have been re-invoked.
    expect(mocks.syncEngine.sync).not.toHaveBeenCalled();

    syncCoordinator.cancelPendingSync(ALBUM_ID, ASSET_ID_1);
  });
});
