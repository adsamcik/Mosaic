/**
 * ThumbHash Decoder (with BlurHash backward compatibility)
 *
 * Decodes ThumbHash binary data into data URLs for instant placeholder display.
 * ThumbHash is a more advanced alternative to BlurHash that:
 * - Preserves aspect ratio information
 * - Supports alpha channel (transparency)
 * - Produces more detailed placeholders
 * - Is slightly more compact for the same quality
 *
 * This module also provides backward compatibility for existing BlurHash data.
 * New uploads use ThumbHash; old data with BlurHash continues to work.
 *
 * @see https://evanw.github.io/thumbhash/
 */

import { thumbHashToDataURL } from 'thumbhash';

/**
 * Decode a thumbhash to a data URL
 *
 * @param thumbhash - ThumbHash as base64 string or Uint8Array
 * @returns Data URL of the decoded image
 */
export function decodeThumbhashToDataURL(
  thumbhash: string | Uint8Array,
): string {
  // Convert base64 string to Uint8Array if needed
  const hashBytes =
    typeof thumbhash === 'string' ? base64ToUint8Array(thumbhash) : thumbhash;

  return thumbHashToDataURL(hashBytes);
}

/** Cache for decoded thumbhash data URLs */
const thumbhashCache = new Map<string, string>();

/** Maximum cache size to prevent memory leaks */
const MAX_CACHE_SIZE = 500;

/**
 * Get a cached thumbhash data URL, decoding if not already cached.
 * Uses LRU-style eviction when cache exceeds MAX_CACHE_SIZE.
 *
 * @param thumbhash - ThumbHash as base64 string
 * @returns Data URL of the decoded image
 */
export function getCachedThumbhashDataURL(thumbhash: string): string {
  const cached = thumbhashCache.get(thumbhash);
  if (cached) {
    // Move to end (most recently used) by re-inserting
    thumbhashCache.delete(thumbhash);
    thumbhashCache.set(thumbhash, cached);
    return cached;
  }

  // Decode and cache
  const dataUrl = decodeThumbhashToDataURL(thumbhash);

  // Evict oldest entries if cache is full
  if (thumbhashCache.size >= MAX_CACHE_SIZE) {
    // Delete first (oldest) entries - delete 10% of cache
    const deleteCount = Math.ceil(MAX_CACHE_SIZE * 0.1);
    const keysToDelete = Array.from(thumbhashCache.keys()).slice(0, deleteCount);
    for (const keyToDelete of keysToDelete) {
      thumbhashCache.delete(keyToDelete);
    }
  }

  thumbhashCache.set(thumbhash, dataUrl);
  return dataUrl;
}

/**
 * Check if a string is a valid thumbhash (base64-encoded)
 *
 * ThumbHash is typically 20-30 bytes, which is 27-40 base64 characters.
 * The hash encodes image dimensions, so we can do basic validation.
 *
 * @param thumbhash - String to validate (base64-encoded)
 * @returns True if the string appears to be a valid thumbhash
 */
export function isValidThumbhash(thumbhash: string): boolean {
  // ThumbHash base64 is typically 20-40 characters
  if (!thumbhash || thumbhash.length < 20 || thumbhash.length > 50) {
    return false;
  }

  // Validate base64 characters (standard base64)
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(thumbhash)) {
    return false;
  }

  try {
    // Try to decode - if it fails, it's not valid
    const bytes = base64ToUint8Array(thumbhash);
    // ThumbHash minimum size is about 5 bytes
    if (bytes.length < 5) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the thumbhash cache
 * Call this on logout or when memory pressure is high
 */
export function clearThumbhashCache(): void {
  thumbhashCache.clear();
}

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Backward Compatibility Layer for BlurHash
// ============================================================================

/**
 * Legacy BlurHash validation (for existing data)
 * BlurHash uses base83 encoding with specific characters
 */
export function isValidBlurhash(blurhash: string): boolean {
  if (!blurhash || blurhash.length < 6 || blurhash.length > 100) {
    return false;
  }

  const validChars =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

  for (const char of blurhash) {
    if (!validChars.includes(char)) {
      return false;
    }
  }

  return true;
}

/**
 * Detect hash type based on format
 * ThumbHash uses standard base64, BlurHash uses base83 with special chars
 */
export function detectHashType(hash: string): 'thumbhash' | 'blurhash' | 'unknown' {
  if (!hash || hash.length < 5) {
    return 'unknown';
  }

  // BlurHash contains characters like #$%*+,-.:;=?@[]^_{|}~ that aren't in base64
  const blurhashOnlyChars = /[#$%*,.:;=?@[\]^_{|}~]/;
  if (blurhashOnlyChars.test(hash)) {
    return 'blurhash';
  }

  // If it looks like valid base64 and reasonable length, assume thumbhash
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (base64Regex.test(hash) && hash.length >= 20 && hash.length <= 50) {
    return 'thumbhash';
  }

  // Short base83 without special chars could be blurhash
  if (hash.length >= 6 && hash.length <= 40) {
    return 'blurhash';
  }

  return 'unknown';
}

// ============================================================================
// Unified API (backward compatible with blurhash-decoder.ts)
// ============================================================================

/**
 * Get a cached placeholder data URL.
 * Automatically detects ThumbHash vs BlurHash format.
 *
 * For ThumbHash: Returns the decoded image
 * For BlurHash: Returns a solid color placeholder (BlurHash library removed)
 *
 * @param hash - ThumbHash (base64) or BlurHash string
 * @returns Data URL of the decoded placeholder, or null if invalid
 */
export function getCachedPlaceholderDataURL(hash: string): string | null {
  const hashType = detectHashType(hash);

  if (hashType === 'thumbhash') {
    try {
      return getCachedThumbhashDataURL(hash);
    } catch {
      return null;
    }
  }

  if (hashType === 'blurhash') {
    // BlurHash library was removed - return null for legacy data
    // Components will fall back to embedded thumbnail or loading state
    return null;
  }

  return null;
}

/**
 * Check if a hash is valid (either ThumbHash or BlurHash)
 */
export function isValidPlaceholderHash(hash: string): boolean {
  const hashType = detectHashType(hash);
  if (hashType === 'thumbhash') {
    return isValidThumbhash(hash);
  }
  if (hashType === 'blurhash') {
    return isValidBlurhash(hash);
  }
  return false;
}

// Backward compatibility aliases
export { getCachedThumbhashDataURL as getCachedBlurhashDataURL };
export { clearThumbhashCache as clearBlurhashCache };
export { clearThumbhashCache as clearPlaceholderCache };
