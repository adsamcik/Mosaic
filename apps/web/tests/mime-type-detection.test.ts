/**
 * MIME Type Detection Tests
 *
 * Tests for image and video MIME type detection from magic bytes,
 * file extensions, and helper functions.
 */

import { describe, expect, it } from 'vitest';
import {
  detectMimeType,
  getMimeTypeFromExtension,
  getFormatName,
  isImageMimeType,
  isSupportedImageType,
  isSupportedVideoType,
  isVideoType,
  needsDecoding,
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_MEDIA_TYPES,
  SUPPORTED_VIDEO_TYPES,
} from '../src/lib/mime-type-detection';

/**
 * Helper: create a Blob from a byte array for magic byte testing
 */
function blobFromBytes(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

/**
 * Helper: build ISOBMFF ftyp box bytes.
 * Returns: [box_size(4)] [ftyp(4)] [major_brand(4)] [minor_version(4)] [compat_brands...]
 */
function makeFtypBox(majorBrand: string, compatBrands: string[] = []): number[] {
  const boxSize = 16 + compatBrands.length * 4;
  const bytes: number[] = [
    (boxSize >> 24) & 0xff,
    (boxSize >> 16) & 0xff,
    (boxSize >> 8) & 0xff,
    boxSize & 0xff,
    // "ftyp"
    0x66, 0x74, 0x79, 0x70,
    // major brand (4 ASCII chars)
    ...majorBrand.split('').map((c) => c.charCodeAt(0)),
    // minor version (4 zero bytes)
    0x00, 0x00, 0x00, 0x00,
  ];
  for (const brand of compatBrands) {
    bytes.push(...brand.split('').map((c) => c.charCodeAt(0)));
  }
  return bytes;
}

/**
 * Helper: build EBML header bytes with a DocType string.
 * Simplified: EBML magic + enough padding + ASCII doctype text.
 */
function makeEbmlBytes(docType: string): number[] {
  // EBML magic header
  const header = [0x1a, 0x45, 0xdf, 0xa3];
  // Pad to offset where doctype text would appear, then embed the doctype string
  const padding = new Array(8).fill(0x00);
  const docTypeBytes = docType.split('').map((c) => c.charCodeAt(0));
  return [...header, ...padding, ...docTypeBytes, ...new Array(20).fill(0x00)];
}

// =============================================================================
// Image magic byte detection (regression tests)
// =============================================================================

describe('detectMimeType – image formats', () => {
  it('detects JPEG', async () => {
    const blob = blobFromBytes([0xff, 0xd8, 0xff, 0xe0, ...new Array(28).fill(0)]);
    expect(await detectMimeType(blob)).toBe('image/jpeg');
  });

  it('detects PNG', async () => {
    const blob = blobFromBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]);
    expect(await detectMimeType(blob)).toBe('image/png');
  });

  it('detects GIF89a', async () => {
    const blob = blobFromBytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(26).fill(0)]);
    expect(await detectMimeType(blob)).toBe('image/gif');
  });

  it('detects WebP', async () => {
    // RIFF....WEBP
    const blob = blobFromBytes([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      ...new Array(20).fill(0),
    ]);
    expect(await detectMimeType(blob)).toBe('image/webp');
  });

  it('detects HEIC (heic brand)', async () => {
    const blob = blobFromBytes(makeFtypBox('heic'));
    expect(await detectMimeType(blob)).toBe('image/heic');
  });

  it('detects AVIF (avif brand)', async () => {
    const blob = blobFromBytes(makeFtypBox('avif'));
    expect(await detectMimeType(blob)).toBe('image/avif');
  });

  it('detects HEIC via mif1 with heic compat brand', async () => {
    const blob = blobFromBytes(makeFtypBox('mif1', ['heic']));
    expect(await detectMimeType(blob)).toBe('image/heic');
  });

  it('detects AVIF via mif1 with avif compat brand', async () => {
    const blob = blobFromBytes(makeFtypBox('mif1', ['avif']));
    expect(await detectMimeType(blob)).toBe('image/avif');
  });

  it('detects HEIF for generic mif1', async () => {
    const blob = blobFromBytes(makeFtypBox('mif1'));
    expect(await detectMimeType(blob)).toBe('image/heif');
  });

  it('detects BMP', async () => {
    const blob = blobFromBytes([0x42, 0x4d, ...new Array(30).fill(0)]);
    expect(await detectMimeType(blob)).toBe('image/bmp');
  });

  it('detects TIFF (little-endian)', async () => {
    const blob = blobFromBytes([0x49, 0x49, 0x2a, 0x00, ...new Array(28).fill(0)]);
    expect(await detectMimeType(blob)).toBe('image/tiff');
  });
});

