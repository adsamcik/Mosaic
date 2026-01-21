/**
 * Format Conversion Pipeline Tests
 *
 * Tests the complete image format conversion pipeline, validating that every
 * supported input format (JPEG, PNG, WebP, HEIC, HEIF, GIF, BMP, AVIF) can be
 * correctly converted to each target output format (AVIF, JPEG, WebP).
 *
 * These tests validate:
 * 1. Input format detection and acceptance
 * 2. HEIC/HEIF decoding via heic-to library
 * 3. Canvas-based conversion to target formats
 * 4. Output format selection logic (AVIF > WebP > JPEG fallback)
 * 5. Format-specific quality and compression settings
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the logger to avoid console noise
vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock settings service - can be overridden in tests
const mockShouldStoreOriginalsAsAvif = vi.fn(() => true);
vi.mock('../src/lib/settings-service', () => ({
  shouldStoreOriginalsAsAvif: () => mockShouldStoreOriginalsAsAvif(),
}));

// Create the mock function for heic-to at module scope
const heicToMock = vi.fn();
vi.mock('heic-to/csp', () => ({
  heicTo: heicToMock,
  isHeic: vi.fn().mockResolvedValue(true),
}));

// =============================================================================
// Supported Formats Matrix
// =============================================================================

/** All supported input formats */
const SUPPORTED_INPUT_FORMATS = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/gif',
  'image/bmp',
] as const;

/** All supported output formats */
const SUPPORTED_OUTPUT_FORMATS = [
  'image/avif',
  'image/webp',
  'image/jpeg',
] as const;

type InputFormat = (typeof SUPPORTED_INPUT_FORMATS)[number];
type OutputFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number];

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock File with the given MIME type
 */
function createMockFile(mimeType: string, name?: string): File {
  const extension = mimeType.split('/')[1] || 'bin';
  const fileName = name || `test.${extension}`;
  return new File(['fake-image-data'], fileName, { type: mimeType });
}

/**
 * Create mock canvas infrastructure for testing
 */
function setupMockCanvas(outputFormat: OutputFormat) {
  const mockContext = {
    drawImage: vi.fn(),
    transform: vi.fn(),
    getImageData: vi.fn().mockReturnValue({
      data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
      width: 32,
      height: 32,
    }),
    createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D;

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(mockContext),
    toBlob: vi.fn((callback: BlobCallback, format: string, _quality: number) => {
      // Return blob with the requested format
      const mockBlob = new Blob(['mock-output-data'], { type: format });
      callback(mockBlob);
    }),
    toDataURL: vi.fn((format: string) => {
      // Return data URL with requested format for format detection
      return `data:${format};base64,AAAA`;
    }),
  } as unknown as HTMLCanvasElement;

  return { mockCanvas, mockContext };
}

// =============================================================================
// Input Format Acceptance Tests
// =============================================================================

describe('Input Format Acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isSupportedImageType', () => {
    it.each(SUPPORTED_INPUT_FORMATS)(
      'accepts %s as valid input format',
      async (format) => {
        const { isSupportedImageType } = await import(
          '../src/lib/thumbnail-generator'
        );
        expect(isSupportedImageType(format)).toBe(true);
      },
    );

    it('rejects unsupported formats', async () => {
      const { isSupportedImageType } = await import(
        '../src/lib/thumbnail-generator'
      );

      const unsupportedFormats = [
        'image/svg+xml',
        'image/tiff',
        'text/plain',
        'application/pdf',
        'video/mp4',
      ];

      for (const format of unsupportedFormats) {
        expect(isSupportedImageType(format)).toBe(false);
      }
    });

    it('handles case-insensitive MIME types', async () => {
      const { isSupportedImageType } = await import(
        '../src/lib/thumbnail-generator'
      );

      expect(isSupportedImageType('IMAGE/JPEG')).toBe(true);
      expect(isSupportedImageType('Image/Png')).toBe(true);
      expect(isSupportedImageType('image/HEIC')).toBe(true);
    });
  });
});

