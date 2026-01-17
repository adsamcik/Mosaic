/**
 * Tests for LocalAuth client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto-client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    initWithWrappedKey: vi.fn().mockResolvedValue(undefined),
    deriveIdentity: vi.fn().mockResolvedValue(undefined),
    deriveAuthKey: vi.fn().mockResolvedValue(undefined),
    signAuthChallenge: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    getAuthPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getIdentityPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getWrappedAccountKey: vi.fn().mockResolvedValue(new Uint8Array(72)), // 24 nonce + 48 ciphertext
  })),
}));

// Import after mocks are set up
import {
  localAuthLogin,
  localAuthRegister,
  isLocalAuthMode,
  initAuth,
  verifyAuth,
  registerUser,
} from '../src/lib/local-auth';

describe('LocalAuth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isLocalAuthMode', () => {
    it('returns true when auth endpoints exist', async () => {
      mockFetch.mockResolvedValue({ status: 400 });
      const result = await isLocalAuthMode();
      expect(result).toBe(true);
    });

    it('returns false when auth endpoints return 404', async () => {
      mockFetch.mockResolvedValue({ status: 404 });
      const result = await isLocalAuthMode();
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const result = await isLocalAuthMode();
      expect(result).toBe(false);
    });
  });

  describe('initAuth', () => {
    it('returns challenge data on success', async () => {
      const mockResponse = {
        challengeId: 'challenge-123',
        challenge: 'YWJjZGVm', // base64
        userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=', // 16 bytes base64
        timestamp: 1234567890,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await initAuth('testuser');
      expect(result).toEqual(mockResponse);
    });

    it('throws on error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid username format' }),
      });

      await expect(initAuth('bad!')).rejects.toThrow('Invalid username format');
    });
  });

  describe('verifyAuth', () => {
    it('returns verification data on success', async () => {
      const mockResponse = {
        success: true,
        userId: 'user-123',
        accountSalt: 'YWNjb3VudHNhbHQxMjM0NQ==',
        wrappedAccountKey: null,
        wrappedIdentitySeed: null,
        identityPubkey: null,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await verifyAuth(
        'testuser',
        'challenge-123',
        'sig123',
        1234567890,
      );
      expect(result).toEqual(mockResponse);
    });

    it('throws on invalid credentials', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      });

      await expect(
        verifyAuth('testuser', 'challenge-123', 'badsig', 1234567890),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('registerUser', () => {
    it('returns user data on success', async () => {
      const mockResponse = {
        id: 'user-123',
        username: 'testuser',
        isAdmin: true,
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await registerUser({
        username: 'testuser',
        authPubkey: 'authpub',
        identityPubkey: 'idpub',
        userSalt: 'salt',
        accountSalt: 'accsalt',
      });
      expect(result).toEqual(mockResponse);
    });

    it('throws "Username already exists" on 409', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Username already exists' }),
      });

      await expect(
        registerUser({
          username: 'existing',
          authPubkey: 'authpub',
          identityPubkey: 'idpub',
          userSalt: 'salt',
          accountSalt: 'accsalt',
        }),
      ).rejects.toThrow('Username already exists');
    });
  });

  describe('localAuthLogin', () => {
    it('returns user data on successful login', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=', // 16 bytes
            timestamp: 1234567890,
          }),
      });

      // Mock verifyAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            userId: 'user-123',
            accountSalt: 'YWNjb3VudHNhbHQxMjM0NQ==',
            wrappedAccountKey: null,
            wrappedIdentitySeed: null,
            identityPubkey: null,
          }),
      });

      const result = await localAuthLogin('testuser', 'password123');
      expect(result.userId).toBe('user-123');
      expect(result.isNewUser).toBe(false);
    });

    it('throws error when user does not exist (no auto-registration)', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock verifyAuth failure (user doesn't exist)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      });

      // Login should now throw error instead of auto-registering
      await expect(localAuthLogin('newuser', 'password123')).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('throws "Invalid credentials" when user exists but password is wrong', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock verifyAuth failure (wrong password -> wrong signature)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      });

      // Login should propagate the error - no auto-registration attempt
      await expect(
        localAuthLogin('existinguser', 'wrongpassword'),
      ).rejects.toThrow('Invalid credentials');
    });

    it('propagates other errors from verify', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock verifyAuth failure (different error)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Challenge expired' }),
      });

      await expect(localAuthLogin('user', 'password')).rejects.toThrow(
        'Challenge expired',
      );
    });
  });

  describe('localAuthRegister', () => {
    it('registers a new user and returns credentials', async () => {
      // Mock initAuth response (for getting user salt)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock registerUser success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'new-user-123',
            username: 'newuser',
            isAdmin: false,
          }),
      });

      // Mock initAuth (for login after register)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-456',
            challenge: 'ZGVmZ2hp',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567891,
          }),
      });

      // Mock verifyAuth success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            userId: 'new-user-123',
            accountSalt: null,
            wrappedAccountKey: null,
            wrappedIdentitySeed: null,
            identityPubkey: null,
          }),
      });

      const result = await localAuthRegister('newuser', 'password123');
      expect(result.userId).toBe('new-user-123');
      expect(result.isNewUser).toBe(true);
    });

    it('throws error when username already exists', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock registerUser failure (user already exists)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Username already exists' }),
      });

      await expect(
        localAuthRegister('existinguser', 'password123'),
      ).rejects.toThrow('Username already exists');
    });

    it('propagates server errors during registration', async () => {
      // Mock initAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            challengeId: 'challenge-123',
            challenge: 'YWJjZGVm',
            userSalt: 'c2FsdDEyMzQ1Njc4OTAxMjM0NTY=',
            timestamp: 1234567890,
          }),
      });

      // Mock registerUser failure (server error)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });

      await expect(localAuthRegister('user', 'password')).rejects.toThrow(
        'Internal server error',
      );
    });
  });
});
