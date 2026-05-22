/**
 * Regression test for HIGH security-review-2026-05-22-05:
 * `flushSyncCompleteNow` previously had no per-album in-flight
 * coalescing. Burst/concurrent uploads each spawned their own bounded
 * retry sequence (up to 4 syncEngine.sync calls), amplifying worker/DB
 * load by N×retries instead of just retries.
 *
 * After the fix, concurrent flushes for the same album share one
 * promise + one bounded retry sequence. Flushes for different albums
 * remain independent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoMeta } from '../../workers/types';

const ALBUM_A = 'album-aaa';
const ALBUM_B = 'album-bbb';
const ASSET_A1 = '018f0000-0000-7000-8000-0000000000a1';
const ASSET_B1 = '018f0000-0000-7000-8000-0000000000b1';

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

function makePhoto(assetId: string, albumId: string): PhotoRow {
  return {
    id: assetId,
    assetId,
    albumId,
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

describe('SyncCoordinator.flushSyncCompleteNow coalescing (security-review-22-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('coalesces 3 concurrent flushes for the same album into one retry sequence', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);

    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_A);
    store.addPending(ALBUM_A, ASSET_A1, 'blob:local/fake');
    store.transitionToSyncing(ALBUM_A, ASSET_A1);
    syncCoordinator.registerPendingSync(ALBUM_A, ASSET_A1);

    // DB always returns empty so every attempt triggers a retry.
    // MAX_RETRIES = 4 inside performFlushWithRetry; each retry calls
    // syncEngine.sync exactly once. So a single coalesced sequence
    // yields exactly 4 syncEngine.sync invocations regardless of how
    // many concurrent callers invoke flushSyncCompleteNow.
    mocks.db.getPhotos.mockResolvedValue([] as PhotoMeta[]);
    mocks.syncEngine.sync.mockResolvedValue(undefined);

    // Dispatch 3 concurrent flushes. With coalescing they share one
    // promise; without coalescing they would each run 4 retries (12 total).
    const results = await Promise.all([
      syncCoordinator.flushSyncCompleteNow(ALBUM_A),
      syncCoordinator.flushSyncCompleteNow(ALBUM_A),
      syncCoordinator.flushSyncCompleteNow(ALBUM_A),
    ]);

    expect(results).toHaveLength(3);

    // Hard upper bound: a single bounded retry sequence is 1 + MAX_RETRIES
    // syncs at the outermost. The orchestrator calls syncEngine.sync
    // only on retry iterations (the initial handleSyncComplete pass does
    // NOT call syncEngine.sync), so the cap here is MAX_RETRIES (4).
    // Without coalescing this would be 3 * 4 = 12.
    expect(mocks.syncEngine.sync.mock.calls.length).toBeLessThanOrEqual(4);

    // And every sync call must be for ALBUM_A, never amplified to others.
    for (const call of mocks.syncEngine.sync.mock.calls) {
      expect(call[0]).toBe(ALBUM_A);
    }

    syncCoordinator.cancelPendingSync(ALBUM_A, ASSET_A1);
  });

  it('does NOT coalesce across different albums (independent retry sequences)', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);

    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_A);
    store.initAlbum(ALBUM_B);
    store.addPending(ALBUM_A, ASSET_A1, 'blob:local/fake-a');
    store.addPending(ALBUM_B, ASSET_B1, 'blob:local/fake-b');
    store.transitionToSyncing(ALBUM_A, ASSET_A1);
    store.transitionToSyncing(ALBUM_B, ASSET_B1);
    syncCoordinator.registerPendingSync(ALBUM_A, ASSET_A1);
    syncCoordinator.registerPendingSync(ALBUM_B, ASSET_B1);

    // First getPhotos read for either album returns empty (forces one
    // retry), subsequent reads return the matching photo so the retry
    // promotes and exits early.
    mocks.db.getPhotos.mockImplementation(async (albumId: string) => {
      const callCount = mocks.db.getPhotos.mock.calls.filter(
        (c) => c[0] === albumId,
      ).length;
      if (callCount === 1) return [] as PhotoMeta[];
      if (albumId === ALBUM_A)
        return [makePhoto(ASSET_A1, ALBUM_A)] as unknown as PhotoMeta[];
      return [makePhoto(ASSET_B1, ALBUM_B)] as unknown as PhotoMeta[];
    });
    mocks.syncEngine.sync.mockResolvedValue(undefined);

    await Promise.all([
      syncCoordinator.flushSyncCompleteNow(ALBUM_A),
      syncCoordinator.flushSyncCompleteNow(ALBUM_B),
    ]);

    // Each album must have invoked syncEngine.sync at least once
    // (independent retry sequences, no coalescing across albums).
    const albumACalls = mocks.syncEngine.sync.mock.calls.filter(
      (c) => c[0] === ALBUM_A,
    );
    const albumBCalls = mocks.syncEngine.sync.mock.calls.filter(
      (c) => c[0] === ALBUM_B,
    );
    expect(albumACalls.length).toBeGreaterThanOrEqual(1);
    expect(albumBCalls.length).toBeGreaterThanOrEqual(1);

    // Both pending items must have been promoted by the retry pass.
    const finalState = usePhotoStore.getState();
    expect(finalState.albums.get(ALBUM_A)?.items.get(ASSET_A1)?.status).toBe(
      'stable',
    );
    expect(finalState.albums.get(ALBUM_B)?.items.get(ASSET_B1)?.status).toBe(
      'stable',
    );
  });

  it('after a flush completes, a subsequent flush runs fresh (not a stale coalesced promise)', async () => {
    const { syncCoordinator } = await import('../sync-coordinator');
    const { usePhotoStore } = await import('../../stores/photo-store');

    usePhotoStore.setState({ albums: new Map() }, false);

    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_A);
    store.addPending(ALBUM_A, ASSET_A1, 'blob:local/fake');
    store.transitionToSyncing(ALBUM_A, ASSET_A1);
    syncCoordinator.registerPendingSync(ALBUM_A, ASSET_A1);

    // First flush: DB already shows the photo -> promotion on pass 1,
    // no retries needed, syncEngine.sync NOT called.
    mocks.db.getPhotos.mockResolvedValue([
      makePhoto(ASSET_A1, ALBUM_A),
    ] as unknown as PhotoMeta[]);
    mocks.syncEngine.sync.mockResolvedValue(undefined);

    await syncCoordinator.flushSyncCompleteNow(ALBUM_A);

    expect(mocks.syncEngine.sync).not.toHaveBeenCalled();
    expect(
      usePhotoStore.getState().albums.get(ALBUM_A)?.items.get(ASSET_A1)?.status,
    ).toBe('stable');

    // Second flush after the first resolved should NOT short-circuit on
    // a stale in-flight promise; it should run a fresh
    // performFlushWithRetry pass. No pending items remain so it returns
    // after the first handleSyncComplete with zero retry syncs.
    const dbCallsBefore = mocks.db.getPhotos.mock.calls.length;
    await syncCoordinator.flushSyncCompleteNow(ALBUM_A);
    const dbCallsAfter = mocks.db.getPhotos.mock.calls.length;

    // A fresh flush must have executed (at least one new DB read paged).
    expect(dbCallsAfter).toBeGreaterThan(dbCallsBefore);
    // Still no syncEngine.sync calls (nothing pending -> retry loop exits).
    expect(mocks.syncEngine.sync).not.toHaveBeenCalled();
  });
});
