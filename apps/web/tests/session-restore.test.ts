/**
 * Session Restore Tests
 *
 * Tests for session persistence and restoration across page reloads.
 * Verifies that users can restore their session after page refresh.
 */

import { describe, expect, it, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { initializeRustWasmForTests } from './wasm-test-init';

// Mock the dependencies before importing session
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual('../src/lib/api');
  return {
    ...actual,
    getApi: vi.fn(),
  };
});

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
  closeCryptoClient: vi.fn(),
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(),
  closeDbClient: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  clearAllEpochKeys: vi.fn(),
}));

vi.mock('../src/lib/album-cover-service', () => ({
  clearAllCovers: vi.fn(),
}));

vi.mock('../src/lib/album-metadata-service', () => ({
  clearAllCachedMetadata: vi.fn(),
}));

vi.mock('../src/lib/geo-client', () => ({
  closeGeoClient: vi.fn(),
}));

vi.mock('../src/lib/local-auth', () => ({
  localAuthLogin: vi.fn(),
  isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../src/lib/settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  getKeyCacheDurationMs: vi.fn(() => 0),
  subscribeToSettings: vi.fn(() => () => {}),
}));

// Import after mocks are set up
import { getApi } from '../src/lib/api';
import { getCryptoClient } from '../src/lib/crypto-client';
import { getDbClient } from '../src/lib/db-client';
import type { User } from '../src/lib/api-types';

// We need to dynamically import session to get a fresh instance per test
async function getSessionModule() {
  // Reset module registry to get fresh instance
  vi.resetModules();
  const { initializeRustWasmForTests } = await import('./wasm-test-init');
  await initializeRustWasmForTests();
  return import('../src/lib/session');
}

describe('Session Restore', () => {
  beforeAll(async () => {
    await initializeRustWasmForTests();
  });

  const mockUser: User = {
    id: 'user-123',
    authSub: 'testuser@example.com',
    identityPubkey: 'mock-pubkey',
    createdAt: '2024-01-01T00:00:00Z',
    encryptedSalt: undefined,
    saltNonce: undefined,
  };

  const mockUserWithSalt: User = {
    ...mockUser,
    encryptedSalt: 'mockEncryptedSalt',
    saltNonce: 'mockSaltNonce',
  };

  const mockCryptoClient = {
    init: vi.fn(),
    initWithWrappedKey: vi.fn(),
    deriveIdentity: vi.fn(),
    wrapDbBlob: vi.fn(async (plaintext: Uint8Array) => plaintext),
    unwrapDbBlob: vi.fn(async (wrapped: Uint8Array) => wrapped),
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

  // Mock global fetch for the wrapped-key endpoint
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mocks
    (getApi as ReturnType<typeof vi.fn>).mockReturnValue(mockApi);
    (getCryptoClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockCryptoClient,
    );
    (getDbClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockDbClient);

    // Mock fetch for wrapped-key endpoint
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    // Clear storage
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    global.fetch = originalFetch;
  });

  describe('checkSession', () => {
    it('returns user when session cookie is valid', async () => {
      const { session } = await getSessionModule();
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      const result = await session.checkSession();

      expect(result).toEqual(mockUser);
      expect(mockApi.getCurrentUser).toHaveBeenCalled();
    });

    it('returns null when session cookie is invalid or expired', async () => {
      const { session } = await getSessionModule();
      mockApi.getCurrentUser.mockRejectedValue(new Error('Unauthorized'));

      const result = await session.checkSession();

      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const { session } = await getSessionModule();
      mockApi.getCurrentUser.mockRejectedValue(new Error('Network error'));

      const result = await session.checkSession();

      expect(result).toBeNull();
    });
  });

  describe('needsSessionRestore', () => {
    it('returns false when not logged in and no session state', async () => {
      const { session } = await getSessionModule();

      expect(session.needsSessionRestore).toBe(false);
    });

    it('returns true when session state exists but not logged in', async () => {
      sessionStorage.setItem('mosaic:sessionState', 'active');
      const { session } = await getSessionModule();

      expect(session.needsSessionRestore).toBe(true);
    });

    it('returns false when already logged in', async () => {
      const { session } = await getSessionModule();

      // Set up for login
      mockApi.getCurrentUser.mockResolvedValue(mockUser);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...new Uint8Array(16))),
      );

      await session.login('test-password');

      expect(session.needsSessionRestore).toBe(false);
    });
  });

  describe('restoreSession', () => {
    it('restores session with valid password when server has salt', async () => {
      const { session, encryptSalt } = await getSessionModule();

      // Encrypt a salt with known password
      const salt = new Uint8Array(16).fill(1);
      const { encryptedSalt, saltNonce } = await encryptSalt(
        salt,
        'test-password',
        mockUser.authSub,
      );

      const userWithRealSalt: User = {
        ...mockUser,
        encryptedSalt,
        saltNonce,
      };

      mockApi.getCurrentUser.mockResolvedValue(userWithRealSalt);

      await session.restoreSession('test-password', userWithRealSalt);

      expect(session.isLoggedIn).toBe(true);
      expect(session.currentUser).toEqual(userWithRealSalt);
      expect(mockCryptoClient.init).toHaveBeenCalled();
      expect(mockCryptoClient.deriveIdentity).toHaveBeenCalled();
      expect(mockDbClient.init).toHaveBeenCalled();
    });

    it('restores session with local salt when server has no salt', async () => {
      const { session } = await getSessionModule();

      // Set up local salt
      const salt = new Uint8Array(16).fill(2);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );

      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.restoreSession('test-password');

      expect(session.isLoggedIn).toBe(true);
      expect(mockCryptoClient.init).toHaveBeenCalled();
    });

    it('throws error when no salt is available', async () => {
      const { session } = await getSessionModule();
      mockApi.getCurrentUser.mockResolvedValue(mockUser);
      // No local salt, no server salt

      await expect(session.restoreSession('test-password')).rejects.toThrow(
        'No salt available',
      );
    });

    it('throws SaltDecryptionError when password is wrong', async () => {
      const { session, encryptSalt, SaltDecryptionError } =
        await getSessionModule();

      // Encrypt salt with one password
      const salt = new Uint8Array(16).fill(3);
      const { encryptedSalt, saltNonce } = await encryptSalt(
        salt,
        'correct-password',
        mockUser.authSub,
      );

      const userWithSalt: User = {
        ...mockUser,
        encryptedSalt,
        saltNonce,
      };

      mockApi.getCurrentUser.mockResolvedValue(userWithSalt);

      // Try to restore with wrong password
      await expect(
        session.restoreSession('wrong-password', userWithSalt),
      ).rejects.toThrow(SaltDecryptionError);
    });

    it('marks session as active after restore', async () => {
      const { session } = await getSessionModule();

      const salt = new Uint8Array(16).fill(4);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.restoreSession('test-password');

      expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');
    });

    it('uses provided user object to skip API call', async () => {
      const { session } = await getSessionModule();

      const salt = new Uint8Array(16).fill(5);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );

      await session.restoreSession('test-password', mockUser);

      // getCurrentUser should not be called because we passed the user
      expect(mockApi.getCurrentUser).not.toHaveBeenCalled();
      expect(session.currentUser).toEqual(mockUser);
    });

    it('uses the server account salt when unwrapping an existing account key', async () => {
      const { session } = await getSessionModule();

      const userSalt = new Uint8Array(16).fill(8);
      const accountSalt = new Uint8Array(
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
      const wrappedAccountKey = new Uint8Array(72).fill(9);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...userSalt)),
      );

      const returningUser: User = {
        ...mockUser,
        accountSalt: btoa(String.fromCharCode(...accountSalt)),
        wrappedAccountKey: btoa(String.fromCharCode(...wrappedAccountKey)),
      };

      await session.restoreSession('test-password', returningUser);

      expect(mockCryptoClient.initWithWrappedKey).toHaveBeenCalledWith(
        'test-password',
        userSalt,
        accountSalt,
        wrappedAccountKey,
      );
      expect(mockCryptoClient.init).not.toHaveBeenCalled();
    });
  });

  describe('login marks session active', () => {
    it('sets session state to active after login', async () => {
      const { session } = await getSessionModule();

      const salt = new Uint8Array(16).fill(6);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');

      expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');
    });
  });

  describe('logout clears session state', () => {
    it('clears session storage on logout', async () => {
      const { session } = await getSessionModule();

      const salt = new Uint8Array(16).fill(7);
      localStorage.setItem(
        'mosaic:userSalt',
        btoa(String.fromCharCode(...salt)),
      );
      mockApi.getCurrentUser.mockResolvedValue(mockUser);

      await session.login('test-password');
      expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');

      await session.logout();
      expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    });
  });
});

