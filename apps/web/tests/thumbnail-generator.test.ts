/**
 * Thumbnail Generator Unit Tests
 *
 * Tests for the thumbnail generation service including three-tier image generation.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  base64ToUint8Array,
  calculateDimensions,
  generateThumbnail,
  generateThumbnailBase64,
  generateTieredImages,
  isSupportedImageType,
  ThumbnailError,
  type TieredImageResult,
} from '../src/lib/thumbnail-generator';
import {
  ShardTier,
} from '../../../libs/crypto/src';

// Mock settings service - default to preserving original format in tests for predictable behavior
vi.mock('../src/lib/settings-service', () => ({
  shouldStoreOriginalsAsAvif: vi.fn(() => false),
}));
vi.mock('../src/generated/mosaic-wasm/mosaic_wasm.js', () => {
  const dim = (width: number, height: number, tier: number) => ({
    width,
    height,
    tier,
    free: vi.fn(),
  });
  return {
    default: vi.fn().mockResolvedValue(undefined),
    canonicalTierLayout: vi.fn(() => ({
      code: 0,
      get thumbnail() { return dim(256, 256, 1); },
      get preview() { return dim(1024, 1024, 2); },
      get original() { return dim(4096, 4096, 3); },
      free: vi.fn(),
    })),
  };
});

beforeAll(async () => {
  await sodium.ready;
});

// =============================================================================
// Helper Functions Tests
// =============================================================================

describe('isSupportedImageType', () => {
  it('returns true for JPEG', () => {
    expect(isSupportedImageType('image/jpeg')).toBe(true);
  });

  it('returns true for PNG', () => {
    expect(isSupportedImageType('image/png')).toBe(true);
  });

  it('returns true for WebP', () => {
    expect(isSupportedImageType('image/webp')).toBe(true);
  });

  it('returns true for HEIC', () => {
    expect(isSupportedImageType('image/heic')).toBe(true);
  });

  it('returns true for HEIF', () => {
    expect(isSupportedImageType('image/heif')).toBe(true);
  });

  it('returns true for AVIF', () => {
    expect(isSupportedImageType('image/avif')).toBe(true);
  });

  it('returns true for GIF', () => {
    expect(isSupportedImageType('image/gif')).toBe(true);
  });

  it('returns true for BMP', () => {
    expect(isSupportedImageType('image/bmp')).toBe(true);
  });

  it('returns false for unsupported types', () => {
    expect(isSupportedImageType('image/svg+xml')).toBe(false);
    expect(isSupportedImageType('text/plain')).toBe(false);
    expect(isSupportedImageType('application/pdf')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isSupportedImageType('IMAGE/JPEG')).toBe(true);
    expect(isSupportedImageType('Image/Png')).toBe(true);
  });
});

describe('calculateDimensions', () => {
  const maxSize = 300;

  it('returns original dimensions if both are smaller than max', () => {
    expect(calculateDimensions(200, 150, maxSize)).toEqual({
      width: 200,
      height: 150,
    });
  });

  it('returns original dimensions if exactly at max', () => {
    expect(calculateDimensions(300, 300, maxSize)).toEqual({
      width: 300,
      height: 300,
    });
  });

  it('scales down landscape image maintaining aspect ratio', () => {
    // 600x400 -> 300x200
    const result = calculateDimensions(600, 400, maxSize);
    expect(result.width).toBe(300);
    expect(result.height).toBe(200);
  });

  it('scales down portrait image maintaining aspect ratio', () => {
    // 400x600 -> 200x300
    const result = calculateDimensions(400, 600, maxSize);
    expect(result.width).toBe(200);
    expect(result.height).toBe(300);
  });

  it('scales down square image', () => {
    // 600x600 -> 300x300
    const result = calculateDimensions(600, 600, maxSize);
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('handles extreme aspect ratios', () => {
    // Very wide: 1000x100 -> 300x30
    const wide = calculateDimensions(1000, 100, maxSize);
    expect(wide.width).toBe(300);
    expect(wide.height).toBe(30);

    // Very tall: 100x1000 -> 30x300
    const tall = calculateDimensions(100, 1000, maxSize);
    expect(tall.width).toBe(30);
    expect(tall.height).toBe(300);
  });

  it('handles custom max sizes', () => {
    const result = calculateDimensions(1000, 500, 200);
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });
});

describe('base64ToUint8Array', () => {
  it('converts base64 to Uint8Array', () => {
    // Base64 of "Hello" is "SGVsbG8="
    const result = base64ToUint8Array('SGVsbG8=');
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it('handles empty string', () => {
    const result = base64ToUint8Array('');
    expect(result).toEqual(new Uint8Array([]));
  });

  it('handles binary data', () => {
    // Base64 of bytes [0, 1, 255]
    const result = base64ToUint8Array('AAH/');
    expect(result).toEqual(new Uint8Array([0, 1, 255]));
  });
});

// =============================================================================
// ThumbnailError Tests
// =============================================================================

describe('ThumbnailError', () => {
  it('creates error with message', () => {
    const error = new ThumbnailError('Failed to decode');
    expect(error.message).toBe('Failed to decode');
    expect(error.name).toBe('ThumbnailError');
    expect(error.cause).toBeUndefined();
  });

  it('creates error with cause', () => {
    const cause = new Error('Original error');
    const error = new ThumbnailError('Failed to decode', cause);
    expect(error.message).toBe('Failed to decode');
    expect(error.cause).toBe(cause);
  });

  it('is instanceof Error', () => {
    const error = new ThumbnailError('test');
    expect(error).toBeInstanceOf(Error);
  });
});

// =============================================================================
// generateThumbnail Tests (with mocks)
// =============================================================================

describe('generateThumbnail', () => {
  // Store original implementations
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalCreateElement = document.createElement.bind(document);

  let mockCanvas: HTMLCanvasElement;
  let mockContext: CanvasRenderingContext2D;
  let mockBitmapWidth = 800;
  let mockBitmapHeight = 600;

  function createMockBitmap(): ImageBitmap {
    return {
      width: mockBitmapWidth,
      height: mockBitmapHeight,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockBitmapWidth = 800;
    mockBitmapHeight = 600;

    globalThis.createImageBitmap = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockBitmap()));

    // Mock canvas context
    mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128), // 32x32 gray image
        width: 32,
        height: 32,
      }),
      createImageData: vi
        .fn()
        .mockImplementation((width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    // Mock canvas
    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn((callback: BlobCallback) => {
        const mockBlob = new Blob(['mock-jpeg-data'], { type: 'image/jpeg' });
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    // Mock document.createElement
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return mockCanvas;
      }
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('generates thumbnail from JPEG file', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(file);
    // Default is now 300px for embedded manifest thumbnails (crisp at 200-220px gallery rows)
    expect(result.width).toBe(300); // Scaled from 800
    expect(result.height).toBe(225); // Scaled proportionally from 600
    expect(result.originalWidth).toBe(800);
    expect(result.originalHeight).toBe(600);
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.thumbhash).toBeDefined();
    expect(typeof result.thumbhash).toBe('string');
    // ThumbHash is base64-encoded, typically 27-40 characters
    expect(result.thumbhash.length).toBeGreaterThan(20);
  });

  it('generates thumbhash with valid base64 format', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    // ThumbHash should be a base64 string between 20-50 characters
    expect(result.thumbhash.length).toBeGreaterThanOrEqual(20);
    expect(result.thumbhash.length).toBeLessThanOrEqual(50);

    // ThumbHash uses standard base64 encoding
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    expect(base64Regex.test(result.thumbhash)).toBe(true);
  });

  it('generates thumbnail from PNG file', async () => {
    const file = new File(['fake-image-data'], 'test.png', {
      type: 'image/png',
    });

    const result = await generateThumbnail(file);

    expect(result.data).toBeInstanceOf(Uint8Array);
  });

  it('generates thumbnail from WebP file', async () => {
    const file = new File(['fake-image-data'], 'test.webp', {
      type: 'image/webp',
    });

    const result = await generateThumbnail(file);

    expect(result.data).toBeInstanceOf(Uint8Array);
  });

  it('uses custom max size', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file, { maxSize: 200 });

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  it('uses custom quality', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await generateThumbnail(file, { quality: 0.5 });

    // toBlob should be called - we can't easily verify quality was passed
    expect(mockCanvas.toBlob).toHaveBeenCalled();
  });

  it('throws ThumbnailError for unsupported file type', async () => {
    const file = new File(['fake-image-data'], 'test.svg', {
      type: 'image/svg+xml',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      'Unsupported image type: image/svg+xml',
    );
  });

  it('throws ThumbnailError for invalid maxSize', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file, { maxSize: 0 })).rejects.toThrow(
      ThumbnailError,
    );
    await expect(generateThumbnail(file, { maxSize: -1 })).rejects.toThrow(
      'Invalid maxSize: -1',
    );
  });

  it('throws ThumbnailError for invalid quality', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file, { quality: 0 })).rejects.toThrow(
      ThumbnailError,
    );
    await expect(generateThumbnail(file, { quality: 1.5 })).rejects.toThrow(
      'Invalid quality: 1.5',
    );
  });

  it('throws ThumbnailError when createImageBitmap fails', async () => {
    globalThis.createImageBitmap = vi
      .fn()
      .mockRejectedValue(new Error('Decode error'));

    const file = new File(['invalid-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      'Failed to decode image',
    );
  });

  it('throws ThumbnailError when canvas context is null', async () => {
    mockCanvas.getContext = vi.fn().mockReturnValue(null);

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      'Failed to get canvas 2D context',
    );
  });

  it('throws ThumbnailError when toBlob returns null', async () => {
    mockCanvas.toBlob = vi.fn((callback: BlobCallback) => {
      callback(null);
    });

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      /Failed to encode thumbnail as image\/(jpeg|webp)/,
    );
  });

  it('handles small images without scaling', async () => {
    mockBitmapWidth = 100;
    mockBitmapHeight = 75;

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    // Small images smaller than 150px max should not be scaled
    expect(result.width).toBe(100);
    expect(result.height).toBe(75);
  });

  it('handles portrait images correctly', async () => {
    mockBitmapWidth = 600;
    mockBitmapHeight = 800;

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    // Portrait: 600x800 scaled to 300px max -> 225x300
    expect(result.width).toBe(225);
    expect(result.height).toBe(300);
  });

  it('handles square images correctly', async () => {
    mockBitmapWidth = 500;
    mockBitmapHeight = 500;

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    // Square: 500x500 scaled to 300px max -> 300x300
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('reduces quality if thumbnail exceeds 25KB (embedded max)', async () => {
    let callCount = 0;
    mockCanvas.toBlob = vi.fn((callback: BlobCallback) => {
      callCount++;
      // First call returns large blob, subsequent calls return smaller
      const size = callCount === 1 ? 30000 : 20000;
      const data = new Uint8Array(size).fill(0);
      const mockBlob = new Blob([data], { type: 'image/jpeg' });
      callback(mockBlob);
    });

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    // toBlob should be called at least twice (once with original quality,
    // once with reduced quality)
    expect(callCount).toBeGreaterThan(1);
    expect(result.data.length).toBeLessThanOrEqual(25 * 1024);
  });
});

// =============================================================================
// generateThumbnailBase64 Tests
// =============================================================================

describe('generateThumbnailBase64', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    vi.clearAllMocks();

    const mockImageBitmap = {
      width: 400,
      height: 300,
      close: vi.fn(),
    } as unknown as ImageBitmap;

    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockImageBitmap);

    const mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        width: 32,
        height: 32,
      }),
      createImageData: vi
        .fn()
        .mockImplementation((width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn((callback: BlobCallback) => {
        const mockBlob = new Blob(['JPEG'], { type: 'image/jpeg' });
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return mockCanvas;
      }
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('returns base64-encoded thumbnail', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnailBase64(file);

    expect(typeof result).toBe('string');
    // Base64 should be decodable
    expect(() => atob(result)).not.toThrow();
  });

  it('passes options to generateThumbnail', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnailBase64(file, {
      maxSize: 150,
      quality: 0.6,
    });

    expect(typeof result).toBe('string');
  });
});

// =============================================================================
// generateTieredImages Tests
// =============================================================================

/**
 * Helper to create a File from Uint8Array (works around TypeScript type issues)
 */
