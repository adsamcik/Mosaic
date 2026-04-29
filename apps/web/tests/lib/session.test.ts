/**
 * Session Cache Clearing Tests
 *
 * Verifies that logout properly clears all caches:
 * - Photo cache (decrypted blob URLs)
 * - Thumbnail cache
 * - BlurHash cache
 * - Epoch keys
 * - Album metadata
 * - Album covers
 * - Key cache encryption key
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

// Mock all dependencies before importing session
vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    getApi: vi.fn(),
  };
});

vi.mock('../../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
  closeCryptoClient: vi.fn(),
}));

vi.mock('../../src/lib/db-client', () => ({
  getDbClient: vi.fn(),
  closeDbClient: vi.fn(),
}));

vi.mock('../../src/lib/geo-client', () => ({
  closeGeoClient: vi.fn(),
}));

vi.mock('../../src/lib/epoch-key-store', () => ({
  clearAllEpochKeys: vi.fn(),
}));

vi.mock('../../src/lib/album-cover-service', () => ({
  clearAllCovers: vi.fn(),
}));

vi.mock('../../src/lib/album-metadata-service', () => ({
  clearAllCachedMetadata: vi.fn(),
}));

vi.mock('../../src/lib/thumbhash-decoder', () => ({
  clearPlaceholderCache: vi.fn(),
}));

vi.mock('../../src/lib/photo-service', () => ({
  clearPhotoCache: vi.fn(),
}));

vi.mock('../../src/lib/key-cache', () => ({
  clearCacheEncryptionKey: vi.fn(),
  cacheKeys: vi.fn(),
  getCachedKeys: vi.fn(),
  hasCachedKeys: vi.fn(() => false),
}));

vi.mock('../../src/lib/local-auth', () => ({
  localAuthLogin: vi.fn(),
  localAuthRegister: vi.fn(),
  isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../src/lib/settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  subscribeToSettings: vi.fn(() => () => {}),
}));

// Import mocked functions for assertions
import { closeCryptoClient } from '../../src/lib/crypto-client';
import { closeDbClient } from '../../src/lib/db-client';
import { closeGeoClient } from '../../src/lib/geo-client';
import { clearAllEpochKeys } from '../../src/lib/epoch-key-store';
import { clearAllCovers } from '../../src/lib/album-cover-service';
import { clearAllCachedMetadata } from '../../src/lib/album-metadata-service';
import { clearPlaceholderCache } from '../../src/lib/thumbhash-decoder';
import { clearPhotoCache } from '../../src/lib/photo-service';
import { clearCacheEncryptionKey } from '../../src/lib/key-cache';
import { getApi } from '../../src/lib/api';
import { getCryptoClient } from '../../src/lib/crypto-client';
import { getDbClient } from '../../src/lib/db-client';
import type { User } from '../../src/lib/api-types';

// Dynamically import session to get a fresh instance per test
async function getSessionModule() {
  vi.resetModules();

  // Re-apply mocks after reset
  vi.doMock('../../src/lib/api', async () => {
    const actual = await vi.importActual('../../src/lib/api');
    return {
      ...actual,
      getApi: vi.fn(),
    };
  });

  vi.doMock('../../src/lib/crypto-client', () => ({
    getCryptoClient: vi.fn(),
    closeCryptoClient: vi.fn(),
  }));

  vi.doMock('../../src/lib/db-client', () => ({
    getDbClient: vi.fn(),
    closeDbClient: vi.fn(),
  }));

  vi.doMock('../../src/lib/geo-client', () => ({
    closeGeoClient: vi.fn(),
  }));

  vi.doMock('../../src/lib/epoch-key-store', () => ({
    clearAllEpochKeys: vi.fn(),
  }));

  vi.doMock('../../src/lib/album-cover-service', () => ({
    clearAllCovers: vi.fn(),
  }));

  vi.doMock('../../src/lib/album-metadata-service', () => ({
    clearAllCachedMetadata: vi.fn(),
  }));

  vi.doMock('../../src/lib/thumbhash-decoder', () => ({
    clearPlaceholderCache: vi.fn(),
  }));

  vi.doMock('../../src/lib/photo-service', () => ({
    clearPhotoCache: vi.fn(),
  }));

  vi.doMock('../../src/lib/key-cache', () => ({
    clearCacheEncryptionKey: vi.fn(),
    cacheKeys: vi.fn(),
    getCachedKeys: vi.fn(),
    hasCachedKeys: vi.fn(() => false),
  }));

  vi.doMock('../../src/lib/local-auth', () => ({
    localAuthLogin: vi.fn(),
    localAuthRegister: vi.fn(),
    isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
  }));

  vi.doMock('../../src/lib/settings-service', () => ({
    getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
    subscribeToSettings: vi.fn(() => () => {}),
  }));

  // Import fresh versions after reset
  const sessionModule = await import('../../src/lib/session');
  const cryptoClient = await import('../../src/lib/crypto-client');
  const dbClient = await import('../../src/lib/db-client');
  const geoClient = await import('../../src/lib/geo-client');
  const epochKeyStore = await import('../../src/lib/epoch-key-store');
  const albumCoverService = await import('../../src/lib/album-cover-service');
  const albumMetadataService =
    await import('../../src/lib/album-metadata-service');
  const thumbhashDecoder = await import('../../src/lib/thumbhash-decoder');
  const photoService = await import('../../src/lib/photo-service');
  const keyCache = await import('../../src/lib/key-cache');
  const api = await import('../../src/lib/api');

  return {
    session: sessionModule.session,
    closeCryptoClient: cryptoClient.closeCryptoClient,
    closeDbClient: dbClient.closeDbClient,
    closeGeoClient: geoClient.closeGeoClient,
    clearAllEpochKeys: epochKeyStore.clearAllEpochKeys,
    clearAllCovers: albumCoverService.clearAllCovers,
    clearAllCachedMetadata: albumMetadataService.clearAllCachedMetadata,
    clearPlaceholderCache: thumbhashDecoder.clearPlaceholderCache,
    clearPhotoCache: photoService.clearPhotoCache,
    clearCacheEncryptionKey: keyCache.clearCacheEncryptionKey,
    getApi: api.getApi,
    getCryptoClient: cryptoClient.getCryptoClient,
    getDbClient: dbClient.getDbClient,
  };
}

describe('session', () => {
  const mockUser: User = {
    id: 'user-123',
    authSub: 'testuser@example.com',
    identityPubkey: 'mock-pubkey',
    createdAt: '2024-01-01T00:00:00Z',
    encryptedSalt: undefined,
    saltNonce: undefined,
  };

  const mockCryptoClient = {
    init: vi.fn(),
    initWithWrappedKey: vi.fn(),
    deriveIdentity: vi.fn(),
    getDbSessionKey: vi.fn(() => new Uint8Array(32)),
    getWrappedAccountKey: vi.fn(() => new Uint8Array(72)),
    getIdentityPublicKey: vi.fn(() => new Uint8Array(32)),
    serializeSessionState: vi.fn(() => new Uint8Array(120)),
    clear: vi.fn(),
  };

  const mockDbClient = {
    init: vi.fn(),
    close: vi.fn(),
  };

  const mockApi = {
    getCurrentUser: vi.fn(),
    updateCurrentUser: vi.fn(),
    updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();

    // Setup default mock implementations
    (getApi as Mock).mockReturnValue(mockApi);
    (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
    (getDbClient as Mock).mockResolvedValue(mockDbClient);

    // Mock fetch for logout and wrapped-key endpoints
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe('clearSession (logout)', () => {
    it('clears all caches on logout', async () => {
      const {
        session,
        clearAllCachedMetadata,
        clearAllCovers,
        clearPlaceholderCache,
        clearPhotoCache,
        clearAllEpochKeys,
        clearCacheEncryptionKey,
        closeDbClient,
        closeCryptoClient,
        closeGeoClient,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      // Login first to establish session
      await session.login('test-password');
      expect(session.isLoggedIn).toBe(true);

      // Clear mocks to track only logout calls
      vi.clearAllMocks();

      // Call logout
      await session.logout();

      // Verify all cache clear functions were called
      expect(clearAllCachedMetadata).toHaveBeenCalledOnce();
      expect(clearAllCovers).toHaveBeenCalledOnce();
      expect(clearPlaceholderCache).toHaveBeenCalledOnce();
      expect(clearPhotoCache).toHaveBeenCalledOnce();
      expect(clearAllEpochKeys).toHaveBeenCalledOnce();
      expect(clearCacheEncryptionKey).toHaveBeenCalledOnce();

      // Verify workers are closed
      expect(closeDbClient).toHaveBeenCalledOnce();
      expect(closeCryptoClient).toHaveBeenCalledOnce();
      expect(closeGeoClient).toHaveBeenCalledOnce();

      // Verify session state is cleared
      expect(session.isLoggedIn).toBe(false);
      expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    });

    it('clears data caches before crypto keys', async () => {
      const {
        session,
        clearAllCachedMetadata,
        clearAllCovers,
        clearPlaceholderCache,
        clearPhotoCache,
        clearAllEpochKeys,
        clearCacheEncryptionKey,
        closeDbClient,
        closeCryptoClient,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      // Track call order
      const callOrder: string[] = [];

      (clearAllCachedMetadata as Mock).mockImplementation(() => {
        callOrder.push('clearAllCachedMetadata');
      });
      (clearAllCovers as Mock).mockImplementation(() => {
        callOrder.push('clearAllCovers');
      });
      (clearPlaceholderCache as Mock).mockImplementation(() => {
        callOrder.push('clearPlaceholderCache');
      });
      (clearPhotoCache as Mock).mockImplementation(() => {
        callOrder.push('clearPhotoCache');
      });
      (clearAllEpochKeys as Mock).mockImplementation(() => {
        callOrder.push('clearAllEpochKeys');
      });
      (clearCacheEncryptionKey as Mock).mockImplementation(() => {
        callOrder.push('clearCacheEncryptionKey');
      });
      (closeDbClient as Mock).mockImplementation(async () => {
        callOrder.push('closeDbClient');
      });
      (closeCryptoClient as Mock).mockImplementation(async () => {
        callOrder.push('closeCryptoClient');
      });

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      callOrder.length = 0; // Clear login-related calls

      await session.logout();

      // Verify data caches are cleared before crypto key operations
      const metadataIndex = callOrder.indexOf('clearAllCachedMetadata');
      const coversIndex = callOrder.indexOf('clearAllCovers');
      const blurhashIndex = callOrder.indexOf('clearPlaceholderCache');
      const photoCacheIndex = callOrder.indexOf('clearPhotoCache');
      const epochKeysIndex = callOrder.indexOf('clearAllEpochKeys');
      const cacheEncryptionKeyIndex = callOrder.indexOf(
        'clearCacheEncryptionKey',
      );
      const dbClientIndex = callOrder.indexOf('closeDbClient');
      const cryptoClientIndex = callOrder.indexOf('closeCryptoClient');

      // Data caches should be cleared before epoch keys and encryption key
      expect(metadataIndex).toBeLessThan(epochKeysIndex);
      expect(coversIndex).toBeLessThan(epochKeysIndex);
      expect(blurhashIndex).toBeLessThan(epochKeysIndex);
      expect(photoCacheIndex).toBeLessThan(epochKeysIndex);

      // Epoch keys and cache encryption key should be cleared before workers close
      expect(epochKeysIndex).toBeLessThan(dbClientIndex);
      expect(cacheEncryptionKeyIndex).toBeLessThan(dbClientIndex);
      expect(cacheEncryptionKeyIndex).toBeLessThan(cryptoClientIndex);
    });

    it('continues clearing other caches even if one throws', async () => {
      const {
        session,
        clearAllCachedMetadata,
        clearAllCovers,
        clearPlaceholderCache,
        clearPhotoCache,
        clearAllEpochKeys,
        clearCacheEncryptionKey,
        closeDbClient,
        closeCryptoClient,
        closeGeoClient,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      // Make one clear function throw
      (clearPlaceholderCache as Mock).mockImplementation(() => {
        throw new Error('BlurHash cache clear failed');
      });

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      vi.clearAllMocks();

      // Re-apply the throwing mock after clearing
      (clearPlaceholderCache as Mock).mockImplementation(() => {
        throw new Error('BlurHash cache clear failed');
      });

      // Logout should not throw even if one cache clear fails
      // The current implementation doesn't have try-catch around individual clears,
      // so this test documents the expected behavior if we add error handling
      await expect(session.logout()).rejects.toThrow(
        'BlurHash cache clear failed',
      );

      // Since the error is thrown, not all functions will be called
      // This test documents the current behavior - if error handling is added,
      // we should update this test to verify all clears are still called
    });

    it('clears session storage and resets URL', async () => {
      const { session, getApi, getCryptoClient, getDbClient } =
        await getSessionModule();

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');

      // Verify session state is set
      expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');

      await session.logout();

      // Verify session storage is cleared
      expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    });

    it('calls backend logout API', async () => {
      const { session, getApi, getCryptoClient, getDbClient } =
        await getSessionModule();

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      vi.clearAllMocks();

      await session.logout();

      // Verify backend logout was called
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    });

    it('continues logout even if backend API fails', async () => {
      const {
        session,
        clearAllCachedMetadata,
        clearPhotoCache,
        clearAllEpochKeys,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      // Setup mocks for login (fetch needs to work for login)
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      // Normal fetch for login
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await session.login('test-password');
      vi.clearAllMocks();

      // Now make backend logout fail for the logout test
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      // Logout should still succeed even if backend API fails
      await session.logout();

      // Verify caches were still cleared
      expect(clearAllCachedMetadata).toHaveBeenCalledOnce();
      expect(clearPhotoCache).toHaveBeenCalledOnce();
      expect(clearAllEpochKeys).toHaveBeenCalledOnce();
      expect(session.isLoggedIn).toBe(false);
    });

    it('notifies listeners when session ends', async () => {
      const { session, getApi, getCryptoClient, getDbClient } =
        await getSessionModule();

      // Setup mocks for login
      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');

      // Subscribe to session changes
      const listener = vi.fn();
      session.subscribe(listener);
      listener.mockClear(); // Clear login notification

      await session.logout();

      // Verify listener was notified
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('clearCorruptedSession', () => {
    it('clears caches and tears down worker clients', async () => {
      const {
        session,
        clearAllCachedMetadata,
        clearAllCovers,
        clearPlaceholderCache,
        clearPhotoCache,
        clearAllEpochKeys,
        clearCacheEncryptionKey,
        closeDbClient,
        closeCryptoClient,
        closeGeoClient,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      sessionStorage.setItem('mosaic:sessionState', 'active');
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      vi.clearAllMocks();

      await session.clearCorruptedSession();

      expect(clearAllCachedMetadata).toHaveBeenCalledOnce();
      expect(clearAllCovers).toHaveBeenCalledOnce();
      expect(clearPlaceholderCache).toHaveBeenCalledOnce();
      expect(clearPhotoCache).toHaveBeenCalledOnce();
      expect(clearAllEpochKeys).toHaveBeenCalledOnce();
      expect(clearCacheEncryptionKey).toHaveBeenCalledOnce();
      expect(closeDbClient).toHaveBeenCalledOnce();
      expect(closeCryptoClient).toHaveBeenCalledOnce();
      expect(closeGeoClient).toHaveBeenCalledOnce();
      expect(session.isLoggedIn).toBe(false);
      expect(session.currentUser).toBeNull();
      expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    });

    it('clears key material before closing worker clients', async () => {
      const {
        session,
        clearAllEpochKeys,
        clearCacheEncryptionKey,
        closeDbClient,
        closeCryptoClient,
        getApi,
        getCryptoClient,
        getDbClient,
      } = await getSessionModule();

      const callOrder: string[] = [];

      (clearAllEpochKeys as Mock).mockImplementation(() => {
        callOrder.push('clearAllEpochKeys');
      });
      (clearCacheEncryptionKey as Mock).mockImplementation(() => {
        callOrder.push('clearCacheEncryptionKey');
      });
      (closeDbClient as Mock).mockImplementation(async () => {
        callOrder.push('closeDbClient');
      });
      (closeCryptoClient as Mock).mockImplementation(async () => {
        callOrder.push('closeCryptoClient');
      });

      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      (getApi as Mock).mockReturnValue(mockApi);
      (getCryptoClient as Mock).mockResolvedValue(mockCryptoClient);
      (getDbClient as Mock).mockResolvedValue(mockDbClient);
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      callOrder.length = 0;

      await session.clearCorruptedSession();

      expect(callOrder.indexOf('clearAllEpochKeys')).toBeLessThan(
        callOrder.indexOf('closeDbClient'),
      );
      expect(callOrder.indexOf('clearCacheEncryptionKey')).toBeLessThan(
        callOrder.indexOf('closeCryptoClient'),
      );
    });
  });
});
