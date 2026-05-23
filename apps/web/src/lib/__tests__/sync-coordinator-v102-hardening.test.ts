/**
 * v1.0.2 sync-coordinator hardening tests covering:
 *  - v102-flush-coalesce-hung-promise-timeout
 *  - v102-flush-retry-final-failure-surface
 *  - v102-flush-retry-telemetry-rootcause
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

const ALBUM_ID = 'album-v102';
const ASSET_ID = '018f0000-0000-7000-8000-000000000777';

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

describe('SyncCoordinator v1.0.2 hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushSyncCompleteNow timeout: fires, clears flushInFlight, marks items failed_permanent (item 1)', async () => {
    vi.useFakeTimers();
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, ASSET_ID, 'blob:fake');
    store.transitionToSyncing(ALBUM_ID, ASSET_ID);
    syncCoordinator.registerPendingSync(ALBUM_ID, ASSET_ID);

    // First DB read hangs forever, so handleSyncComplete never resolves.
    mocks.db.getPhotos.mockReturnValue(new Promise<PhotoMeta[]>(() => {}));

    const flush = syncCoordinator.flushSyncCompleteNow(ALBUM_ID);
    const observed = flush.catch((err: unknown) => err);

    // Advance past FLUSH_TIMEOUT_MS (60s).
    await vi.advanceTimersByTimeAsync(60_500);

    const err = await observed;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/hung for 60000ms/);

    // Map entry must be cleaned up so subsequent flush is not coalesced
    // into the dead promise.
    mocks.db.getPhotos.mockResolvedValueOnce([] as PhotoMeta[]);
    await syncCoordinator.flushSyncCompleteNow(ALBUM_ID);

    // Item must be terminally failed_permanent so pending observers unblock.
    const item = usePhotoStore
      .getState()
      .albums.get(ALBUM_ID)
      ?.items.get(ASSET_ID);
    expect(item?.status).toBe('failed_permanent');
    expect(item?.error).toMatch(/timed out/i);

    expect(syncCoordinator.getRetryMetrics().flushTimeouts).toBe(1);
  });

  it('surfaces retry-sync failure to pending items as failed_permanent (item 2)', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, ASSET_ID, 'blob:fake');
    store.transitionToSyncing(ALBUM_ID, ASSET_ID);
    syncCoordinator.registerPendingSync(ALBUM_ID, ASSET_ID);

    // DB read always returns empty so the retry loop kicks in.
    mocks.db.getPhotos.mockResolvedValue([] as PhotoMeta[]);
    // First retry sync throws → bridge must surface failure.
    mocks.syncEngine.sync.mockRejectedValueOnce(new Error('network down'));

    await syncCoordinator.flushSyncCompleteNow(ALBUM_ID);

    const item = usePhotoStore
      .getState()
      .albums.get(ALBUM_ID)
      ?.items.get(ASSET_ID);
    expect(item?.status).toBe('failed_permanent');
    expect(item?.error).toMatch(/network down/);
    expect(syncCoordinator.getRetryMetrics().retrySyncFailures).toBe(1);
  });

  it('exposes retry telemetry counters (item 3)', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, ASSET_ID, 'blob:fake');
    store.transitionToSyncing(ALBUM_ID, ASSET_ID);
    syncCoordinator.registerPendingSync(ALBUM_ID, ASSET_ID);

    const makePhoto = (): PhotoMeta =>
      ({
        id: ASSET_ID,
        assetId: ASSET_ID,
        albumId: ALBUM_ID,
        filename: 'p.jpg',
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        tags: [],
        shardIds: [],
        epochId: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as unknown as PhotoMeta;

    // First pass empty; second pass (after retry sync) returns the photo.
    mocks.db.getPhotos
      .mockResolvedValueOnce([] as PhotoMeta[])
      .mockResolvedValue([makePhoto()]);
    mocks.syncEngine.sync.mockResolvedValue(undefined);

    const before = syncCoordinator.getRetryMetrics();
    await syncCoordinator.flushSyncCompleteNow(ALBUM_ID);
    const after = syncCoordinator.getRetryMetrics();

    expect(after.totalRetryAttempts).toBeGreaterThan(before.totalRetryAttempts);
    expect(after.retrySuccesses).toBeGreaterThan(before.retrySuccesses);
    // Snapshots must be fresh objects (no shared mutable reference).
    expect(after).not.toBe(before);
  });
});