// =============================================================================
// Video magic byte detection
// =============================================================================

describe('detectMimeType – video formats', () => {
  it('detects MP4 with isom brand', async () => {
    const blob = blobFromBytes(makeFtypBox('isom'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects MP4 with iso2 brand', async () => {
    const blob = blobFromBytes(makeFtypBox('iso2'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects MP4 with mp41 brand', async () => {
    const blob = blobFromBytes(makeFtypBox('mp41'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects MP4 with mp42 brand', async () => {
    const blob = blobFromBytes(makeFtypBox('mp42'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects MP4 with avc1 brand', async () => {
    const blob = blobFromBytes(makeFtypBox('avc1'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects MP4 with dash brand', async () => {
    const blob = blobFromBytes(makeFtypBox('dash'));
    expect(await detectMimeType(blob)).toBe('video/mp4');
  });

  it('detects QuickTime (MOV) with qt brand', async () => {
    const blob = blobFromBytes(makeFtypBox('qt  '));
    expect(await detectMimeType(blob)).toBe('video/quicktime');
  });

  it('detects WebM from EBML header with webm doctype', async () => {
    const blob = blobFromBytes(makeEbmlBytes('webm'));
    expect(await detectMimeType(blob)).toBe('video/webm');
  });

  it('detects MKV from EBML header with matroska doctype', async () => {
    const blob = blobFromBytes(makeEbmlBytes('matroska'));
    expect(await detectMimeType(blob)).toBe('video/x-matroska');
  });

  it('defaults to WebM for EBML with unknown doctype', async () => {
    // EBML magic followed by no recognizable doctype
    const blob = blobFromBytes([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]);
    expect(await detectMimeType(blob)).toBe('video/webm');
  });
});

// =============================================================================
// ISOBMFF: image brands are NOT detected as video
// =============================================================================

describe('detectMimeType – ISOBMFF brand isolation', () => {
  it('heic brand returns image/heic, not video', async () => {
    const blob = blobFromBytes(makeFtypBox('heic'));
    const result = await detectMimeType(blob);
    expect(result).toBe('image/heic');
    expect(result).not.toMatch(/^video\//);
  });

  it('avif brand returns image/avif, not video', async () => {
    const blob = blobFromBytes(makeFtypBox('avif'));
    const result = await detectMimeType(blob);
    expect(result).toBe('image/avif');
    expect(result).not.toMatch(/^video\//);
  });
});

// =============================================================================
// isVideoType / isSupportedVideoType
// =============================================================================

describe('isVideoType', () => {
  it('returns true for video MIME types', () => {
    expect(isVideoType('video/mp4')).toBe(true);
    expect(isVideoType('video/webm')).toBe(true);
    expect(isVideoType('video/quicktime')).toBe(true);
    expect(isVideoType('video/x-matroska')).toBe(true);
    expect(isVideoType('video/avi')).toBe(true); // unsupported but still video
  });

  it('returns false for image MIME types', () => {
    expect(isVideoType('image/jpeg')).toBe(false);
    expect(isVideoType('image/png')).toBe(false);
    expect(isVideoType('image/heic')).toBe(false);
  });

  it('returns false for non-media MIME types', () => {
    expect(isVideoType('application/pdf')).toBe(false);
    expect(isVideoType('text/plain')).toBe(false);
  });
});

describe('isSupportedVideoType', () => {
  it('returns true for all supported video types', () => {
    for (const type of SUPPORTED_VIDEO_TYPES) {
      expect(isSupportedVideoType(type)).toBe(true);
    }
  });

  it('returns false for unsupported video types', () => {
    expect(isSupportedVideoType('video/avi')).toBe(false);
    expect(isSupportedVideoType('video/3gpp')).toBe(false);
  });

  it('returns false for image types', () => {
    expect(isSupportedVideoType('image/jpeg')).toBe(false);
    expect(isSupportedVideoType('image/png')).toBe(false);
  });
});

// =============================================================================
// isSupportedImageType
// =============================================================================

describe('isSupportedImageType', () => {
  it('returns true for supported image types', () => {
    for (const type of SUPPORTED_IMAGE_TYPES) {
      expect(isSupportedImageType(type)).toBe(true);
    }
  });

  it('returns false for video types', () => {
    expect(isSupportedImageType('video/mp4')).toBe(false);
    expect(isSupportedImageType('video/webm')).toBe(false);
    expect(isSupportedImageType('video/quicktime')).toBe(false);
    expect(isSupportedImageType('video/x-matroska')).toBe(false);
  });

  it('returns false for unsupported image types', () => {
    expect(isSupportedImageType('image/x-icon')).toBe(false);
  });
});

// =============================================================================
// Constants
// =============================================================================

describe('SUPPORTED_MEDIA_TYPES', () => {
  it('contains all image and video types', () => {
    for (const type of SUPPORTED_IMAGE_TYPES) {
      expect(SUPPORTED_MEDIA_TYPES).toContain(type);
    }
    for (const type of SUPPORTED_VIDEO_TYPES) {
      expect(SUPPORTED_MEDIA_TYPES).toContain(type);
    }
  });

  it('has correct total count', () => {
    expect(SUPPORTED_MEDIA_TYPES.length).toBe(
      SUPPORTED_IMAGE_TYPES.length + SUPPORTED_VIDEO_TYPES.length,
    );
  });
});

// =============================================================================
// Extension-based detection
// =============================================================================

describe('getMimeTypeFromExtension – video extensions', () => {
  it('detects .mp4', () => {
    expect(getMimeTypeFromExtension('video.mp4')).toBe('video/mp4');
  });

  it('detects .m4v', () => {
    expect(getMimeTypeFromExtension('video.m4v')).toBe('video/mp4');
  });

  it('detects .webm', () => {
    expect(getMimeTypeFromExtension('video.webm')).toBe('video/webm');
  });

  it('detects .mov', () => {
    expect(getMimeTypeFromExtension('video.mov')).toBe('video/quicktime');
  });

  it('detects .mkv', () => {
    expect(getMimeTypeFromExtension('video.mkv')).toBe('video/x-matroska');
  });

  it('still detects image extensions', () => {
    expect(getMimeTypeFromExtension('photo.jpg')).toBe('image/jpeg');
    expect(getMimeTypeFromExtension('photo.png')).toBe('image/png');
    expect(getMimeTypeFromExtension('photo.heic')).toBe('image/heic');
  });
});

// =============================================================================
// getFormatName – video format names
// =============================================================================

describe('getFormatName – video formats', () => {
  it('returns MP4 for video/mp4', () => {
    expect(getFormatName('video/mp4')).toBe('MP4');
  });

  it('returns WebM for video/webm', () => {
    expect(getFormatName('video/webm')).toBe('WebM');
  });

  it('returns MOV for video/quicktime', () => {
    expect(getFormatName('video/quicktime')).toBe('MOV');
  });

  it('returns MKV for video/x-matroska', () => {
    expect(getFormatName('video/x-matroska')).toBe('MKV');
  });

  it('still returns image format names', () => {
    expect(getFormatName('image/jpeg')).toBe('JPEG');
    expect(getFormatName('image/heic')).toBe('HEIC');
  });
});

// =============================================================================
// isImageMimeType / needsDecoding (regression)
// =============================================================================

describe('isImageMimeType', () => {
  it('returns true for image types', () => {
    expect(isImageMimeType('image/jpeg')).toBe(true);
    expect(isImageMimeType('image/heic')).toBe(true);
  });

  it('returns false for video types', () => {
    expect(isImageMimeType('video/mp4')).toBe(false);
    expect(isImageMimeType('video/webm')).toBe(false);
  });
});

describe('needsDecoding', () => {
  it('returns true for HEIC/HEIF', () => {
    expect(needsDecoding('image/heic')).toBe(true);
    expect(needsDecoding('image/heif')).toBe(true);
  });

  it('returns false for video types', () => {
    expect(needsDecoding('video/mp4')).toBe(false);
  });
});
