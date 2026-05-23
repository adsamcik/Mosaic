/**
 * v1.0.2 storage/eviction hardening — regression tests for
 * `epoch-key-store.invalidateAlbum` (Item 4 / v102-s34).
 *
 * Confirms that:
 *  - invalidateAlbum drops every cached epoch handle for the album
 *  - other albums' caches are untouched
 *  - the invalidation hook is idempotent (safe to call on an
 *    album with no cached keys)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochHandleId } from '../../workers/types';

const closeEpochHandle = vi.fn(async () => undefined);

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      closeEpochHandle,
    }),
  ),
}));

describe('epoch-key-store — invalidateAlbum (v102-s34)', () => {
  beforeEach(() => {
    vi.resetModules();
    closeEpochHandle.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBundle(epochId: number, handleId: string) {
    return {
      epochId,
      epochHandleId: handleId as EpochHandleId,
      signPublicKey: new Uint8Array(32),
    };
  }

  it('drops every cached handle for the targeted album and leaves other albums intact', async () => {
    const mod = await import('../epoch-key-store');

    mod.setEpochKey('album-a', makeBundle(1, 'h-a1'));
    mod.setEpochKey('album-a', makeBundle(2, 'h-a2'));
    mod.setEpochKey('album-b', makeBundle(1, 'h-b1'));

    expect(mod.getCacheSize()).toBe(3);

    mod.invalidateAlbum('album-a');

    expect(mod.getEpochKey('album-a', 1)).toBeNull();
    expect(mod.getEpochKey('album-a', 2)).toBeNull();
    expect(mod.getCachedEpochIds('album-a')).toEqual([]);
    // album-b must be preserved — invalidation is per-album.
    expect(mod.getEpochKey('album-b', 1)).not.toBeNull();
    expect(mod.getCacheSize()).toBe(1);
  });

  it('is idempotent when the album has no cached handles', async () => {
    const mod = await import('../epoch-key-store');
    expect(() => mod.invalidateAlbum('never-cached')).not.toThrow();
    expect(mod.getCacheSize()).toBe(0);
  });

  it('asks the crypto worker to close every handle that was dropped', async () => {
    const mod = await import('../epoch-key-store');
    mod.setEpochKey('album-c', makeBundle(1, 'h-c1'));
    mod.setEpochKey('album-c', makeBundle(2, 'h-c2'));

    mod.invalidateAlbum('album-c');

    // closeEpochHandle is invoked async; wait a microtask tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(closeEpochHandle).toHaveBeenCalledWith('h-c1');
    expect(closeEpochHandle).toHaveBeenCalledWith('h-c2');
  });
});