// =============================================================================
// HEIC/HEIF Decoding Tests (Pre-conversion step)
// =============================================================================

describe('HEIC/HEIF Pre-conversion Decoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes HEIC to JPEG before canvas processing', async () => {
    const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    heicToMock.mockResolvedValue(mockJpegBlob);

    const { prepareForBitmap } = await import('../src/lib/image-decoder');
    const file = createMockFile('image/heic');
    const result = await prepareForBitmap(file, 'image/heic');

    expect(heicToMock).toHaveBeenCalledWith({
      blob: file,
      type: 'image/jpeg',
      quality: 0.95,
    });
    expect(result).toBe(mockJpegBlob);
  });

  it('decodes HEIF to JPEG before canvas processing', async () => {
    const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    heicToMock.mockResolvedValue(mockJpegBlob);

    const { prepareForBitmap } = await import('../src/lib/image-decoder');
    const file = createMockFile('image/heif');
    const result = await prepareForBitmap(file, 'image/heif');

    expect(heicToMock).toHaveBeenCalledWith({
      blob: file,
      type: 'image/jpeg',
      quality: 0.95,
    });
    expect(result).toBe(mockJpegBlob);
  });

  it('passes through browser-native formats without decoding', async () => {
    const { prepareForBitmap } = await import('../src/lib/image-decoder');

    const nativeFormats: InputFormat[] = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/bmp',
      'image/avif',
    ];

    for (const format of nativeFormats) {
      heicToMock.mockClear();
      const file = createMockFile(format);
      const result = await prepareForBitmap(file, format);

      expect(result).toBe(file);
      expect(heicToMock).not.toHaveBeenCalled();
    }
  });
});

// =============================================================================
// Output Format Selection Tests
// =============================================================================

describe('Output Format Selection', () => {
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPreferredImageFormat', () => {
    it('returns AVIF when browser supports AVIF encoding', async () => {
      // Mock AVIF support
      const { mockCanvas } = setupMockCanvas('image/avif');
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return originalCreateElement(tag);
      });

      // Reset caches and import fresh module
      const thumbnailGenerator = await import('../src/lib/thumbnail-generator');
      thumbnailGenerator._resetAVIFCache();
      thumbnailGenerator._resetWebPCache();

      const format = thumbnailGenerator.getPreferredImageFormat();
      expect(format).toBe('image/avif');
    });

    it('returns WebP when AVIF unsupported but WebP supported', async () => {
      // Mock canvas that returns WebP but not AVIF
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({}),
        toDataURL: vi.fn((format: string) => {
          if (format === 'image/avif') return 'data:image/png;base64,'; // Not AVIF
          if (format === 'image/webp') return 'data:image/webp;base64,AAAA';
          return 'data:image/png;base64,';
        }),
      } as unknown as HTMLCanvasElement;

      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return originalCreateElement(tag);
      });

      const thumbnailGenerator = await import('../src/lib/thumbnail-generator');
      thumbnailGenerator._resetAVIFCache();
      thumbnailGenerator._resetWebPCache();

      const format = thumbnailGenerator.getPreferredImageFormat();
      expect(format).toBe('image/webp');
    });

    it('returns JPEG as fallback when neither AVIF nor WebP supported', async () => {
      // Mock canvas that doesn't support AVIF or WebP
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({}),
        toDataURL: vi.fn(() => 'data:image/png;base64,'), // Always PNG fallback
      } as unknown as HTMLCanvasElement;

      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return originalCreateElement(tag);
      });

      const thumbnailGenerator = await import('../src/lib/thumbnail-generator');
      thumbnailGenerator._resetAVIFCache();
      thumbnailGenerator._resetWebPCache();

      const format = thumbnailGenerator.getPreferredImageFormat();
      expect(format).toBe('image/jpeg');
    });
  });
});

// =============================================================================
// Format Conversion Pipeline Tests
// =============================================================================

