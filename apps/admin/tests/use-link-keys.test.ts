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
  crypto: {
    decodeLinkSecret: vi.fn(),
    decodeLinkId: vi.fn(),
    deriveLinkKeys: vi.fn(),
    unwrapTierKeyFromLink: vi.fn(),
    fromBase64: vi.fn(),
    toBase64: vi.fn(),
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

// Mock @mosaic/crypto
vi.mock('@mosaic/crypto', () => ({
  decodeLinkSecret: (...args: unknown[]) => mocks.crypto.decodeLinkSecret(...args),
  decodeLinkId: (...args: unknown[]) => mocks.crypto.decodeLinkId(...args),
  deriveLinkKeys: (...args: unknown[]) => mocks.crypto.deriveLinkKeys(...args),
  unwrapTierKeyFromLink: (...args: unknown[]) => mocks.crypto.unwrapTierKeyFromLink(...args),
  fromBase64: (...args: unknown[]) => mocks.crypto.fromBase64(...args),
  toBase64: (...args: unknown[]) => mocks.crypto.toBase64(...args),
  constantTimeEqual: (...args: unknown[]) => mocks.crypto.constantTimeEqual(...args),
  AccessTier: {
    THUMB: 1,
    PREVIEW: 2,
    FULL: 3,
  },
}));

// Mock fetch globally
global.fetch = mocks.fetch as unknown as typeof fetch;

// Import after mocks
import { clearLinkKeys, parseLinkFragment, useLinkKeys } from '../src/hooks/useLinkKeys';

// Test component that captures hook result
function TestComponent({ 
  linkId, 
  linkSecret, 
  onResult 
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
    updateTrigger = useCallback(() => setCount(c => c + 1), []);
    return createElement(TestComponent, {
      linkId: currentLinkId,
      linkSecret: currentLinkSecret,
      onResult: (result) => { hookResult = result; }
    });
  }

  const root = createRoot(container);
  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    get result() { return hookResult!; },
    cleanup: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
    rerender: (newLinkId?: string | null, newLinkSecret?: string | null) => {
      if (newLinkId !== undefined) currentLinkId = newLinkId;
      if (newLinkSecret !== undefined) currentLinkSecret = newLinkSecret;
      act(() => {
        updateTrigger?.();
      });
    }
  };
}

// Helper to wait for async updates
async function waitFor(
  condition: () => boolean,
  { timeout = 1000, interval = 10 } = {}
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timed out');
    }
    await new Promise(r => setTimeout(r, interval));
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
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
          mockIDBOpenRequest.onsuccess?.({ target: mockIDBOpenRequest } as unknown as Event);
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

    // Default crypto mocks
    mocks.crypto.decodeLinkSecret.mockReturnValue(new Uint8Array(32).fill(1));
    mocks.crypto.decodeLinkId.mockReturnValue(new Uint8Array(16).fill(2));
    mocks.crypto.deriveLinkKeys.mockReturnValue({
      linkId: new Uint8Array(16).fill(2),
      wrappingKey: new Uint8Array(32).fill(3),
    });
    mocks.crypto.constantTimeEqual.mockReturnValue(true);
    mocks.crypto.fromBase64.mockImplementation((s: string) => {
      if (s === 'test-nonce') return new Uint8Array(24).fill(4);
      if (s === 'test-encrypted') return new Uint8Array(48).fill(5);
      if (s === 'test-signpubkey') return new Uint8Array(32).fill(6);
      return new Uint8Array(32);
    });
    mocks.crypto.toBase64.mockImplementation((arr: Uint8Array) => 
      btoa(String.fromCharCode(...arr))
    );
    mocks.crypto.unwrapTierKeyFromLink.mockReturnValue(new Uint8Array(32).fill(7));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('should start with loading state', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

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
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      expect(result.error).toBeNull(); // Initially null

      cleanup();
    });

    it('should expose isValid property', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      expect(typeof result.isValid).toBe('boolean');

      cleanup();
    });
  });

  describe('key fetching', () => {
    it('should expose isLoading property', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      expect(typeof result.isLoading).toBe('boolean');
      
      cleanup();
    });

    it('should expose getReadKey function', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      expect(typeof result.getReadKey).toBe('function');
      
      cleanup();
    });
  });

  describe('getReadKey', () => {
    it('should return undefined when no keys loaded', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      // Before async loading completes, getReadKey should return undefined
      const readKey = result.getReadKey(999);
      expect(readKey).toBeUndefined();

      cleanup();
    });

    it('should expose tierKeys as a Map', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

      expect(result.tierKeys).toBeInstanceOf(Map);
      
      cleanup();
    });
  });

  describe('refresh', () => {
    it('should expose refresh function', () => {
      const { result, cleanup } = renderHookWithArgs('test-link-id', 'test-secret');

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
    expect(parseLinkFragment('#k=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')).not.toBeNull();
  });
});

describe('clearLinkKeys', () => {
  it('should be a function that accepts a linkId', () => {
    expect(typeof clearLinkKeys).toBe('function');
    expect(clearLinkKeys.length).toBe(1); // Takes one argument
  });
});
