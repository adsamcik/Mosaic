/**
 * Key Cache Tests
 *
 * Tests for the secure key caching functionality that enables
 * session restoration without requiring password re-entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cacheKeys,
  getCachedKeys,
  clearCachedKeys,
  clearCacheEncryptionKey,
  hasCachedKeys,
  isKeyCachingEnabled,
  type CachedKeys,
} from '../src/lib/key-cache';
import * as settingsService from '../src/lib/settings-service';

// Mock settings service
vi.mock('../src/lib/settings-service', () => ({
  getKeyCacheDurationMs: vi.fn(),
}));

// Sample test keys (v2 schema: opaque session-state blob + salts)
const mockKeys: CachedKeys = {
  sessionState: btoa('opaque-session-state-blob-bytes-test-data!!!!!!'),
  userSalt: btoa('user-salt-16-byt'),
  accountSalt: btoa('acct-salt-16-byt'),
  version: 2,
};

describe('key-cache', () => {
  beforeEach(() => {
    // Clear session storage before each test
    sessionStorage.clear();
    // Reset the cache encryption key
    clearCacheEncryptionKey();
    // Default to enabled with 30 minute duration
    vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(
      30 * 60 * 1000,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isKeyCachingEnabled', () => {
    it('returns true when duration is positive', () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(1800000); // 30 min
      expect(isKeyCachingEnabled()).toBe(true);
    });

    it('returns false when duration is 0', () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(0);
      expect(isKeyCachingEnabled()).toBe(false);
    });

    it('returns true when duration is Infinity (until tab close)', () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(
        Infinity,
      );
      expect(isKeyCachingEnabled()).toBe(true);
    });
  });

  describe('schema versioning (v1 → v2 cutover)', () => {
    it('refuses to cache payloads with non-v2 version', async () => {
      const v1Like = {
        sessionState: 'unused',
        userSalt: 'unused',
        accountSalt: 'unused',
        version: 1,
      } as unknown as CachedKeys;

      await cacheKeys(v1Like);

      // Nothing was written.
      expect(sessionStorage.getItem('mosaic:keyCache')).toBeNull();
    });

    it('discards a stored v1 cache (legacy raw-bytes shape) on read', async () => {
      // First, prime the in-memory encryption key and an envelope by
      // writing a valid v2 cache.
      await cacheKeys(mockKeys);
      const validEnvelope = sessionStorage.getItem('mosaic:keyCache');
      expect(validEnvelope).not.toBeNull();

      // Replace the stored ciphertext with one whose plaintext is a v1
      // payload. We simulate this by mutating the envelope's ciphertext
      // through a separate path: encrypt a v1 plaintext under the same
      // in-memory key by going via `crypto.subtle.encrypt` directly.
      // For simplicity we just stub `crypto.subtle.decrypt` to return a
      // v1 plaintext.
      const v1Plaintext = new TextEncoder().encode(
        JSON.stringify({
          accountKey: 'aGVsbG8=',
          sessionKey: 'aGVsbG8=',
          identitySecretKey: 'aGVsbG8=',
          identityPublicKey: 'aGVsbG8=',
          identityX25519SecretKey: 'aGVsbG8=',
          identityX25519PublicKey: 'aGVsbG8=',
          userSalt: 'aGVsbG8=',
          accountSalt: 'aGVsbG8=',
        }),
      );
      const decryptSpy = vi
        .spyOn(crypto.subtle, 'decrypt')
        .mockResolvedValueOnce(v1Plaintext.buffer);
      try {
        const result = await getCachedKeys();
        expect(result).toBeNull();
      } finally {
        decryptSpy.mockRestore();
      }

      // The v1 entry was cleared.
      expect(sessionStorage.getItem('mosaic:keyCache')).toBeNull();
    });
  });

  describe('cacheKeys', () => {
    it('stores encrypted keys in sessionStorage', async () => {
      await cacheKeys(mockKeys);

      const stored = sessionStorage.getItem('mosaic:keyCache');
      expect(stored).not.toBeNull();

      const envelope = JSON.parse(stored!);
      expect(envelope).toHaveProperty('ciphertext');
      expect(envelope).toHaveProperty('nonce');
      expect(envelope).toHaveProperty('expiresAt');
    });

    it('does not persist the raw cache encryption key alongside ciphertext', async () => {
      await cacheKeys(mockKeys);

      expect(sessionStorage.getItem('mosaic:cacheKey')).toBeNull();
    });

    it('does not store keys when caching is disabled', async () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(0);

      await cacheKeys(mockKeys);

      expect(sessionStorage.getItem('mosaic:keyCache')).toBeNull();
    });

    it('sets expiration timestamp when duration is finite', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await cacheKeys(mockKeys);

      const stored = sessionStorage.getItem('mosaic:keyCache');
      const envelope = JSON.parse(stored!);
      expect(envelope.expiresAt).toBe(now + 30 * 60 * 1000);

      vi.restoreAllMocks();
    });

    it('sets expiresAt to 0 when duration is Infinity', async () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(
        Infinity,
      );

      await cacheKeys(mockKeys);

      const stored = sessionStorage.getItem('mosaic:keyCache');
      const envelope = JSON.parse(stored!);
      expect(envelope.expiresAt).toBe(0);
    });
  });

  describe('getCachedKeys', () => {
    it('returns cached keys after cacheKeys', async () => {
      await cacheKeys(mockKeys);

      const retrieved = await getCachedKeys();

      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionState).toBe(mockKeys.sessionState);
      expect(retrieved!.userSalt).toBe(mockKeys.userSalt);
      expect(retrieved!.accountSalt).toBe(mockKeys.accountSalt);
      expect(retrieved!.version).toBe(2);
    });

    it('returns null when cache is empty', async () => {
      const result = await getCachedKeys();
      expect(result).toBeNull();
    });

    it('returns null when caching is disabled', async () => {
      await cacheKeys(mockKeys);
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(0);

      const result = await getCachedKeys();
      expect(result).toBeNull();
    });

    it('returns null when cache encryption key is not in memory', async () => {
      await cacheKeys(mockKeys);
      // Clear the encryption key from memory
      clearCacheEncryptionKey();

      const result = await getCachedKeys();
      expect(result).toBeNull();
    });

    it('returns null when cache is expired', async () => {
      // Set time to "now"
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await cacheKeys(mockKeys);

      // Fast forward past expiration
      vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);

      const result = await getCachedKeys();
      expect(result).toBeNull();

      vi.restoreAllMocks();
    });

    it('returns keys when expiresAt is 0 (no expiry)', async () => {
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(
        Infinity,
      );

      await cacheKeys(mockKeys);

      // Fast forward to some future time
      const originalNow = Date.now;
      Date.now = () => originalNow() + 24 * 60 * 60 * 1000; // 24 hours later

      const result = await getCachedKeys();
      expect(result).not.toBeNull();
      expect(result!.sessionState).toBe(mockKeys.sessionState);

      Date.now = originalNow;
    });

    it('zeroes the decrypted plaintext buffer after parsing', async () => {
      await cacheKeys(mockKeys);

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(mockKeys));
      const decryptSpy = vi
        .spyOn(crypto.subtle, 'decrypt')
        .mockResolvedValueOnce(plaintextBytes.buffer);

      try {
        const result = await getCachedKeys();

        expect(result).not.toBeNull();
        expect(result!.sessionState).toBe(mockKeys.sessionState);
        expect(Array.from(plaintextBytes).every((byte) => byte === 0)).toBe(
          true,
        );
      } finally {
        decryptSpy.mockRestore();
      }
    });
  });

  describe('clearCachedKeys', () => {
    it('removes keys from sessionStorage', async () => {
      await cacheKeys(mockKeys);
      expect(sessionStorage.getItem('mosaic:keyCache')).not.toBeNull();

      clearCachedKeys();

      expect(sessionStorage.getItem('mosaic:keyCache')).toBeNull();
    });
  });

  describe('clearCacheEncryptionKey', () => {
    it('clears both encryption key and cached keys', async () => {
      await cacheKeys(mockKeys);
      expect(sessionStorage.getItem('mosaic:keyCache')).not.toBeNull();

      clearCacheEncryptionKey();

      // Storage is cleared
      expect(sessionStorage.getItem('mosaic:keyCache')).toBeNull();
      // And we can't retrieve keys anymore
      // Need to re-mock since we just cleared
      vi.mocked(settingsService.getKeyCacheDurationMs).mockReturnValue(
        30 * 60 * 1000,
      );
      const result = await getCachedKeys();
      expect(result).toBeNull();
    });
  });

  describe('hasCachedKeys', () => {
    it('returns false when no cache exists', () => {
      expect(hasCachedKeys()).toBe(false);
    });

    it('returns true when valid cache exists', async () => {
      await cacheKeys(mockKeys);
      expect(hasCachedKeys()).toBe(true);
    });

    it('returns false when cache is expired', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await cacheKeys(mockKeys);

      // Fast forward past expiration
      vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);

      expect(hasCachedKeys()).toBe(false);

      vi.restoreAllMocks();
    });

    it('returns false when encryption key is not in memory', async () => {
      await cacheKeys(mockKeys);
      clearCacheEncryptionKey();

      expect(hasCachedKeys()).toBe(false);
    });
  });

  describe('security properties', () => {
    it('encrypted keys are not readable without decryption', async () => {
      await cacheKeys(mockKeys);

      const stored = sessionStorage.getItem('mosaic:keyCache');
      const envelope = JSON.parse(stored!);

      // The ciphertext should not contain the plain session-state bytes
      const ciphertextDecoded = atob(envelope.ciphertext);
      expect(ciphertextDecoded).not.toContain('opaque-session-state-blob');
      expect(ciphertextDecoded).not.toContain('user-salt-16-byt');
    });

    it('each cache operation generates a unique nonce', async () => {
      await cacheKeys(mockKeys);
      const stored1 = JSON.parse(sessionStorage.getItem('mosaic:keyCache')!);

      await cacheKeys(mockKeys);
      const stored2 = JSON.parse(sessionStorage.getItem('mosaic:keyCache')!);

      expect(stored1.nonce).not.toBe(stored2.nonce);
    });
  });

  describe('session restore (page reload simulation)', () => {
    // Helper to simulate clearing in-memory state without clearing sessionStorage
    const simulatePageReload = async () => {
      // Access the module and reset its internal state
      // We need to re-import to get a fresh module instance
      vi.resetModules();
      vi.mock('../src/lib/settings-service', () => ({
        getKeyCacheDurationMs: vi.fn().mockReturnValue(30 * 60 * 1000),
      }));
      const freshModule = await import('../src/lib/key-cache');
      return freshModule;
    };

    it('invalidates restore after simulated page reload', async () => {
      await cacheKeys(mockKeys);

      expect(sessionStorage.getItem('mosaic:keyCache')).not.toBeNull();
      expect(sessionStorage.getItem('mosaic:cacheKey')).toBeNull();

      const freshModule = await simulatePageReload();

      expect(freshModule.hasCachedKeys()).toBe(false);

      const retrieved = await freshModule.getCachedKeys();
      expect(retrieved).toBeNull();
    });

    it('hasCachedKeys returns false when only ciphertext survives reload', async () => {
      await cacheKeys(mockKeys);

      const freshModule = await simulatePageReload();

      expect(freshModule.hasCachedKeys()).toBe(false);
    });
  });
});
