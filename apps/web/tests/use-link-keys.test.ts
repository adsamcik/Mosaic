/**
 * useLinkKeys Hook Tests
 *
 * Tests the useLinkKeys hook behavior for managing share link keys.
 */

import { act, createElement, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted to create mocks before vi.mock hoisting
const mocks = vi.hoisted(() => ({
  // Slice 6 — share-link unwrapping routes through the crypto worker via
  // Comlink, not via direct `@mosaic/crypto` imports. The hook also reaches
  // for `fromBase64` from `lib/api` and the URL encoders from
  // `lib/link-encoding`, all of which we mock below.
  worker: {
    deriveLinkKeys: vi.fn(),
    unwrapTierKeyFromLink: vi.fn(),
  },
  api: {
    fromBase64: vi.fn(),
  },
  linkEncoding: {
    decodeLinkSecret: vi.fn(),
    decodeLinkId: vi.fn(),
    constantTimeEqual: vi.fn(),
  },
  fetch: vi.fn(),
}));

// Mock IndexedDB objects (recreated each test)
let mockIDBRequest: {
  error: Error | null;
  result: unknown;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

let mockIDBObjectStore: {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

let mockIDBTransaction: {
  objectStore: ReturnType<typeof vi.fn>;
  oncomplete: (() => void) | null;
};

let mockIDBDatabase: {
  objectStoreNames: { contains: ReturnType<typeof vi.fn> };
  createObjectStore: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let mockIDBOpenRequest: {
  error: Error | null;
  result: unknown;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
};

// Slice 6 — the hook now talks to the crypto worker for derivation and
// unwrapping; expose a Comlink-style remote with the methods we need.
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mocks.worker),
}));

