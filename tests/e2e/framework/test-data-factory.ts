/**
 * Test Data Factory
 *
 * Factory methods for creating test data consistently across all E2E tests.
 * Supports both UI-based creation (for testing user flows) and API-based
 * creation (for faster test setup).
 */

import { type Page } from '@playwright/test';
import * as zlib from 'zlib';
import { API_URL, TEST_PASSWORD } from './constants';

// Re-export for backward compatibility
export { TEST_PASSWORD };

/**
 * Test image sizes for different use cases
 */
export type ImageSize = 'tiny' | 'small' | 'medium' | 'large';

/**
 * Image dimensions for each size
 */
const IMAGE_DIMENSIONS: Record<ImageSize, { width: number; height: number }> = {
  tiny: { width: 1, height: 1 },
  small: { width: 100, height: 100 },
  medium: { width: 800, height: 600 },
  large: { width: 1920, height: 1080 },
};

/**
 * Default colors per size for deterministic test images.
 * Used when no color is specified to ensure caching works.
 */
const DEFAULT_COLORS: Record<ImageSize, [number, number, number]> = {
  tiny: [255, 0, 0],     // red
  small: [0, 255, 0],   // green
  medium: [0, 0, 255],  // blue
  large: [255, 255, 0], // yellow
};

/**
 * Cache for generated test images to avoid repeated PNG generation.
 * Key format: `${size}-${r}-${g}-${b}`
 */
const imageCache = new Map<string, Buffer>();

/**
 * Generate a test image as a Buffer
 *
 * @param size - Image size preset
 * @param color - RGB color tuple (default: random)
 * @returns PNG image buffer
 */
export function generateTestImage(
  size: ImageSize = 'tiny',
  color?: [number, number, number]
): Buffer {
  // Use provided color or default color for this size (deterministic for caching)
  const [r, g, b] = color || DEFAULT_COLORS[size];
  
  // Generate cache key
  const cacheKey = `${size}-${r}-${g}-${b}`;
  
  // Return cached if available
  const cached = imageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let result: Buffer;
  
  // For tiny size, use the simple 1x1 PNG
  if (size === 'tiny') {
    // 1x1 red pixel PNG
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    result = Buffer.from(base64, 'base64');
  } else {
    // For larger sizes, we need to generate proper PNGs
    // This is a simplified approach - in production you'd use sharp or similar
    const { width, height } = IMAGE_DIMENSIONS[size];

    // Create a minimal valid PNG with solid color
    // This is a simplified implementation - for real use, consider using a library
    result = createSolidColorPNG(width, height, r, g, b);
  }
  
  // Cache before returning
  imageCache.set(cacheKey, result);
  return result;
}

/**
 * Create a solid color PNG image
 * Simplified implementation for test purposes
 */
function createSolidColorPNG(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number
): Buffer {
  // For simplicity in tests, we'll create a small image and repeat the pattern
  // A production implementation would use canvas or sharp

  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdrChunk = createPNGChunk('IHDR', ihdrData);

  // IDAT chunk (image data)
  // Create raw scanlines
  const scanlineLength = 1 + width * 3; // filter byte + RGB for each pixel
  const rawData = Buffer.alloc(height * scanlineLength);

  for (let y = 0; y < height; y++) {
    const offset = y * scanlineLength;
    rawData[offset] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const pixelOffset = offset + 1 + x * 3;
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
    }
  }

  // Compress with zlib
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createPNGChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createPNGChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Create a PNG chunk with proper structure
 */
function createPNGChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  // Calculate CRC32
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * CRC32 calculation for PNG chunks
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const table = getCRC32Table();

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Get or generate CRC32 lookup table
 */
let crcTable: number[] | null = null;
function getCRC32Table(): number[] {
  if (crcTable) return crcTable;

  crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
  }
  return crcTable;
}

/**
 * Album creation result
 */
export interface AlbumCreationResult {
  id: string;
  name: string;
}

/**
 * Ensure a user exists with proper auth credentials.
 * Uses the test API to create users with wrapped account keys so they can log in with passwords.
 * Returns true if the user was created, false if they already existed.
 */
export async function ensureUserExists(userEmail: string): Promise<boolean> {
  const response = await fetch(`${API_URL}/api/test-seed/create-authenticated-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: userEmail }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`[ensureUserExists] Warning: ${response.status} ${text}`);
    return false;
  }

  const data = await response.json();
  return data.wasCreated;
}

/**
 * Create an album via the backend API
 * Faster than UI but bypasses crypto.
 * 
 * IMPORTANT: In local auth mode, ensure the user is registered via the UI first (using loginUser)
 * before calling this function. The Remote-User header will auto-create a user if one doesn't exist,
 * but that user won't have proper crypto setup for password-based login.
 */
export async function createAlbumViaAPI(
  userEmail: string,
  name?: string
): Promise<AlbumCreationResult> {
  // NOTE: We do NOT call ensureUserExists here anymore.
  // In local auth mode, users must be registered via UI first to set up proper crypto.
  // The Remote-User header will auto-create the user if needed for proxy-auth mode.

  // Generate dummy crypto data - backend stores but doesn't validate crypto content
  const dummyBytes32 = Buffer.alloc(32).toString('base64');
  const dummyBytes64 = Buffer.alloc(64).toString('base64');

  const response = await fetch(`${API_URL}/api/albums`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Remote-User': userEmail,
    },
    body: JSON.stringify({
      initialEpochKey: {
        encryptedKeyBundle: dummyBytes32,
        ownerSignature: dummyBytes64,
        sharerPubkey: dummyBytes32,
        signPubkey: dummyBytes32,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create album: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json();
  return {
    id: data.id,
    name: name || `Album ${data.id.slice(0, 8)}`,
  };
}

/**
 * Delete an album via API
 */
export async function deleteAlbumViaAPI(
  userEmail: string,
  albumId: string
): Promise<void> {
  const response = await fetch(`${API_URL}/api/albums/${albumId}`, {
    method: 'DELETE',
    headers: {
      'Remote-User': userEmail,
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete album: ${response.status}`);
  }
}

/**
 * Get albums for a user via API
 */
export async function getAlbumsViaAPI(
  userEmail: string
): Promise<{ id: string; name?: string }[]> {
  const response = await fetch(`${API_URL}/api/albums`, {
    headers: {
      'Remote-User': userEmail,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get albums: ${response.status}`);
  }

  return response.json();
}

/**
 * Get current user info via API
 */
export async function getCurrentUserViaAPI(
  userEmail: string
): Promise<{ id: string; authSub: string }> {
  const response = await fetch(`${API_URL}/api/users/me`, {
    headers: {
      'Remote-User': userEmail,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get user: ${response.status}`);
  }

  return response.json();
}

/**
 * Check backend health
 */
export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for backend to be healthy with retries
 */
export async function waitForBackendHealth(
  timeoutMs: number = 30000,
  intervalMs: number = 1000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await checkBackendHealth()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Backend did not become healthy within ${timeoutMs}ms`);
}

/**
 * Set up file input for upload on a page
 * Returns a function to trigger the upload
 */
export async function prepareFileUpload(
  page: Page,
  fileBuffer: Buffer,
  filename: string
): Promise<() => Promise<void>> {
  const fileInput = page.getByTestId('upload-input');

  return async () => {
    await fileInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: fileBuffer,
    });
  };
}
