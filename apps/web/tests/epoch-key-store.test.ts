/**
 * Epoch Key Store Unit Tests
 *
 * Slice 3 — the cache stores opaque crypto-worker handle ids, not raw
 * epoch seeds or sign secrets. Tests assert handle-id round-trips and
 * `closeHandle` cascade calls; legacy `epochSeed` / `signKeypair` fields
 * remain on the type as zero-filled transitional placeholders during the
 * Slice 4-7 cutover but are not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAlbumKeys,
  clearAllEpochKeys,
  getCachedEpochIds,
  getCacheSize,
  getCurrentEpochKey,
  getEpochKey,
  hasEpochKey,
  setEpochKey,
} from '../src/lib/epoch-key-store';

const closeEpochHandleMock = vi.fn(async (_handleId: string) => undefined);

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(async () => ({
    closeEpochHandle: closeEpochHandleMock,
  })),
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function newBundle(overrides: {
  epochId: number;
  epochHandleId?: string;
  signPublicKey?: Uint8Array;
}) {
  return {
    epochId: overrides.epochId,
    epochHandleId:
      overrides.epochHandleId ?? `epch_test-${String(overrides.epochId)}`,
    signPublicKey: overrides.signPublicKey ?? new Uint8Array(32),
  };
}

describe('Epoch Key Store (handle-based)', () => {
  beforeEach(() => {
    clearAllEpochKeys();
    closeEpochHandleMock.mockClear();
  });

  afterEach(() => {
    clearAllEpochKeys();
  });

  describe('setEpochKey and getEpochKey', () => {
    it('stores and retrieves an epoch handle id', () => {
      const bundle = newBundle({ epochId: 1, epochHandleId: 'epch_one' });

      setEpochKey('album-1', bundle);
      const retrieved = getEpochKey('album-1', 1);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.epochId).toBe(1);
      expect(retrieved?.epochHandleId).toBe('epch_one');
      // The deprecated `epochSeed` placeholder must remain empty — the seed
      // never crosses the worker boundary in the Slice 3+ contract.
      expect(retrieved?.epochSeed.length).toBe(0);
      expect(retrieved?.signKeypair.secretKey.length).toBe(0);
    });

    it('returns null for non-existent album', () => {
      expect(getEpochKey('non-existent', 1)).toBeNull();
    });

    it('returns null for non-existent epoch', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      expect(getEpochKey('album-1', 999)).toBeNull();
    });

    it('replaces an existing entry and closes its prior handle', async () => {
      setEpochKey('album-1', newBundle({ epochId: 1, epochHandleId: 'epch_a' }));
      setEpochKey('album-1', newBundle({ epochId: 1, epochHandleId: 'epch_b' }));

      const retrieved = getEpochKey('album-1', 1);
      expect(retrieved?.epochHandleId).toBe('epch_b');

      // closeHandle is async — flush microtasks before asserting the call.
      await Promise.resolve();
      await Promise.resolve();
      expect(closeEpochHandleMock).toHaveBeenCalledWith('epch_a');
    });
  });

  describe('getCurrentEpochKey', () => {
    it('returns null for empty album', () => {
      expect(getCurrentEpochKey('empty-album')).toBeNull();
    });

    it('returns the only epoch handle', () => {
      setEpochKey('album-1', newBundle({ epochId: 5, epochHandleId: 'epch_5' }));
      const result = getCurrentEpochKey('album-1');

      expect(result).not.toBeNull();
      expect(result?.epochId).toBe(5);
      expect(result?.epochHandleId).toBe('epch_5');
    });

    it('returns the highest epoch id when multiple are cached', () => {
      for (const epochId of [1, 5, 3]) {
        setEpochKey('album-1', newBundle({ epochId, epochHandleId: `epch_${String(epochId)}` }));
      }

      const result = getCurrentEpochKey('album-1');
      expect(result?.epochId).toBe(5);
      expect(result?.epochHandleId).toBe('epch_5');
    });
  });

  describe('hasEpochKey', () => {
    it('returns false for non-existent album', () => {
      expect(hasEpochKey('none', 1)).toBe(false);
    });

    it('returns false for non-existent epoch', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      expect(hasEpochKey('album-1', 999)).toBe(false);
    });

    it('returns true for an existing epoch', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      expect(hasEpochKey('album-1', 1)).toBe(true);
    });
  });

  describe('getCachedEpochIds', () => {
    it('returns empty array for non-existent album', () => {
      expect(getCachedEpochIds('none')).toEqual([]);
    });

    it('returns all cached epoch ids', () => {
      for (const epochId of [1, 3, 5, 10]) {
        setEpochKey('album-1', newBundle({ epochId }));
      }
      const result = getCachedEpochIds('album-1');
      expect(result.sort((a, b) => a - b)).toEqual([1, 3, 5, 10]);
    });
  });

  describe('clearAlbumKeys', () => {
    it('clears keys for a specific album', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      setEpochKey('album-2', newBundle({ epochId: 1 }));

      clearAlbumKeys('album-1');

      expect(getEpochKey('album-1', 1)).toBeNull();
      expect(getEpochKey('album-2', 1)).not.toBeNull();
    });

    it('closes every cached handle on the way out', async () => {
      setEpochKey(
        'album-1',
        newBundle({ epochId: 1, epochHandleId: 'epch_a' }),
      );
      setEpochKey(
        'album-1',
        newBundle({ epochId: 2, epochHandleId: 'epch_b' }),
      );

      clearAlbumKeys('album-1');

      // Flush async closeHandle microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(closeEpochHandleMock).toHaveBeenCalledWith('epch_a');
      expect(closeEpochHandleMock).toHaveBeenCalledWith('epch_b');
    });

    it('handles clearing non-existent album gracefully', () => {
      expect(() => clearAlbumKeys('non-existent')).not.toThrow();
    });
  });

  describe('clearAllEpochKeys', () => {
    it('clears all albums', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      setEpochKey('album-2', newBundle({ epochId: 2 }));

      clearAllEpochKeys();

      expect(getCacheSize()).toBe(0);
      expect(getEpochKey('album-1', 1)).toBeNull();
      expect(getEpochKey('album-2', 2)).toBeNull();
    });

    it('closes every cached handle across all albums', async () => {
      setEpochKey(
        'album-1',
        newBundle({ epochId: 1, epochHandleId: 'epch_a' }),
      );
      setEpochKey(
        'album-2',
        newBundle({ epochId: 1, epochHandleId: 'epch_b' }),
      );

      clearAllEpochKeys();

      await Promise.resolve();
      await Promise.resolve();
      expect(closeEpochHandleMock).toHaveBeenCalledWith('epch_a');
      expect(closeEpochHandleMock).toHaveBeenCalledWith('epch_b');
    });
  });

  describe('getCacheSize', () => {
    it('returns 0 for empty cache', () => {
      expect(getCacheSize()).toBe(0);
    });

    it('counts all keys across albums', () => {
      setEpochKey('album-1', newBundle({ epochId: 1 }));
      setEpochKey('album-1', newBundle({ epochId: 2 }));
      setEpochKey('album-2', newBundle({ epochId: 1 }));
      expect(getCacheSize()).toBe(3);
    });
  });
});