function createTestFile(data: Uint8Array, name: string, type: string): File {
  // Use ArrayBuffer.prototype.slice to create a new ArrayBuffer that TypeScript accepts
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  return new File([buffer], name, { type });
}

describe('generateTieredImages', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalCreateElement = document.createElement.bind(document);

  let mockCanvas: HTMLCanvasElement;
  let mockContext: CanvasRenderingContext2D;
  let mockBitmapWidth = 2000;
  let mockBitmapHeight = 1500;
  let mockFileData: Uint8Array;

  function createMockBitmap(): ImageBitmap {
    return {
      width: mockBitmapWidth,
      height: mockBitmapHeight,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockBitmapWidth = 2000;
    mockBitmapHeight = 1500;
    mockFileData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    globalThis.createImageBitmap = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockBitmap()));

    // Mock canvas context
    mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128), // 32x32 gray image
        width: 32,
        height: 32,
      }),
      createImageData: vi
        .fn()
        .mockImplementation((width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    // Mock canvas
    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn((callback: BlobCallback) => {
        const mockBlob = new Blob(['mock-jpeg-data'], { type: 'image/jpeg' });
        callback(mockBlob);
      }),
    } as unknown as HTMLCanvasElement;

    // Mock document.createElement
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return mockCanvas;
      }
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('generates three tiers from JPEG file', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    expect(result.thumbnail).toBeDefined();
    expect(result.preview).toBeDefined();
    expect(result.original).toBeDefined();
    expect(result.originalWidth).toBe(2000);
    expect(result.originalHeight).toBe(1500);
  });

  it('thumbnail tier has correct tier value', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    expect(result.thumbnail.tier).toBe(ShardTier.THUMB);
    expect(result.preview.tier).toBe(ShardTier.PREVIEW);
    expect(result.original.tier).toBe(ShardTier.ORIGINAL);
  });

  it('thumbnail is scaled to canonical max dimension', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    // 2000x1500 scaled to 256px max -> 256x192
    expect(result.thumbnail.width).toBe(256);
    expect(result.thumbnail.height).toBe(192);
  });

  it('preview is scaled to canonical max dimension', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    // 2000x1500 scaled to 1024px max -> 1024x768
    expect(result.preview.width).toBe(1024);
    expect(result.preview.height).toBe(768);
  });

  it('original preserves full dimensions', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    expect(result.original.width).toBe(2000);
    expect(result.original.height).toBe(1500);
  });

  it('original contains the unmodified file data', async () => {
    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    expect(result.original.data).toEqual(mockFileData);
  });

  it('handles portrait images correctly', async () => {
    mockBitmapWidth = 1500;
    mockBitmapHeight = 2000;

    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    // Portrait: 1500x2000 scaled to 256px max -> 192x256
    expect(result.thumbnail.width).toBe(192);
    expect(result.thumbnail.height).toBe(256);

    // Portrait: 1500x2000 scaled to 1024px max -> 768x1024
    expect(result.preview.width).toBe(768);
    expect(result.preview.height).toBe(1024);
  });

  it('handles small images without upscaling', async () => {
    mockBitmapWidth = 200;
    mockBitmapHeight = 150;

    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    const result = await generateTieredImages(file);

    // Small images should not be upscaled
    expect(result.thumbnail.width).toBe(200);
    expect(result.thumbnail.height).toBe(150);
    expect(result.preview.width).toBe(200);
    expect(result.preview.height).toBe(150);
    expect(result.original.width).toBe(200);
    expect(result.original.height).toBe(150);
  });

  it('throws ThumbnailError for unsupported file type', async () => {
    // Create actual SVG content that will be detected as SVG by magic bytes
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const svgData = new TextEncoder().encode(svgContent);
    const file = createTestFile(svgData, 'test.svg', 'image/svg+xml');

    await expect(generateTieredImages(file)).rejects.toThrow(ThumbnailError);
    await expect(generateTieredImages(file)).rejects.toThrow(
      'Unsupported image type: image/svg+xml',
    );
  });

  it('throws ThumbnailError when createImageBitmap fails', async () => {
    globalThis.createImageBitmap = vi
      .fn()
      .mockRejectedValue(new Error('Decode error'));

    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    await expect(generateTieredImages(file)).rejects.toThrow(ThumbnailError);
    await expect(generateTieredImages(file)).rejects.toThrow(
      'Failed to decode image',
    );
  });

  it('throws ThumbnailError when canvas context is null', async () => {
    mockCanvas.getContext = vi.fn().mockReturnValue(null);

    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    await expect(generateTieredImages(file)).rejects.toThrow(ThumbnailError);
    await expect(generateTieredImages(file)).rejects.toThrow(
      'Failed to get canvas 2D context',
    );
  });

  it('closes the bitmap after processing', async () => {
    const mockBitmap = createMockBitmap();
    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

    const file = createTestFile(mockFileData, 'test.jpg', 'image/jpeg');

    await generateTieredImages(file);

    expect(mockBitmap.close).toHaveBeenCalled();
  });
});
