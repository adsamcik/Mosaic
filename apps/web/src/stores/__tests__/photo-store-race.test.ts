/**
 * Regression tests for v1.0.x release blocker
 * `validation-final-gate-isolated-v3-04`: PhotoStore race where
 * `addPending` arrives AFTER `promoteToStable` for a fast-uploading
 * photo, producing an orphan pending entry that never clears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LATE_PROMOTE_TTL_MS, usePhotoStore } from '../photo-store';

const ALBUM_ID = 'album-1';
const ASSET_ID = 'asset-1';
const BLOB_URL = 'blob:fake/object-url';

beforeEach(() => {
  // Reset store between tests.
  usePhotoStore.setState((state) => {
    state.albums.clear();
    state.activeAlbumId = null;
  });

  if (!('revokeObjectURL' in URL)) {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL =
      () => undefined;
  }
});

describe('PhotoStore late-promote race (isolated-v3-04)', () => {
  it('reverse order: promoteToStable BEFORE addPending → ends as stable, not pending', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);

    // Sync engine promotion arrives first (no item yet).
    store.promoteToStable(ALBUM_ID, ASSET_ID, {
      thumbnailUrl: 'data:image/jpeg;base64,abc',
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    // Buffered as a late-promote intent.
    const albumAfterPromote = usePhotoStore
      .getState()
      .getAlbumState(ALBUM_ID);
    expect(albumAfterPromote?.latePromoteIntents.has(ASSET_ID)).toBe(true);
    expect(albumAfterPromote?.items.has(ASSET_ID)).toBe(false);

    // Now the delayed addPending lands.
    store.addPending(ALBUM_ID, ASSET_ID, BLOB_URL);

    const photo = usePhotoStore.getState().getPhoto(ALBUM_ID, ASSET_ID);
    expect(photo).toBeDefined();
    expect(photo?.status).toBe('stable');
    expect(photo?.thumbnailUrl).toBe('data:image/jpeg;base64,abc');
    expect(photo?.localBlobUrl).toBeUndefined();
    expect(photo?.uploadProgress).toBeUndefined();

    // Intent consumed.
    const albumAfterAdd = usePhotoStore.getState().getAlbumState(ALBUM_ID);
    expect(albumAfterAdd?.latePromoteIntents.has(ASSET_ID)).toBe(false);
  });

  it('normal order: addPending THEN promoteToStable still works', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);

    store.addPending(ALBUM_ID, ASSET_ID, BLOB_URL);

    const pending = usePhotoStore.getState().getPhoto(ALBUM_ID, ASSET_ID);
    expect(pending?.status).toBe('pending');
    expect(pending?.localBlobUrl).toBe(BLOB_URL);

    store.transitionToSyncing(ALBUM_ID, ASSET_ID);
    store.promoteToStable(ALBUM_ID, ASSET_ID, {
      thumbnailUrl: 'data:image/jpeg;base64,xyz',
      createdAt: new Date('2025-01-02T00:00:00Z'),
    });

    const stable = usePhotoStore.getState().getPhoto(ALBUM_ID, ASSET_ID);
    expect(stable?.status).toBe('stable');
    expect(stable?.thumbnailUrl).toBe('data:image/jpeg;base64,xyz');
    expect(stable?.localBlobUrl).toBeUndefined();

    const album = usePhotoStore.getState().getAlbumState(ALBUM_ID);
    expect(album?.latePromoteIntents.size).toBe(0);
  });

  it('stale intent (older than TTL) is discarded; addPending falls back to pending', () => {
    vi.useFakeTimers();
    try {
      const store = usePhotoStore.getState();
      store.initAlbum(ALBUM_ID);

      store.promoteToStable(ALBUM_ID, ASSET_ID, {
        thumbnailUrl: 'data:image/jpeg;base64,old',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      });

      // Advance past TTL.
      vi.advanceTimersByTime(LATE_PROMOTE_TTL_MS + 1_000);

      store.addPending(ALBUM_ID, ASSET_ID, BLOB_URL);

      const photo = usePhotoStore.getState().getPhoto(ALBUM_ID, ASSET_ID);
      expect(photo?.status).toBe('pending');
      expect(photo?.localBlobUrl).toBe(BLOB_URL);

      const album = usePhotoStore.getState().getAlbumState(ALBUM_ID);
      expect(album?.latePromoteIntents.has(ASSET_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('addPending is ignored when an item is already known stable (option c safety net)', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);

    // E.g., server fetch already added this asset as stable.
    store.addStableFromServer(
      ALBUM_ID,
      ASSET_ID,
      'data:image/jpeg;base64,server',
      new Date('2025-01-03T00:00:00Z'),
    );

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    store.addPending(ALBUM_ID, ASSET_ID, BLOB_URL);

    const photo = usePhotoStore.getState().getPhoto(ALBUM_ID, ASSET_ID);
    expect(photo?.status).toBe('stable');
    expect(photo?.thumbnailUrl).toBe('data:image/jpeg;base64,server');
    expect(photo?.localBlobUrl).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(BLOB_URL);
    revokeSpy.mockRestore();
  });

  it('purgeAlbum clears buffered late-promote intents', () => {
    const store = usePhotoStore.getState();
    store.initAlbum(ALBUM_ID);
    store.promoteToStable(ALBUM_ID, ASSET_ID, {
      thumbnailUrl: 'data:image/jpeg;base64,abc',
    });
    expect(
      usePhotoStore
        .getState()
        .getAlbumState(ALBUM_ID)
        ?.latePromoteIntents.size,
    ).toBe(1);

    store.purgeAlbum(ALBUM_ID);
    expect(usePhotoStore.getState().getAlbumState(ALBUM_ID)).toBeUndefined();
  });
});
