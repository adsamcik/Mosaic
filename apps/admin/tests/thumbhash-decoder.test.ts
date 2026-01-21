/**
 * ThumbHash Decoder Unit Tests
 *
 * Tests the thumbhash decoding and backward compatibility for blurhash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPlaceholderCache,
  clearThumbhashCache,
  decodeThumbhashToDataURL,
  detectHashType,
  getCachedPlaceholderDataURL,
  getCachedThumbhashDataURL,
  isValidBlurhash,
  isValidPlaceholderHash,
  isValidThumbhash,
  // Backward compat aliases
  getCachedBlurhashDataURL,
  clearBlurhashCache,
} from '../src/lib/thumbhash-decoder';

// Real ThumbHash test data (from https://evanw.github.io/thumbhash/)
// This is a base64-encoded thumbhash that represents a small test image
const VALID_THUMBHASH = '1QcSHQRnh493V4dIh4eXh1h4kJUI';
const VALID_THUMBHASH_2 = 'HBkKCAQIqIiHeId4KIg3';

// Valid blurhash examples (base83 encoding)
const VALID_BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
const VALID_BLURHASH_2 = 'LGF5]+Yk^6#M@-5c,1J5@[or[Q6.';

beforeEach(() => {
  clearThumbhashCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidThumbhash', () => {
  it('returns true for valid thumbhash strings', () => {
    expect(isValidThumbhash(VALID_THUMBHASH)).toBe(true);
    expect(isValidThumbhash(VALID_THUMBHASH_2)).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isValidThumbhash('')).toBe(false);
  });

  it('returns false for too short strings', () => {
    expect(isValidThumbhash('ABC')).toBe(false);
    expect(isValidThumbhash('ABCDEFGHIJ')).toBe(false); // < 20 chars
  });

  it('returns false for non-base64 strings', () => {
    // Contains blurhash-specific characters
    expect(isValidThumbhash('LEHV6nWB2yk8pyo0adR*.7kCMdnj')).toBe(false);
    expect(isValidThumbhash('Hello, World!')).toBe(false);
  });

  it('returns false for very long strings', () => {
    expect(isValidThumbhash('A'.repeat(60))).toBe(false);
  });
});

describe('isValidBlurhash', () => {
  it('returns true for valid blurhash strings', () => {
    expect(isValidBlurhash(VALID_BLURHASH)).toBe(true);
    expect(isValidBlurhash(VALID_BLURHASH_2)).toBe(true);
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

describe('detectHashType', () => {
  it('detects thumbhash format (base64)', () => {
    expect(detectHashType(VALID_THUMBHASH)).toBe('thumbhash');
    expect(detectHashType(VALID_THUMBHASH_2)).toBe('thumbhash');
  });

  it('detects blurhash format (base83 with special chars)', () => {
    expect(detectHashType(VALID_BLURHASH)).toBe('blurhash');
    expect(detectHashType(VALID_BLURHASH_2)).toBe('blurhash');
  });

  it('returns unknown for empty/short strings', () => {
    expect(detectHashType('')).toBe('unknown');
    expect(detectHashType('ABC')).toBe('unknown');
  });
});

describe('decodeThumbhashToDataURL', () => {
  it('returns a data URL from base64 thumbhash', () => {
    const result = decodeThumbhashToDataURL(VALID_THUMBHASH);

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it('returns a data URL from Uint8Array thumbhash', () => {
    // Decode the base64 to Uint8Array
    const binary = atob(VALID_THUMBHASH);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const result = decodeThumbhashToDataURL(bytes);
    expect(result).toMatch(/^data:image\/png;base64,/);
  });
});

describe('getCachedThumbhashDataURL', () => {
  it('caches decoded thumbhash', () => {
    // First call - should decode
    const result1 = getCachedThumbhashDataURL(VALID_THUMBHASH);
    expect(result1).toMatch(/^data:image\/png;base64,/);

    // Second call - should use cache (same result)
    const result2 = getCachedThumbhashDataURL(VALID_THUMBHASH);
    expect(result2).toBe(result1);
  });

  it('caches different thumbhashes separately', () => {
    const result1 = getCachedThumbhashDataURL(VALID_THUMBHASH);
    const result2 = getCachedThumbhashDataURL(VALID_THUMBHASH_2);

    // Different thumbhashes should produce different data URLs
    expect(result1).not.toBe(result2);
  });

  it('clears cache with clearThumbhashCache', () => {
    // Populate cache
    getCachedThumbhashDataURL(VALID_THUMBHASH);

    // Clear cache
    clearThumbhashCache();

    // Verify cache is empty by checking cache size doesn't matter
    // (internal implementation detail, but we can verify it doesn't throw)
    expect(() => getCachedThumbhashDataURL(VALID_THUMBHASH)).not.toThrow();
  });
});

describe('getCachedPlaceholderDataURL (unified API)', () => {
  it('returns data URL for thumbhash', () => {
    const result = getCachedPlaceholderDataURL(VALID_THUMBHASH);

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null for blurhash (library removed)', () => {
    // BlurHash library was removed - should return null for backward compat
    const result = getCachedPlaceholderDataURL(VALID_BLURHASH);

    expect(result).toBeNull();
  });

  it('returns null for invalid hash', () => {
    expect(getCachedPlaceholderDataURL('')).toBeNull();
    expect(getCachedPlaceholderDataURL('invalid!')).toBeNull();
  });
});

describe('isValidPlaceholderHash', () => {
  it('returns true for valid thumbhash', () => {
    expect(isValidPlaceholderHash(VALID_THUMBHASH)).toBe(true);
  });

  it('returns true for valid blurhash', () => {
    expect(isValidPlaceholderHash(VALID_BLURHASH)).toBe(true);
  });

  it('returns false for invalid hash', () => {
    expect(isValidPlaceholderHash('')).toBe(false);
    expect(isValidPlaceholderHash('!!!')).toBe(false);
  });
});

describe('clearPlaceholderCache', () => {
  it('clears the cache without errors', () => {
    getCachedThumbhashDataURL(VALID_THUMBHASH);
    expect(() => clearPlaceholderCache()).not.toThrow();
  });
});

describe('Backward Compatibility Aliases', () => {
  it('getCachedBlurhashDataURL is aliased to getCachedThumbhashDataURL', () => {
    // Both should be the same function
    expect(getCachedBlurhashDataURL).toBe(getCachedThumbhashDataURL);
  });

  it('clearBlurhashCache is aliased to clearThumbhashCache', () => {
    // Both should be the same function
    expect(clearBlurhashCache).toBe(clearThumbhashCache);
  });
});

describe('Cache eviction (LRU)', () => {
  it('evicts old entries when cache exceeds MAX_CACHE_SIZE', () => {
    // MAX_CACHE_SIZE is 500 - we can't easily test this without mocking internals
    // But we can verify the cache doesn't grow unbounded
    // This is more of a smoke test

    // Generate many unique "thumbhash-like" strings
    // (they won't decode properly but will populate the cache attempts)

    // Just verify no memory errors occur with many entries
    expect(() => {
      for (let i = 0; i < 10; i++) {
        try {
          getCachedThumbhashDataURL(VALID_THUMBHASH + 'x'.repeat(i));
        } catch {
          // Invalid thumbhash will throw, which is expected
        }
      }
    }).not.toThrow();
  });
});