describe('Format Conversion Pipeline', () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  let mockCanvas: HTMLCanvasElement;
  let mockContext: CanvasRenderingContext2D;
  let capturedOutputFormat: string | null = null;

  function createMockBitmap(width = 800, height = 600): ImageBitmap {
    return {
      width,
      height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    capturedOutputFormat = null;

    // Mock createImageBitmap
    globalThis.createImageBitmap = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockBitmap()));

    // Mock canvas context
    mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        width: 32,
        height: 32,
      }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    // Mock canvas with format capture
    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn(
        (callback: BlobCallback, format: string, _quality: number) => {
          capturedOutputFormat = format;
          const mockBlob = new Blob(['mock-output-data'], { type: format });
          callback(mockBlob);
        },
      ),
      toDataURL: vi.fn((format: string) => {
        // Simulate AVIF support for tests
        return `data:${format};base64,AAAA`;
      }),
    } as unknown as HTMLCanvasElement;

    // Mock document.createElement
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  describe('Browser-native formats to AVIF (default)', () => {
    const browserNativeFormats: InputFormat[] = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/bmp',
      'image/avif',
    ];

    it.each(browserNativeFormats)(
      'converts %s to AVIF output',
      async (inputFormat) => {
        const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
          await import('../src/lib/thumbnail-generator');
        _resetAVIFCache();
        _resetWebPCache();

        const file = createMockFile(inputFormat);
        await generateThumbnail(file);

        expect(globalThis.createImageBitmap).toHaveBeenCalledWith(file);
        expect(capturedOutputFormat).toBe('image/avif');
      },
    );
  });

  describe('HEIC/HEIF to AVIF (with pre-decoding)', () => {
    it('converts HEIC to AVIF via JPEG intermediate', async () => {
      const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
      heicToMock.mockResolvedValue(mockJpegBlob);

      const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
        await import('../src/lib/thumbnail-generator');
      _resetAVIFCache();
      _resetWebPCache();

      const file = createMockFile('image/heic');
      await generateThumbnail(file);

      // Should decode HEIC first
      expect(heicToMock).toHaveBeenCalledWith({
        blob: file,
        type: 'image/jpeg',
        quality: 0.95,
      });

      // Then use decoded JPEG blob for bitmap
      expect(globalThis.createImageBitmap).toHaveBeenCalledWith(mockJpegBlob);

      // Output should be AVIF
      expect(capturedOutputFormat).toBe('image/avif');
    });

    it('converts HEIF to AVIF via JPEG intermediate', async () => {
      const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
      heicToMock.mockResolvedValue(mockJpegBlob);

      const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
        await import('../src/lib/thumbnail-generator');
      _resetAVIFCache();
      _resetWebPCache();

      const file = createMockFile('image/heif');
      await generateThumbnail(file);

      expect(heicToMock).toHaveBeenCalled();
      expect(capturedOutputFormat).toBe('image/avif');
    });
  });

  describe('Fallback to WebP when AVIF unsupported', () => {
    beforeEach(() => {
      // Override toDataURL to simulate no AVIF support
      mockCanvas.toDataURL = vi.fn((format: string) => {
        if (format === 'image/avif') return 'data:image/png;base64,'; // Fallback = no support
        if (format === 'image/webp') return 'data:image/webp;base64,AAAA';
        return 'data:image/png;base64,';
      });
    });

    it.each(SUPPORTED_INPUT_FORMATS)(
      'converts %s to WebP when AVIF unsupported',
      async (inputFormat) => {
        // Setup HEIC mock if needed
        if (inputFormat === 'image/heic' || inputFormat === 'image/heif') {
          heicToMock.mockResolvedValue(
            new Blob(['jpeg-data'], { type: 'image/jpeg' }),
          );
        }

        const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
          await import('../src/lib/thumbnail-generator');
        _resetAVIFCache();
        _resetWebPCache();

        const file = createMockFile(inputFormat);
        await generateThumbnail(file);

        expect(capturedOutputFormat).toBe('image/webp');
      },
    );
  });

  describe('Fallback to JPEG when neither AVIF nor WebP supported', () => {
    beforeEach(() => {
      // Override toDataURL to simulate no AVIF or WebP support
      mockCanvas.toDataURL = vi.fn(() => 'data:image/png;base64,');
    });

    it.each(SUPPORTED_INPUT_FORMATS)(
      'converts %s to JPEG when AVIF/WebP unsupported',
      async (inputFormat) => {
        // Setup HEIC mock if needed
        if (inputFormat === 'image/heic' || inputFormat === 'image/heif') {
          heicToMock.mockResolvedValue(
            new Blob(['jpeg-data'], { type: 'image/jpeg' }),
          );
        }

        const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
          await import('../src/lib/thumbnail-generator');
        _resetAVIFCache();
        _resetWebPCache();

        const file = createMockFile(inputFormat);
        await generateThumbnail(file);

        expect(capturedOutputFormat).toBe('image/jpeg');
      },
    );
  });
});

