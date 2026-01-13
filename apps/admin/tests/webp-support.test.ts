/**
 * WebP Support Tests
 *
 * Tests for the WebP thumbnail generation feature with JPEG fallback.
 * Note: AVIF is checked before WebP, so tests must reset both caches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectWebPSupport,
  getPreferredImageFormat,
  _resetWebPCache,
  _resetAVIFCache,
} from '../src/lib/thumbnail-generator';

describe('WebP Support Detection', () => {
  // Store original createElement
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    // Reset the cached result before each test
    _resetWebPCache();
    _resetAVIFCache();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    _resetWebPCache();
    _resetAVIFCache();
  });

  it('should detect WebP support when browser supports it', () => {
    // Mock canvas to return WebP data URL
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn((type: string) => {
            if (type === 'image/webp') {
              return 'data:image/webp;base64,AAAA';
            }
            return 'data:image/png;base64,AAAA';
          }),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = detectWebPSupport();
    expect(result).toBe(true);
  });

  it('should detect no WebP support when browser falls back to PNG', () => {
    // Mock canvas to return PNG data URL (no WebP support)
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn(() => {
            // Always returns PNG regardless of requested type
            return 'data:image/png;base64,AAAA';
          }),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = detectWebPSupport();
    expect(result).toBe(false);
  });

  it('should return false on error', () => {
    // Mock canvas to throw error
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        throw new Error('Canvas not supported');
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = detectWebPSupport();
    expect(result).toBe(false);
  });
});

describe('getPreferredImageFormat', () => {
  // Store original createElement
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    _resetWebPCache();
    _resetAVIFCache();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    _resetWebPCache();
    _resetAVIFCache();
  });

  it('should return image/webp when only WebP is supported (no AVIF)', () => {
    // Mock WebP support but no AVIF
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn((type: string) => {
            if (type === 'image/avif') {
              return 'data:image/png;base64,AAAA'; // AVIF not supported
            }
            if (type === 'image/webp') {
              return 'data:image/webp;base64,AAAA';
            }
            return 'data:image/png;base64,AAAA';
          }),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = getPreferredImageFormat();
    expect(result).toBe('image/webp');
  });

  it('should return image/jpeg when neither AVIF nor WebP is supported', () => {
    // Mock no WebP or AVIF support
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn(() => 'data:image/png;base64,AAAA'),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = getPreferredImageFormat();
    expect(result).toBe('image/jpeg');
  });
});