// `lib/api` exposes the base64 helpers the hook uses to decode wire-format
// nonces / encrypted keys.
vi.mock('../src/lib/api', () => ({
  fromBase64: (s: string) => mocks.api.fromBase64(s),
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

// `lib/link-encoding` is the new home of the base64url URL helpers and
// `constantTimeEqual` (Slice 6 split). Tests stub them out so the hook
// can be exercised with sentinel string inputs.
vi.mock('../src/lib/link-encoding', () => ({
  decodeLinkSecret: (...args: unknown[]) =>
    mocks.linkEncoding.decodeLinkSecret(...(args as [string])),
  decodeLinkId: (...args: unknown[]) =>
    mocks.linkEncoding.decodeLinkId(...(args as [string])),
  constantTimeEqual: (...args: unknown[]) =>
    mocks.linkEncoding.constantTimeEqual(
      ...(args as [Uint8Array, Uint8Array]),
    ),
  // Re-export the size constants so any consumer that imports them keeps
  // working — they are not used by the hook directly but live in the same
  // module.
  LINK_SECRET_SIZE: 32,
  LINK_ID_SIZE: 16,
}));

// Mock fetch globally
global.fetch = mocks.fetch as unknown as typeof fetch;

// Import after mocks
import {
  clearLinkKeys,
  parseLinkFragment,
  useLinkKeys,
} from '../src/hooks/useLinkKeys';
import * as linkTierKeyStore from '../src/lib/link-tier-key-store';

// Test component that captures hook result
function TestComponent({
  linkId,
  linkSecret,
  onResult,
}: {
  linkId: string | null;
  linkSecret: string | null;
  onResult: (result: ReturnType<typeof useLinkKeys>) => void;
}) {
  const result = useLinkKeys(linkId, linkSecret);
  onResult(result);
  return null;
}

// Helper to render hook with proper state tracking
function renderHookWithArgs(linkId: string | null, linkSecret: string | null) {
  let hookResult: ReturnType<typeof useLinkKeys>;
  let updateTrigger: (() => void) | null = null;
  let currentLinkId = linkId;
  let currentLinkSecret = linkSecret;
  const container = document.createElement('div');
  document.body.appendChild(container);

  function Wrapper() {
    const [, setCount] = useState(0);
    updateTrigger = useCallback(() => setCount((c) => c + 1), []);
    return createElement(TestComponent, {
      linkId: currentLinkId,
      linkSecret: currentLinkSecret,
      onResult: (result) => {
        hookResult = result;
      },
    });
  }

  const root = createRoot(container);
  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    get result() {
      return hookResult!;
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    rerender: (newLinkId?: string | null, newLinkSecret?: string | null) => {
      if (newLinkId !== undefined) currentLinkId = newLinkId;
      if (newLinkSecret !== undefined) currentLinkSecret = newLinkSecret;
      act(() => {
        updateTrigger?.();
      });
    },
  };
}

// Helper to wait for async updates
async function waitFor(
  condition: () => boolean,
  { timeout = 1000, interval = 10 } = {},
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, interval));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// Setup IndexedDB mocks before each test
function setupIndexedDB() {
  mockIDBRequest = {
    error: null,
    result: null,
    onsuccess: null,
    onerror: null,
  };

  mockIDBObjectStore = {
    put: vi.fn(() => {
      const req = { ...mockIDBRequest };
      setTimeout(() => {
        req.onsuccess?.({ target: req } as unknown as Event);
        mockIDBTransaction.oncomplete?.();
      }, 0);
      return req;
    }),
    get: vi.fn(() => {
      const req = { ...mockIDBRequest, result: undefined };
      setTimeout(() => {
        req.onsuccess?.({ target: req } as unknown as Event);
      }, 0);
      return req;
    }),
    delete: vi.fn(() => {
      const req = { ...mockIDBRequest };
      setTimeout(() => {
        req.onsuccess?.({ target: req } as unknown as Event);
        mockIDBTransaction.oncomplete?.();
      }, 0);
      return req;
    }),
  };

  mockIDBTransaction = {
    objectStore: vi.fn(() => mockIDBObjectStore),
    oncomplete: null,
  };

  mockIDBDatabase = {
    objectStoreNames: { contains: vi.fn(() => true) },
    createObjectStore: vi.fn(),
    transaction: vi.fn(() => mockIDBTransaction),
    close: vi.fn(),
  };

  mockIDBOpenRequest = {
    error: null,
    result: mockIDBDatabase,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };

  Object.defineProperty(global, 'indexedDB', {
    value: {
      open: vi.fn(() => {
        setTimeout(() => {
          mockIDBOpenRequest.onsuccess?.({
            target: mockIDBOpenRequest,
          } as unknown as Event);
        }, 0);
        return mockIDBOpenRequest;
      }),
    },
    writable: true,
    configurable: true,
  });
}

describe('useLinkKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupIndexedDB();
    document.body.innerHTML = '';

    // Default mocks for the share-link decoders, the worker, and api helpers.
    mocks.linkEncoding.decodeLinkSecret.mockReturnValue(
      new Uint8Array(32).fill(1),
    );
    mocks.linkEncoding.decodeLinkId.mockReturnValue(new Uint8Array(16).fill(2));
    mocks.linkEncoding.constantTimeEqual.mockReturnValue(true);
    mocks.worker.deriveLinkKeys.mockResolvedValue({
      linkId: new Uint8Array(16).fill(2),
      wrappingKey: new Uint8Array(32).fill(3),
    });
    mocks.api.fromBase64.mockImplementation((s: string) => {
      if (s === 'test-nonce') return new Uint8Array(24).fill(4);
      if (s === 'test-encrypted') return new Uint8Array(48).fill(5);
      if (s === 'test-signpubkey') return new Uint8Array(32).fill(6);
      return new Uint8Array(32);
    });
    mocks.worker.unwrapTierKeyFromLink.mockResolvedValue(
      new Uint8Array(32).fill(7),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('should start with loading state', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(result.isLoading).toBe(true);
      expect(result.error).toBeNull();
      expect(result.isValid).toBe(false);

      cleanup();
    });

    it('should set error when linkId is missing', async () => {
      const { result, cleanup } = renderHookWithArgs(null, 'test-secret');

      await waitFor(() => !result.isLoading);

      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain('Missing link ID');
      expect(result.isValid).toBe(false);

      cleanup();
    });

    it('should set error when linkSecret is missing', async () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', null);

      await waitFor(() => !result.isLoading);

      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain('Missing link ID or secret');
      expect(result.isValid).toBe(false);

      cleanup();
    });
  });

  describe('link validation', () => {
    it('should expose error property for validation feedback', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(result.error).toBeNull(); // Initially null

      cleanup();
    });

    it('should expose isValid property', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(typeof result.isValid).toBe('boolean');

      cleanup();
    });
  });

  describe('key fetching', () => {
    it('should expose isLoading property', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(typeof result.isLoading).toBe('boolean');

      cleanup();
    });

    it('should expose getReadKey function', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(typeof result.getReadKey).toBe('function');

      cleanup();
    });

    it('fetches a grant token and sends it when loading keys', async () => {
      vi.spyOn(linkTierKeyStore, 'getTierKeys').mockResolvedValue(null);
      vi.spyOn(linkTierKeyStore, 'saveTierKeys').mockResolvedValue(undefined);

      mocks.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            albumId: 'album-123',
            accessTier: 2,
            epochCount: 1,
            encryptedName: 'encrypted-name',
            grantToken: 'grant-token-123',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              epochId: 1,
              tier: 2,
              nonce: 'test-nonce',
              encryptedKey: 'test-encrypted',
              signPubkey: 'test-signpubkey',
            },
          ],
        });

      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      await waitFor(() => mocks.fetch.mock.calls.length === 2);

      expect(mocks.fetch).toHaveBeenNthCalledWith(1, '/api/s/test-link-id');
      expect(mocks.fetch).toHaveBeenNthCalledWith(
        2,
        '/api/s/test-link-id/keys',
        {
          headers: {
            'X-Share-Grant': 'grant-token-123',
          },
        },
      );

      cleanup();
    });

    it('still revalidates access when cached tier keys exist', async () => {
      vi.spyOn(linkTierKeyStore, 'getTierKeys').mockResolvedValue({
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: new Map([
          [
            1,
            new Map([
              [
                2,
                {
                  epochId: 1,
                  tier: 2,
                  key: new Uint8Array(32).fill(7),
                },
              ],
            ]),
          ],
        ]),
      });

      mocks.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          albumId: 'album-123',
          accessTier: 2,
          epochCount: 1,
          grantToken: 'grant-token-123',
        }),
      });

      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      await waitFor(() => mocks.fetch.mock.calls.length === 1);

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.fetch).toHaveBeenCalledWith('/api/s/test-link-id');
      expect(linkTierKeyStore.getTierKeys).toHaveBeenCalledWith('test-link-id');

      cleanup();
    });
  });

  describe('getReadKey', () => {
    it('should return undefined when no keys loaded', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      // Before async loading completes, getReadKey should return undefined
      const readKey = result.getReadKey(999);
      expect(readKey).toBeUndefined();

      cleanup();
    });

    it('should expose tierKeys as a Map', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(result.tierKeys).toBeInstanceOf(Map);

      cleanup();
    });
  });

  describe('refresh', () => {
    it('should expose refresh function', () => {
      const { result, cleanup } = renderHookWithArgs(
        'test-link-id',
        'test-secret',
      );

      expect(typeof result.refresh).toBe('function');

      cleanup();
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
    expect(
      parseLinkFragment(
        '#k=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
      ),
    ).not.toBeNull();
  });
});

describe('clearLinkKeys', () => {
  it('should be a function that accepts a linkId', () => {
    expect(typeof clearLinkKeys).toBe('function');
    expect(clearLinkKeys.length).toBe(1); // Takes one argument
  });
});
