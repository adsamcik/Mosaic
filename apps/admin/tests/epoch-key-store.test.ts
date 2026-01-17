/**
 * Epoch Key Store Unit Tests
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAlbumKeys,
  clearAllEpochKeys,
  getCachedEpochIds,
  getCacheSize,
  getCurrentEpochKey,
  getEpochKey,
  hasEpochKey,
  setEpochKey,
  type EpochKeyBundle,
} from '../src/lib/epoch-key-store';

describe('Epoch Key Store', () => {
  // Clear cache before each test
  beforeEach(() => {
    clearAllEpochKeys();
  });

  describe('setEpochKey and getEpochKey', () => {
    it('stores and retrieves an epoch key', () => {
      const bundle: EpochKeyBundle = {
        epochId: 1,
        epochSeed: new Uint8Array([1, 2, 3, 4, 5]),
        signKeypair: {
          publicKey: new Uint8Array([10, 11, 12]),
          secretKey: new Uint8Array([20, 21, 22]),
        },
      };

      setEpochKey('album-1', bundle);
      const retrieved = getEpochKey('album-1', 1);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.epochId).toBe(1);
      expect(retrieved?.epochSeed).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('returns null for non-existent album', () => {
      const result = getEpochKey('non-existent', 1);
      expect(result).toBeNull();
    });

    it('returns null for non-existent epoch', () => {
      const bundle: EpochKeyBundle = {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      };

      setEpochKey('album-1', bundle);
      const result = getEpochKey('album-1', 999);
      expect(result).toBeNull();
    });

    it('overwrites existing epoch key', () => {
      const bundle1: EpochKeyBundle = {
        epochId: 1,
        epochSeed: new Uint8Array([1, 1, 1]),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      };

      const bundle2: EpochKeyBundle = {
        epochId: 1,
        epochSeed: new Uint8Array([2, 2, 2]),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      };

      setEpochKey('album-1', bundle1);
      setEpochKey('album-1', bundle2);

      const retrieved = getEpochKey('album-1', 1);
      expect(retrieved?.epochSeed).toEqual(new Uint8Array([2, 2, 2]));
    });
  });

  describe('getCurrentEpochKey', () => {
    it('returns null for empty album', () => {
      const result = getCurrentEpochKey('empty-album');
      expect(result).toBeNull();
    });

    it('returns the only epoch key', () => {
      const bundle: EpochKeyBundle = {
        epochId: 5,
        epochSeed: new Uint8Array([5, 5, 5]),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      };

      setEpochKey('album-1', bundle);
      const result = getCurrentEpochKey('album-1');

      expect(result).not.toBeNull();
      expect(result?.epochId).toBe(5);
    });

    it('returns highest epoch id when multiple epochs exist', () => {
      const bundles: EpochKeyBundle[] = [
        {
          epochId: 1,
          epochSeed: new Uint8Array([1]),
          signKeypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(64),
          },
        },
        {
          epochId: 5,
          epochSeed: new Uint8Array([5]),
          signKeypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(64),
          },
        },
        {
          epochId: 3,
          epochSeed: new Uint8Array([3]),
          signKeypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(64),
          },
        },
      ];

      bundles.forEach((b) => setEpochKey('album-1', b));
      const result = getCurrentEpochKey('album-1');

      expect(result?.epochId).toBe(5);
      expect(result?.epochSeed).toEqual(new Uint8Array([5]));
    });
  });

  describe('hasEpochKey', () => {
    it('returns false for non-existent album', () => {
      expect(hasEpochKey('none', 1)).toBe(false);
    });

    it('returns false for non-existent epoch', () => {
      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      expect(hasEpochKey('album-1', 999)).toBe(false);
    });

    it('returns true for existing epoch', () => {
      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      expect(hasEpochKey('album-1', 1)).toBe(true);
    });
  });

  describe('getCachedEpochIds', () => {
    it('returns empty array for non-existent album', () => {
      expect(getCachedEpochIds('none')).toEqual([]);
    });

    it('returns all cached epoch ids', () => {
      const epochs = [1, 3, 5, 10];
      epochs.forEach((epochId) => {
        setEpochKey('album-1', {
          epochId,
          epochSeed: new Uint8Array(32),
          signKeypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(64),
          },
        });
      });

      const result = getCachedEpochIds('album-1');
      expect(result.sort((a, b) => a - b)).toEqual([1, 3, 5, 10]);
    });
  });

  describe('clearAlbumKeys', () => {
    it('clears keys for a specific album', () => {
      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-2', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      clearAlbumKeys('album-1');

      expect(getEpochKey('album-1', 1)).toBeNull();
      expect(getEpochKey('album-2', 1)).not.toBeNull();
    });

    it('wipes key material before clearing', () => {
      const epochSeed = new Uint8Array([1, 2, 3, 4, 5]);
      const secretKey = new Uint8Array([10, 11, 12]);

      setEpochKey('album-1', {
        epochId: 1,
        epochSeed,
        signKeypair: { publicKey: new Uint8Array(32), secretKey },
      });

      clearAlbumKeys('album-1');

      // Key material should be zeroed
      expect(epochSeed).toEqual(new Uint8Array(5));
      expect(secretKey).toEqual(new Uint8Array(3));
    });

    it('handles clearing non-existent album gracefully', () => {
      expect(() => clearAlbumKeys('non-existent')).not.toThrow();
    });
  });

  describe('clearAllEpochKeys', () => {
    it('clears all albums', () => {
      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-2', {
        epochId: 2,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      clearAllEpochKeys();

      expect(getCacheSize()).toBe(0);
      expect(getEpochKey('album-1', 1)).toBeNull();
      expect(getEpochKey('album-2', 2)).toBeNull();
    });

    it('wipes all key material before clearing', () => {
      const epochSeed1 = new Uint8Array([1, 2, 3]);
      const epochSeed2 = new Uint8Array([4, 5, 6]);

      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: epochSeed1,
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-2', {
        epochId: 1,
        epochSeed: epochSeed2,
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      clearAllEpochKeys();

      expect(epochSeed1).toEqual(new Uint8Array(3));
      expect(epochSeed2).toEqual(new Uint8Array(3));
    });
  });

  describe('getCacheSize', () => {
    it('returns 0 for empty cache', () => {
      expect(getCacheSize()).toBe(0);
    });

    it('counts all keys across albums', () => {
      setEpochKey('album-1', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-1', {
        epochId: 2,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });
      setEpochKey('album-2', {
        epochId: 1,
        epochSeed: new Uint8Array(32),
        signKeypair: {
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(64),
        },
      });

      expect(getCacheSize()).toBe(3);
    });
  });
});