describe('Session Restore Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('simulates page reload scenario', async () => {
    // First session: user logs in
    const { session: session1, encryptSalt } = await getSessionModule();

    const mockUser: User = {
      id: 'user-456',
      authSub: 'reload-test@example.com',
      identityPubkey: 'mock-pubkey',
      createdAt: '2024-01-01T00:00:00Z',
      encryptedSalt: undefined,
      saltNonce: undefined,
    };

    const mockApi = {
      getCurrentUser: vi.fn().mockResolvedValue(mockUser),
      updateCurrentUser: vi.fn().mockResolvedValue(mockUser),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    const mockCryptoClient = {
      init: vi.fn(),
      initWithWrappedKey: vi.fn(),
      deriveIdentity: vi.fn(),
      wrapDbBlob: vi.fn(async (plaintext: Uint8Array) => plaintext),
      unwrapDbBlob: vi.fn(async (wrapped: Uint8Array) => wrapped),
      getWrappedAccountKey: vi.fn(() => new Uint8Array(72)),
      getIdentityPublicKey: vi.fn(() => new Uint8Array(32)),
      serializeSessionState: vi.fn(() => new Uint8Array(120)),
      clear: vi.fn(),
    };

    const mockDbClient = {
      init: vi.fn(),
      close: vi.fn(),
    };

    (getApi as ReturnType<typeof vi.fn>).mockReturnValue(mockApi);
    (getCryptoClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockCryptoClient,
    );
    (getDbClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockDbClient);

    // Mock fetch for wrapped-key endpoint
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    // Initial login
    await session1.login('my-password');
    expect(session1.isLoggedIn).toBe(true);
    expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');

    // Simulate page reload: get fresh session module
    // The sessionStorage persists across module reloads
    const { session: session2 } = await getSessionModule();

    // New session instance is not logged in
    expect(session2.isLoggedIn).toBe(false);
    // But needs session restore because sessionStorage has the marker
    expect(session2.needsSessionRestore).toBe(true);

    // Check if server session is still valid
    const user = await session2.checkSession();
    expect(user).toBeTruthy();

    // Restore session with password
    await session2.restoreSession('my-password', user!);
    expect(session2.isLoggedIn).toBe(true);
  });
});
