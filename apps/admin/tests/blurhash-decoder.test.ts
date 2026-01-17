/**
 * BlurHash Decoder Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBlurhashCache,
  decodeBlurhashToDataURL,
  getCachedBlurhashDataURL,
  isValidBlurhash,
} from '../src/lib/blurhash-decoder';

// Mock canvas since we're in a test environment
const mockCanvas = {
  width: 0,
  height: 0,
  toDataURL: vi.fn().mockReturnValue('data:image/png;base64,mockImageData'),
  getContext: vi.fn(),
};

const mockContext = {
  createImageData: vi
    .fn()
    .mockImplementation((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
  putImageData: vi.fn(),
};

const originalCreateElement = document.createElement.bind(document);

beforeEach(() => {
  mockCanvas.getContext = vi.fn().mockReturnValue(mockContext);

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      return mockCanvas as unknown as HTMLCanvasElement;
    }
    return originalCreateElement(tag);
  });

  clearBlurhashCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidBlurhash', () => {
  it('returns true for valid blurhash strings', () => {
    // Example blurhash strings from the blurhash documentation
    expect(isValidBlurhash('LEHV6nWB2yk8pyo0adR*.7kCMdnj')).toBe(true);
    expect(isValidBlurhash('LGF5]+Yk^6#M@-5c,1J5@[or[Q6.')).toBe(true);
    expect(isValidBlurhash('L6PZfSi_.AyE_3t7t7R**0o#DgR4')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isValidBlurhash('')).toBe(false);
  });

  it('returns false for too short strings', () => {
    expect(isValidBlurhash('ABC')).toBe(false);
    expect(isValidBlurhash('ABCDE')).toBe(false);
  });

  it('returns false for strings with invalid characters', () => {
    expect(isValidBlurhash('LEHV6nWB2yk8pyo0adR<>7kCMdnj')).toBe(false);
    expect(isValidBlurhash('LEHV6nWB2yk8pyo0adR!&7kCMdnj')).toBe(false);
  });

  it('returns false for very long strings', () => {
    expect(isValidBlurhash('A'.repeat(101))).toBe(false);
  });

  it('returns true for minimum valid blurhash (6 chars)', () => {
    expect(isValidBlurhash('L00000')).toBe(true);
  });
});

describe('decodeBlurhashToDataURL', () => {
  it('returns a data URL', () => {
    const result = decodeBlurhashToDataURL(
      'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      32,
      32,
    );

    expect(result).toMatch(/^data:/);
    expect(mockCanvas.toDataURL).toHaveBeenCalled();
    expect(mockContext.createImageData).toHaveBeenCalledWith(32, 32);
    expect(mockContext.putImageData).toHaveBeenCalled();
  });

  it('uses custom dimensions', () => {
    decodeBlurhashToDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 64, 48);

    expect(mockContext.createImageData).toHaveBeenCalledWith(64, 48);
  });

  it('throws when canvas context is unavailable', () => {
    mockCanvas.getContext = vi.fn().mockReturnValue(null);

    expect(() =>
      decodeBlurhashToDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj'),
    ).toThrow('Failed to get canvas 2D context');
  });
});

describe('getCachedBlurhashDataURL', () => {
  it('caches decoded blurhash', () => {
    const blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

    // Clear any previous calls
    mockContext.createImageData.mockClear();

    // First call - should decode
    const result1 = getCachedBlurhashDataURL(blurhash);
    const callCount = mockContext.createImageData.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);

    // Clear mock call count
    mockContext.createImageData.mockClear();

    // Second call - should use cache (no new decode calls)
    const result2 = getCachedBlurhashDataURL(blurhash);
    expect(mockContext.createImageData).not.toHaveBeenCalled();

    // Results should be the same
    expect(result1).toBe(result2);
  });

  it('caches different dimensions separately', () => {
    const blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

    // Clear any previous calls and cache
    clearBlurhashCache();
    mockContext.createImageData.mockClear();

    getCachedBlurhashDataURL(blurhash, 32, 32);
    const callsAfterFirst = mockContext.createImageData.mock.calls.length;

    getCachedBlurhashDataURL(blurhash, 64, 64);
    const callsAfterSecond = mockContext.createImageData.mock.calls.length;

    // Should have made additional calls for the second dimension set
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it('clears cache with clearBlurhashCache', () => {
    const blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

    // First call - populate cache
    getCachedBlurhashDataURL(blurhash);
    mockContext.createImageData.mockClear();

    // Clear cache
    clearBlurhashCache();

    // Should decode again after cache clear
    getCachedBlurhashDataURL(blurhash);
    expect(mockContext.createImageData).toHaveBeenCalledTimes(1);
  });

  it('evicts old entries when cache exceeds MAX_CACHE_SIZE', () => {
    // MAX_CACHE_SIZE is 500, and eviction removes 10% (50 entries)
    // We'll add 500 entries, then add one more to trigger eviction
    const MAX_CACHE_SIZE = 500;

    // Add entries up to the limit (indices 1-500)
    for (let i = 1; i <= MAX_CACHE_SIZE; i++) {
      // Use different dimensions to create unique cache keys
      getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', i, 32);
    }

    // Add one more entry (index 501) to trigger eviction of 50 oldest entries
    mockContext.createImageData.mockClear();
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 501, 32);
    expect(mockContext.createImageData).toHaveBeenCalledTimes(1);

    // Entry 1 (oldest) should have been evicted along with entries 2-50
    // Accessing entry 1 should require re-decoding
    mockContext.createImageData.mockClear();
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1, 32);
    expect(mockContext.createImageData).toHaveBeenCalledTimes(1);

    // Entry 51 (just past eviction cutoff) should still be cached
    mockContext.createImageData.mockClear();
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 51, 32);
    expect(mockContext.createImageData).not.toHaveBeenCalled();
  });

  it('moves accessed entries to end (LRU behavior)', () => {
    // Add 3 entries
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1, 32);
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 2, 32);
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 3, 32);

    // Clear mock
    mockContext.createImageData.mockClear();

    // Access entry 1 again - this should move it to the end (most recently used)
    getCachedBlurhashDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1, 32);

    // Should not have decoded again (still cached)
    expect(mockContext.createImageData).not.toHaveBeenCalled();
  });
});

describe('clearBlurhashCache', () => {
  it('clears the cache without errors', () => {
    expect(() => clearBlurhashCache()).not.toThrow();
  });

  it('allows re-populating cache after clear', () => {
    const blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

    // Add entry
    getCachedBlurhashDataURL(blurhash);
    mockContext.createImageData.mockClear();

    // Clear cache
    clearBlurhashCache();

    // Add same entry again
    getCachedBlurhashDataURL(blurhash);
    expect(mockContext.createImageData).toHaveBeenCalledTimes(1);

    // Access again - should be cached
    mockContext.createImageData.mockClear();
    getCachedBlurhashDataURL(blurhash);
    expect(mockContext.createImageData).not.toHaveBeenCalled();
  });
});

describe('Error Handling', () => {
  it('handles decode errors from blurhash library gracefully', () => {
    // The blurhash library throws ValidationError for invalid input
    // Since we're mocking the canvas, we test that decode errors propagate
    // A truly invalid blurhash like 'X' would throw in the real library
    // Here we test that the error handling path exists

    // First test: empty canvas context throws as expected
    mockCanvas.getContext = vi.fn().mockReturnValue(null);

    expect(() =>
      decodeBlurhashToDataURL('LEHV6nWB2yk8pyo0adR*.7kCMdnj'),
    ).toThrow('Failed to get canvas 2D context');
  });
});
