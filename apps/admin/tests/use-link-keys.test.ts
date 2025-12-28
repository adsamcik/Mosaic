/**
 * useLinkKeys Hook Tests
 *
 * Tests the useLinkKeys hook behavior for managing share link keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// Mock IndexedDB
const mockIDBRequest = {
  error: null,
  result: null,
  onsuccess: null as ((event: Event) => void) | null,
  onerror: null as ((event: Event) => void) | null,
};

const mockIDBObjectStore = {
  put: vi.fn(() => mockIDBRequest),
  get: vi.fn(() => mockIDBRequest),
  delete: vi.fn(() => mockIDBRequest),
};

const mockIDBTransaction = {
  objectStore: vi.fn(() => mockIDBObjectStore),
  oncomplete: null as (() => void) | null,
};

const mockIDBDatabase = {
  objectStoreNames: { contains: vi.fn(() => true) },
  createObjectStore: vi.fn(),
  transaction: vi.fn(() => mockIDBTransaction),
  close: vi.fn(),
};

const mockIDBOpenRequest = {
  error: null,
  result: mockIDBDatabase,
  onsuccess: null as ((event: Event) => void) | null,
  onerror: null as ((event: Event) => void) | null,
  onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
};

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock @mosaic/crypto
const mockDecodeLinkSecret = vi.fn();
const mockDecodeLinkId = vi.fn();
const mockDeriveLinkKeys = vi.fn();
const mockUnwrapTierKeyFromLink = vi.fn();
const mockFromBase64 = vi.fn();
const mockToBase64 = vi.fn();
const mockConstantTimeEqual = vi.fn();

vi.mock('@mosaic/crypto', () => ({
  decodeLinkSecret: (...args: unknown[]) => mockDecodeLinkSecret(...args),
  decodeLinkId: (...args: unknown[]) => mockDecodeLinkId(...args),
  deriveLinkKeys: (...args: unknown[]) => mockDeriveLinkKeys(...args),
  unwrapTierKeyFromLink: (...args: unknown[]) => mockUnwrapTierKeyFromLink(...args),
  fromBase64: (...args: unknown[]) => mockFromBase64(...args),
  toBase64: (...args: unknown[]) => mockToBase64(...args),
  constantTimeEqual: (...args: unknown[]) => mockConstantTimeEqual(...args),
  AccessTier: {
    THUMB: 1,
    PREVIEW: 2,
    FULL: 3,
  },
}));

// Import after mocks
import { useLinkKeys, parseLinkFragment, clearLinkKeys } from '../src/hooks/useLinkKeys';

describe('useLinkKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup IndexedDB mock
    Object.defineProperty(global, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          setTimeout(() => {
            mockIDBOpenRequest.onsuccess?.({ target: mockIDBOpenRequest } as unknown as Event);
          }, 0);
          return mockIDBOpenRequest;
        }),
      },
      writable: true,
    });

    // Default crypto mocks
    mockDecodeLinkSecret.mockReturnValue(new Uint8Array(32).fill(1));
    mockDecodeLinkId.mockReturnValue(new Uint8Array(16).fill(2));
    mockDeriveLinkKeys.mockReturnValue({
      linkId: new Uint8Array(16).fill(2),
      wrappingKey: new Uint8Array(32).fill(3),
    });
    mockConstantTimeEqual.mockReturnValue(true);
    mockFromBase64.mockImplementation((s: string) => {
      if (s === 'test-nonce') return new Uint8Array(24).fill(4);
      if (s === 'test-encrypted') return new Uint8Array(48).fill(5);
      if (s === 'test-signpubkey') return new Uint8Array(32).fill(6);
      return new Uint8Array(32);
    });
    mockToBase64.mockImplementation((arr: Uint8Array) => btoa(String.fromCharCode(...arr)));
    mockUnwrapTierKeyFromLink.mockReturnValue(new Uint8Array(32).fill(7));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should start with loading state', () => {
      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.isValid).toBe(false);
    });

    it('should set error when linkId is missing', async () => {
      const { result } = renderHook(() => useLinkKeys(null, 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.message).toContain('Missing link ID');
      expect(result.current.isValid).toBe(false);
    });

    it('should set error when linkSecret is missing', async () => {
      const { result } = renderHook(() => useLinkKeys('test-link-id', null));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.message).toContain('Missing link ID or secret');
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('link validation', () => {
    it('should reject tampered links', async () => {
      // Make constantTimeEqual return false (linkId mismatch)
      mockConstantTimeEqual.mockReturnValue(false);

      // Mock IndexedDB to return null (no cache)
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error?.message).toContain('tampered');
      expect(result.current.isValid).toBe(false);
    });

    it('should handle invalid link format', async () => {
      mockDecodeLinkSecret.mockImplementation(() => {
        throw new Error('Invalid base64');
      });

      // Mock IndexedDB to return null
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'invalid-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error?.message).toContain('Invalid link format');
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('key fetching', () => {
    it('should fetch and unwrap keys from server', async () => {
      // Mock IndexedDB to return null (no cache)
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      // Mock put to succeed
      mockIDBObjectStore.put.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
          mockIDBTransaction.oncomplete?.();
        }, 0);
        return req;
      });

      // Mock successful API responses
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            albumId: 'album-123',
            accessTier: 2,
            epochCount: 1,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              epochId: 1,
              tier: 1,
              nonce: 'test-nonce',
              encryptedKey: 'test-encrypted',
              signPubkey: 'test-signpubkey',
            },
            {
              epochId: 1,
              tier: 2,
              nonce: 'test-nonce',
              encryptedKey: 'test-encrypted',
              signPubkey: 'test-signpubkey',
            },
          ],
        });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isValid).toBe(true);
      expect(result.current.albumId).toBe('album-123');
      expect(result.current.accessTier).toBe(2);
      expect(result.current.tierKeys.size).toBe(1);
      expect(result.current.tierKeys.get(1)?.size).toBe(2);
    });

    it('should handle API errors gracefully', async () => {
      // Mock IndexedDB to return null
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      // Mock failed API response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Link not found' }),
      });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isValid).toBe(false);
      expect(result.current.error?.message).toContain('Link not found');
    });
  });

  describe('getReadKey', () => {
    it('should return highest available tier key', async () => {
      // Setup mock with tier keys already loaded
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: {
            linkId: 'test-link-id',
            albumId: 'album-123',
            accessTier: 3,
            keys: [
              { epochId: 1, tier: 1, key: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))) },
              { epochId: 1, tier: 2, key: btoa(String.fromCharCode(...new Uint8Array(32).fill(2))) },
              { epochId: 1, tier: 3, key: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))) },
            ],
            storedAt: Date.now(),
          },
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Get read key for epoch 1 - should return tier 3 (highest)
      const readKey = result.current.getReadKey(1);
      expect(readKey).toBeDefined();
    });

    it('should return undefined for unknown epoch', async () => {
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      // Mock successful API responses with keys for epoch 1 only
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            albumId: 'album-123',
            accessTier: 2,
            epochCount: 1,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { epochId: 1, tier: 1, nonce: 'test-nonce', encryptedKey: 'test-encrypted' },
          ],
        });

      mockIDBObjectStore.put.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
          mockIDBTransaction.oncomplete?.();
        }, 0);
        return req;
      });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Epoch 999 doesn't exist
      const readKey = result.current.getReadKey(999);
      expect(readKey).toBeUndefined();
    });
  });

  describe('refresh', () => {
    it('should refetch keys when refresh is called', async () => {
      mockIDBObjectStore.get.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          result: undefined,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
        }, 0);
        return req;
      });

      mockIDBObjectStore.put.mockImplementation(() => {
        const req = {
          ...mockIDBRequest,
          onsuccess: null as ((event: Event) => void) | null,
          onerror: null as ((event: Event) => void) | null,
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req } as unknown as Event);
          mockIDBTransaction.oncomplete?.();
        }, 0);
        return req;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ albumId: 'album-123', accessTier: 2, epochCount: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ epochId: 1, tier: 1, nonce: 'n', encryptedKey: 'e' }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ albumId: 'album-123', accessTier: 3, epochCount: 2 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { epochId: 1, tier: 1, nonce: 'n', encryptedKey: 'e' },
            { epochId: 2, tier: 1, nonce: 'n', encryptedKey: 'e' },
          ],
        });

      const { result } = renderHook(() => useLinkKeys('test-link-id', 'test-secret'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Call refresh
      await act(async () => {
        await result.current.refresh();
      });

      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
});

describe('parseLinkFragment', () => {
  it('should parse valid fragment', () => {
    const result = parseLinkFragment('#k=ABC123_-');
    expect(result).toBe('ABC123_-');
  });

  it('should return null for missing #k=', () => {
    expect(parseLinkFragment('#other=value')).toBeNull();
    expect(parseLinkFragment('')).toBeNull();
    expect(parseLinkFragment('#')).toBeNull();
  });

  it('should return null for empty secret', () => {
    expect(parseLinkFragment('#k=')).toBeNull();
  });

  it('should return null for invalid base64url characters', () => {
    expect(parseLinkFragment('#k=invalid!chars')).toBeNull();
    expect(parseLinkFragment('#k=has spaces')).toBeNull();
  });

  it('should accept valid base64url characters', () => {
    expect(parseLinkFragment('#k=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')).not.toBeNull();
  });
});

describe('clearLinkKeys', () => {
  beforeEach(() => {
    Object.defineProperty(global, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          setTimeout(() => {
            mockIDBOpenRequest.onsuccess?.({ target: mockIDBOpenRequest } as unknown as Event);
          }, 0);
          return mockIDBOpenRequest;
        }),
      },
      writable: true,
    });
  });

  it('should delete keys from IndexedDB', async () => {
    mockIDBObjectStore.delete.mockImplementation(() => {
      const req = {
        ...mockIDBRequest,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
      };
      setTimeout(() => {
        req.onsuccess?.({ target: req } as unknown as Event);
        mockIDBTransaction.oncomplete?.();
      }, 0);
      return req;
    });

    await clearLinkKeys('test-link-id');

    expect(mockIDBObjectStore.delete).toHaveBeenCalledWith('test-link-id');
  });
});
