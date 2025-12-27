/**
 * Thumbnail Generator Unit Tests
 *
 * Tests for the thumbnail generation service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateThumbnail,
  generateThumbnailBase64,
  isSupportedImageType,
  calculateDimensions,
  base64ToUint8Array,
  ThumbnailError,
} from '../src/lib/thumbnail-generator';

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

  it('returns false for unsupported types', () => {
    expect(isSupportedImageType('image/gif')).toBe(false);
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

    globalThis.createImageBitmap = vi.fn().mockImplementation(() => 
      Promise.resolve(createMockBitmap())
    );

    // Mock canvas context
    mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
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
    expect(result.width).toBe(300); // Scaled from 800
    expect(result.height).toBe(225); // Scaled proportionally from 600
    expect(result.originalWidth).toBe(800);
    expect(result.originalHeight).toBe(600);
    expect(result.data).toBeInstanceOf(Uint8Array);
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
    const file = new File(['fake-image-data'], 'test.gif', {
      type: 'image/gif',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      'Unsupported image type: image/gif'
    );
  });

  it('throws ThumbnailError for invalid maxSize', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file, { maxSize: 0 })).rejects.toThrow(
      ThumbnailError
    );
    await expect(generateThumbnail(file, { maxSize: -1 })).rejects.toThrow(
      'Invalid maxSize: -1'
    );
  });

  it('throws ThumbnailError for invalid quality', async () => {
    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file, { quality: 0 })).rejects.toThrow(
      ThumbnailError
    );
    await expect(generateThumbnail(file, { quality: 1.5 })).rejects.toThrow(
      'Invalid quality: 1.5'
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
      'Failed to decode image'
    );
  });

  it('throws ThumbnailError when canvas context is null', async () => {
    mockCanvas.getContext = vi.fn().mockReturnValue(null);

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    await expect(generateThumbnail(file)).rejects.toThrow(ThumbnailError);
    await expect(generateThumbnail(file)).rejects.toThrow(
      'Failed to get canvas 2D context'
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
      'Failed to encode thumbnail as JPEG'
    );
  });

  it('handles small images without scaling', async () => {
    mockBitmapWidth = 200;
    mockBitmapHeight = 150;

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  it('handles portrait images correctly', async () => {
    mockBitmapWidth = 600;
    mockBitmapHeight = 800;

    const file = new File(['fake-image-data'], 'test.jpg', {
      type: 'image/jpeg',
    });

    const result = await generateThumbnail(file);

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

    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('reduces quality if thumbnail exceeds 50KB', async () => {
    let callCount = 0;
    mockCanvas.toBlob = vi.fn((callback: BlobCallback) => {
      callCount++;
      // First call returns large blob, subsequent calls return smaller
      const size = callCount === 1 ? 60000 : 40000;
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
    expect(result.data.length).toBeLessThanOrEqual(50 * 1024);
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