// =============================================================================
// Tiered Image Generation Format Tests
// =============================================================================

describe('Tiered Image Generation Formats', () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  let capturedFormats: string[] = [];

  function createMockBitmap(width = 800, height = 600): ImageBitmap {
    return {
      width,
      height,
      close: vi.fn(),
    } as unknown as ImageBitmap;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    capturedFormats = [];
    mockShouldStoreOriginalsAsAvif.mockReturnValue(true);

    globalThis.createImageBitmap = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockBitmap()));

    const mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        width: 32,
        height: 32,
      }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn(
        (callback: BlobCallback, format: string, _quality: number) => {
          capturedFormats.push(format);
          callback(new Blob(['data'], { type: format }));
        },
      ),
      toDataURL: vi.fn((format: string) => `data:${format};base64,AAAA`),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('generates all three tiers in AVIF format when enabled', async () => {
    const { generateTieredImages, _resetAVIFCache, _resetWebPCache } =
      await import('../src/lib/thumbnail-generator');
    _resetAVIFCache();
    _resetWebPCache();

    const file = createMockFile('image/jpeg');
    const result = await generateTieredImages(file);

    // Thumbnail and preview should be generated via canvas (AVIF)
    expect(capturedFormats).toContain('image/avif');

    // Original tier should have been processed
    expect(result.thumbnail.data).toBeInstanceOf(Uint8Array);
    expect(result.preview.data).toBeInstanceOf(Uint8Array);
    expect(result.original.data).toBeInstanceOf(Uint8Array);
  });

  it('preserves original format when shouldStoreOriginalsAsAvif returns false', async () => {
    mockShouldStoreOriginalsAsAvif.mockReturnValue(false);

    const { generateTieredImages, _resetAVIFCache, _resetWebPCache } =
      await import('../src/lib/thumbnail-generator');
    _resetAVIFCache();
    _resetWebPCache();

    const file = createMockFile('image/jpeg');
    const result = await generateTieredImages(file);

    // Original should be the raw file data (not converted)
    expect(result.original.data).toBeInstanceOf(Uint8Array);
    // Thumbnail and preview should still be generated
    expect(result.thumbnail.data).toBeInstanceOf(Uint8Array);
    expect(result.preview.data).toBeInstanceOf(Uint8Array);
  });

  it.each(SUPPORTED_INPUT_FORMATS)(
    'handles %s input in tiered generation',
    async (inputFormat) => {
      if (inputFormat === 'image/heic' || inputFormat === 'image/heif') {
        heicToMock.mockResolvedValue(
          new Blob(['jpeg-data'], { type: 'image/jpeg' }),
        );
      }

      const { generateTieredImages, _resetAVIFCache, _resetWebPCache } =
        await import('../src/lib/thumbnail-generator');
      _resetAVIFCache();
      _resetWebPCache();

      const file = createMockFile(inputFormat);
      const result = await generateTieredImages(file);

      expect(result.thumbnail.data).toBeInstanceOf(Uint8Array);
      expect(result.preview.data).toBeInstanceOf(Uint8Array);
      expect(result.original.data).toBeInstanceOf(Uint8Array);
      expect(result.originalWidth).toBe(800);
      expect(result.originalHeight).toBe(600);
    },
  );
});

