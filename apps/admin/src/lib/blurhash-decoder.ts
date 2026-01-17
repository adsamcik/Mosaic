/**
 * BlurHash Decoder
 *
 * Decodes BlurHash strings into data URLs for instant placeholder display.
 * BlurHash is a compact representation of a blurred image (~30 chars)
 * that can be decoded client-side in <1ms.
 *
 * @see https://blurha.sh/
 */

import { decode } from 'blurhash';

/**
 * Decode a blurhash string to a data URL
 *
 * @param blurhash - BlurHash string (e.g., "LEHV6nWB2yk8pyo0adR*.7kCMdnj")
 * @param width - Output width in pixels (default: 32)
 * @param height - Output height in pixels (default: 32)
 * @param punch - Contrast multiplier (default: 1)
 * @returns Data URL of the decoded image
 */
export function decodeBlurhashToDataURL(
  blurhash: string,
  width = 32,
  height = 32,
  punch = 1,
): string {
  // Decode blurhash to pixel array (RGBA)
  const pixels = decode(blurhash, width, height, punch);

  // Create canvas and draw pixels
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas 2D context');
  }

  const imageData = ctx.createImageData(width, height);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);

  return canvas.toDataURL();
}

/** Cache for decoded blurhash data URLs */
const blurhashCache = new Map<string, string>();

/** Maximum cache size to prevent memory leaks */
const MAX_CACHE_SIZE = 500;

/**
 * Get a cached blurhash data URL, decoding if not already cached.
 * Uses LRU-style eviction when cache exceeds MAX_CACHE_SIZE.
 *
 * @param blurhash - BlurHash string
 * @param width - Output width in pixels (default: 32)
 * @param height - Output height in pixels (default: 32)
 * @returns Data URL of the decoded image
 */
export function getCachedBlurhashDataURL(
  blurhash: string,
  width = 32,
  height = 32,
): string {
  const key = `${blurhash}:${width}:${height}`;

  const cached = blurhashCache.get(key);
  if (cached) {
    // Move to end (most recently used) by re-inserting
    blurhashCache.delete(key);
    blurhashCache.set(key, cached);
    return cached;
  }

  // Decode and cache
  const dataUrl = decodeBlurhashToDataURL(blurhash, width, height);

  // Evict oldest entries if cache is full
  if (blurhashCache.size >= MAX_CACHE_SIZE) {
    // Delete first (oldest) entries - delete 10% of cache
    const deleteCount = Math.ceil(MAX_CACHE_SIZE * 0.1);
    const keysToDelete = Array.from(blurhashCache.keys()).slice(0, deleteCount);
    for (const keyToDelete of keysToDelete) {
      blurhashCache.delete(keyToDelete);
    }
  }

  blurhashCache.set(key, dataUrl);
  return dataUrl;
}

/**
 * Check if a string is a valid blurhash
 *
 * @param blurhash - String to validate
 * @returns True if the string appears to be a valid blurhash
 */
export function isValidBlurhash(blurhash: string): boolean {
  // BlurHash must be at least 6 characters (1x1 components)
  // and typically 20-30 characters for 4x3 components
  if (!blurhash || blurhash.length < 6 || blurhash.length > 100) {
    return false;
  }

  // BlurHash uses base83 encoding with specific characters
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
 * Clear the blurhash cache
 * Call this on logout or when memory pressure is high
 */
export function clearBlurhashCache(): void {
  blurhashCache.clear();
}
