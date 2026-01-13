/**
 * AVIF Support Tests
 *
 * Tests for AVIF thumbnail format detection with WebP and JPEG fallback.
 * Format priority: AVIF > WebP > JPEG
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectAVIFSupport,
  detectWebPSupport,
  getPreferredImageFormat,
  _resetAVIFCache,
  _resetWebPCache,
} from '../src/lib/thumbnail-generator';

describe('AVIF Support Detection', () => {
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    _resetAVIFCache();
    _resetWebPCache();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    _resetAVIFCache();
    _resetWebPCache();
  });

  it('should detect AVIF support when browser supports it', () => {
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn((type: string) => {
            if (type === 'image/avif') {
              return 'data:image/avif;base64,AAAA';
            }
            return 'data:image/png;base64,AAAA';
          }),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = detectAVIFSupport();
    expect(result).toBe(true);
  });

  it('should detect no AVIF support when browser falls back to PNG', () => {
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

    const result = detectAVIFSupport();
    expect(result).toBe(false);
  });

  it('should return false on error', () => {
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        throw new Error('Canvas not supported');
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    const result = detectAVIFSupport();
    expect(result).toBe(false);
  });

  it('should cache the detection result', () => {
    let callCount = 0;
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        callCount++;
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn(() => 'data:image/avif;base64,AAAA'),
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement;

    detectAVIFSupport();
    detectAVIFSupport();
    detectAVIFSupport();

    // Canvas should only be created once due to caching
    expect(callCount).toBe(1);
  });
});

describe('getPreferredImageFormat with AVIF', () => {
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    _resetAVIFCache();
    _resetWebPCache();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
    _resetAVIFCache();
    _resetWebPCache();
  });

  it('should return image/avif when AVIF is supported', () => {
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          toDataURL: vi.fn((type: string) => {
            if (type === 'image/avif') {
              return 'data:image/avif;base64,AAAA';
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
    expect(result).toBe('image/avif');
  });

  it('should return image/webp when only WebP is supported (no AVIF)', () => {
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
              return 'data:image/webp;base64,AAAA'; // WebP supported
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