// =============================================================================
// Quality Settings Tests
// =============================================================================

describe('Quality Settings by Format', () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  let capturedQualities: number[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    capturedQualities = [];

    globalThis.createImageBitmap = vi.fn().mockImplementation(() =>
      Promise.resolve({
        width: 800,
        height: 600,
        close: vi.fn(),
      } as unknown as ImageBitmap),
    );

    const mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        width: 32,
        height: 32,
      }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn(
        (callback: BlobCallback, format: string, quality: number) => {
          capturedQualities.push(quality);
          callback(new Blob(['data'], { type: format }));
        },
      ),
      toDataURL: vi.fn((format: string) => `data:${format};base64,AAAA`),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas;
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('uses default quality 0.8 for thumbnails', async () => {
    const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
      await import('../src/lib/thumbnail-generator');
    _resetAVIFCache();
    _resetWebPCache();

    const file = createMockFile('image/jpeg');
    await generateThumbnail(file);

    expect(capturedQualities).toContain(0.8);
  });

  it('uses custom quality when specified', async () => {
    const { generateThumbnail, _resetAVIFCache, _resetWebPCache } =
      await import('../src/lib/thumbnail-generator');
    _resetAVIFCache();
    _resetWebPCache();

    const file = createMockFile('image/jpeg');
    await generateThumbnail(file, { quality: 0.6 });

    expect(capturedQualities).toContain(0.6);
  });

  it('uses 0.95 quality for HEIC intermediate JPEG conversion', async () => {
    const mockJpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    heicToMock.mockResolvedValue(mockJpegBlob);

    await import('../src/lib/image-decoder');

    // Verify heic-to was called with 0.95 quality
    const file = createMockFile('image/heic');
    const { prepareForBitmap } = await import('../src/lib/image-decoder');
    await prepareForBitmap(file, 'image/heic');

    expect(heicToMock).toHaveBeenCalledWith(
      expect.objectContaining({
        quality: 0.95,
      }),
    );
  });
});

// =============================================================================
// Error Handling for Format Conversion
// =============================================================================

describe('Format Conversion Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws meaningful error when HEIC decoding fails', async () => {
    heicToMock.mockRejectedValue(new Error('libheif: Corrupt HEIC data'));

    const { prepareForBitmap } = await import('../src/lib/image-decoder');
    const file = createMockFile('image/heic');

    await expect(prepareForBitmap(file, 'image/heic')).rejects.toThrow(
      'libheif: Corrupt HEIC data',
    );
  });

  it('throws error when HEIC decoding returns empty result', async () => {
    heicToMock.mockResolvedValue(null);

    const { prepareForBitmap } = await import('../src/lib/image-decoder');
    const file = createMockFile('image/heic');

    await expect(prepareForBitmap(file, 'image/heic')).rejects.toThrow(
      'HEIC decoding returned empty result',
    );
  });

  it('rejects unsupported input formats in thumbnail generation', async () => {
    const { generateThumbnail } = await import(
      '../src/lib/thumbnail-generator'
    );
    const file = createMockFile('image/svg+xml');

    await expect(generateThumbnail(file)).rejects.toThrow(
      'Unsupported image type: image/svg+xml',
    );
  });

  it('rejects unsupported input formats in tiered generation', async () => {
    const { generateTieredImages } = await import(
      '../src/lib/thumbnail-generator'
    );
    const file = createMockFile('application/pdf');

    await expect(generateTieredImages(file)).rejects.toThrow(
      'Unsupported image type',
    );
  });
});
