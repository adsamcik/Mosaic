/**
 * v1.0.2 photo-store hardening tests:
 *  - v102-latepromote-intent-ttl-sweep (active sweep + FIFO cap)
 *  - v102-permanent-failures-leave-pending (terminal failed_permanent)
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LATE_PROMOTE_TTL_MS,
  MAX_INTENTS_PER_ALBUM,
  usePhotoStore,
} from '../photo-store';

const ALBUM_ID = 'album-v102';

beforeEach(() => {
  usePhotoStore.setState((state) => {
    state.albums.clear();
    state.activeAlbumId = null;
  });
  if (!('revokeObjectURL' in URL)) {
    (
      URL as unknown as { revokeObjectURL: (url: string) => void }
    ).revokeObjectURL = () => undefined;
  }
});

describe('PhotoStore v1.0.2 hardening', () => {
  it('latePromoteIntents: FIFO-evicts when MAX_INTENTS_PER_ALBUM is reached', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);

    // Insert MAX + 1 distinct promote intents (no matching addPending).
    for (let i = 0; i < MAX_INTENTS_PER_ALBUM + 1; i++) {
      store.promoteToStable(ALBUM_ID, `asset-${i}`, {
        thumbnailUrl: 'data:image/jpeg;base64,abc',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      });
    }

    const album = usePhotoStore.getState().albums.get(ALBUM_ID);
    expect(album?.latePromoteIntents.size).toBe(MAX_INTENTS_PER_ALBUM);
    // FIFO: oldest (asset-0) is evicted, newest (asset-MAX) is kept.
    expect(album?.latePromoteIntents.has('asset-0')).toBe(false);
    expect(
      album?.latePromoteIntents.has(`asset-${MAX_INTENTS_PER_ALBUM}`),
    ).toBe(true);
  });

  it('pruneAllLatePromoteIntents: actively sweeps stale entries across albums', () => {
    const store = usePhotoStore.getState();
    store.initAlbum('album-a');
    store.initAlbum('album-b');

    // Insert intents into both albums.
    store.promoteToStable('album-a', 'asset-a', {
      thumbnailUrl: 'data:image/jpeg;base64,abc',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    store.promoteToStable('album-b', 'asset-b', {
      thumbnailUrl: 'data:image/jpeg;base64,abc',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    // Manually expire both intents by rewriting expiresAt into the past.
    usePhotoStore.setState((state) => {
      for (const album of state.albums.values()) {
        for (const intent of album.latePromoteIntents.values()) {
          intent.expiresAt = Date.now() - LATE_PROMOTE_TTL_MS - 1;
        }
      }
    });

    // Sanity: still present before sweep.
    expect(
      usePhotoStore.getState().albums.get('album-a')?.latePromoteIntents.size,
    ).toBe(1);
    expect(
      usePhotoStore.getState().albums.get('album-b')?.latePromoteIntents.size,
    ).toBe(1);

    usePhotoStore.getState().pruneAllLatePromoteIntents();

    expect(
      usePhotoStore.getState().albums.get('album-a')?.latePromoteIntents.size,
    ).toBe(0);
    expect(
      usePhotoStore.getState().albums.get('album-b')?.latePromoteIntents.size,
    ).toBe(0);
  });

  it('markUploadFailed(permanent=true): sets failed_permanent status', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, 'asset-1', 'blob:fake');

    store.markUploadFailed(ALBUM_ID, 'asset-1', 'max retries', true);
    const item = usePhotoStore
      .getState()
      .albums.get(ALBUM_ID)
      ?.items.get('asset-1');
    expect(item?.status).toBe('failed_permanent');
    expect(item?.error).toBe('max retries');
  });

  it('pending-count selector ignores failed_permanent items (item 5 pending-count fix)', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, 'asset-ok', 'blob:fake1');
    store.addPending(ALBUM_ID, 'asset-bad', 'blob:fake2');

    // Mark one as permanent failure.
    store.markUploadFailed(ALBUM_ID, 'asset-bad', 'gone', true);

    // Mirror of usePendingCount's selector logic — verifies the
    // contract directly without a React renderer dependency.
    const album = usePhotoStore.getState().albums.get(ALBUM_ID);
    let count = 0;
    for (const item of album!.items.values()) {
      if (item.status === 'pending' || item.status === 'syncing') count++;
    }
    expect(count).toBe(1);
  });

  it('resetForRetry: moves failed_permanent back to pending and clears error', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, 'asset-1', 'blob:fake');
    store.markUploadFailed(ALBUM_ID, 'asset-1', 'boom', true);

    store.resetForRetry(ALBUM_ID, 'asset-1');
    const item = usePhotoStore
      .getState()
      .albums.get(ALBUM_ID)
      ?.items.get('asset-1');
    expect(item?.status).toBe('pending');
    expect(item?.error).toBeUndefined();
    expect(item?.uploadProgress).toBe(0);
  });

  it('removePending also clears failed_permanent items', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.addPending(ALBUM_ID, 'asset-1', 'blob:fake');
    store.markUploadFailed(ALBUM_ID, 'asset-1', 'boom', true);

    store.removePending(ALBUM_ID, 'asset-1');
    expect(
      usePhotoStore.getState().albums.get(ALBUM_ID)?.items.has('asset-1'),
    ).toBe(false);
  });
});
