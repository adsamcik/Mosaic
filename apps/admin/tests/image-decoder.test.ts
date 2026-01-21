/**
 * Image Decoder Unit Tests
 *
 * Tests for the HEIC/HEIF decoding service and related functionality.
 * These tests focus on the logic and error handling rather than actual
 * HEIC decoding (which requires a browser environment with WASM support).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mimeDetection from '../src/lib/mime-type-detection';

// Mock the logger to avoid console noise
vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Create the mock function at module scope
const heicToMock = vi.fn();

// Mock heic-to/csp module with the hoisted mock (CSP-safe variant)
vi.mock('heic-to/csp', () => ({
  heicTo: heicToMock,
  isHeic: vi.fn().mockResolvedValue(true),
}));

describe('image-decoder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state between tests
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('prepareForBitmap', () => {
    it('returns original file for JPEG (no decoding needed)', async () => {
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const result = await prepareForBitmap(file, 'image/jpeg');
      
      expect(result).toBe(file);
    });

    it('returns original file for PNG (no decoding needed)', async () => {
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['test'], 'test.png', { type: 'image/png' });
      const result = await prepareForBitmap(file, 'image/png');
      
      expect(result).toBe(file);
    });

    it('returns original file for WebP (no decoding needed)', async () => {
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['test'], 'test.webp', { type: 'image/webp' });
      const result = await prepareForBitmap(file, 'image/webp');
      
      expect(result).toBe(file);
    });

    it('returns original file for AVIF (no decoding needed)', async () => {
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['test'], 'test.avif', { type: 'image/avif' });
      const result = await prepareForBitmap(file, 'image/avif');
      
      expect(result).toBe(file);
    });

    it('decodes HEIC files', async () => {
      const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
      heicToMock.mockResolvedValue(mockJpegBlob);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['heic-data'], 'test.heic', { type: 'image/heic' });
      const result = await prepareForBitmap(file, 'image/heic');
      
      expect(result).toBe(mockJpegBlob);
      expect(heicToMock).toHaveBeenCalledWith({
        blob: file,
        type: 'image/jpeg',
        quality: 0.95,
      });
    });

    it('decodes HEIF files', async () => {
      const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
      heicToMock.mockResolvedValue(mockJpegBlob);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['heif-data'], 'test.heif', { type: 'image/heif' });
      const result = await prepareForBitmap(file, 'image/heif');
      
      expect(result).toBe(mockJpegBlob);
      expect(heicToMock).toHaveBeenCalledWith({
        blob: file,
        type: 'image/jpeg',
        quality: 0.95,
      });
    });

    it('uses 0.95 quality for JPEG output (high quality for re-encoding)', async () => {
      const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
      heicToMock.mockResolvedValue(mockJpegBlob);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['heic-data'], 'test.heic', { type: 'image/heic' });
      await prepareForBitmap(file, 'image/heic');
      
      expect(heicToMock).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: 0.95,
        }),
      );
    });

    it('throws error when HEIC decoding returns null', async () => {
      heicToMock.mockResolvedValue(null);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['bad-heic'], 'test.heic', { type: 'image/heic' });
      
      await expect(prepareForBitmap(file, 'image/heic')).rejects.toThrow(
        'HEIC decoding returned empty result',
      );
    });

    it('throws error when HEIC decoding returns undefined', async () => {
      heicToMock.mockResolvedValue(undefined);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['bad-heic'], 'test.heic', { type: 'image/heic' });
      
      await expect(prepareForBitmap(file, 'image/heic')).rejects.toThrow(
        'HEIC decoding returned empty result',
      );
    });

    it('propagates heic-to library errors', async () => {
      const heicError = new Error('libheif: Invalid HEIC data');
      heicToMock.mockRejectedValue(heicError);
      
      const { prepareForBitmap } = await import('../src/lib/image-decoder');
      
      const file = new File(['corrupt-heic'], 'test.heic', { type: 'image/heic' });
      
      await expect(prepareForBitmap(file, 'image/heic')).rejects.toThrow(
        'libheif: Invalid HEIC data',
      );
    });
  });

  describe('isHeicDecodingAvailable', () => {
    it('returns true when heic-to loads successfully', async () => {
      heicToMock.mockResolvedValue(new Blob());
      
      const { isHeicDecodingAvailable } = await import(
        '../src/lib/image-decoder'
      );
      
      const result = await isHeicDecodingAvailable();
      expect(result).toBe(true);
    });
  });

  describe('needsDecoding export', () => {
    it('re-exports needsDecoding from mime-type-detection', async () => {
      const { needsDecoding } = await import('../src/lib/image-decoder');
      
      // These should match mime-type-detection behavior
      expect(needsDecoding('image/heic')).toBe(true);
      expect(needsDecoding('image/heif')).toBe(true);
      expect(needsDecoding('image/jpeg')).toBe(false);
      expect(needsDecoding('image/png')).toBe(false);
    });
  });
});

describe('mime-type-detection needsDecoding', () => {
  it('returns true for HEIC', () => {
    expect(mimeDetection.needsDecoding('image/heic')).toBe(true);
  });

  it('returns true for HEIF', () => {
    expect(mimeDetection.needsDecoding('image/heif')).toBe(true);
  });

  it('returns false for browser-native formats', () => {
    expect(mimeDetection.needsDecoding('image/jpeg')).toBe(false);
    expect(mimeDetection.needsDecoding('image/png')).toBe(false);
    expect(mimeDetection.needsDecoding('image/webp')).toBe(false);
    expect(mimeDetection.needsDecoding('image/gif')).toBe(false);
    expect(mimeDetection.needsDecoding('image/avif')).toBe(false);
  });

  it('handles case variations', () => {
    expect(mimeDetection.needsDecoding('IMAGE/HEIC')).toBe(true);
    expect(mimeDetection.needsDecoding('Image/Heif')).toBe(true);
  });
});
