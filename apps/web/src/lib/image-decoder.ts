/**
 * Image Decoder Service
 *
 * Provides unified image decoding for formats that browsers may not natively support.
 * Currently focuses on HEIC/HEIF decoding using heic-to (actively maintained libheif wrapper).
 *
 * The output of this service is always a format that can be used with
 * createImageBitmap() for canvas processing.
 *
 * NOTE: We use 'heic-to/csp' instead of 'heic-to' because the project's CSP
 * uses 'wasm-unsafe-eval' but NOT 'unsafe-eval'. The /csp variant is built
 * without eval() usage, making it CSP-compliant.
 */

import { createLogger } from './logger';
import { needsDecoding as checkNeedsDecoding } from './mime-type-detection';

const log = createLogger('ImageDecoder');

// =============================================================================
// HEIC Decoding (via heic-to/csp)
// =============================================================================

// Cache for heic-to module (lazy loaded)
let heicToModule: typeof import('heic-to/csp') | null = null;
let heicToLoadPromise: Promise<typeof import('heic-to/csp')> | null = null;

/**
 * Lazily load heic-to module (CSP-safe variant)
 * Only loads when actually needed (first HEIC file encountered)
 */
async function getHeicTo(): Promise<typeof import('heic-to/csp')> {
  if (heicToModule) {
    return heicToModule;
  }

  if (!heicToLoadPromise) {
    log.info('Loading heic-to library for HEIC decoding...');
    heicToLoadPromise = import('heic-to/csp').then((module) => {
      heicToModule = module;
      log.info('heic-to library loaded successfully');
      return module;
    });
  }

  return heicToLoadPromise;
}

/**
 * Check if HEIC decoding library is available
 */
export async function isHeicDecodingAvailable(): Promise<boolean> {
  try {
    await getHeicTo();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a HEIC/HEIF blob to a JPEG blob that can be used with createImageBitmap
 *
 * @param blob - HEIC/HEIF image blob
 * @returns JPEG blob
 */
async function decodeHeicToJpeg(blob: Blob): Promise<Blob> {
  const heicTo = await getHeicTo();

  log.debug('Decoding HEIC image', { size: blob.size });

  const result = await heicTo.heicTo({
    blob,
    type: 'image/jpeg',
    quality: 0.95, // High quality since we'll re-encode to AVIF
  });

  if (!result) {
    throw new Error('HEIC decoding returned empty result');
  }

  log.debug('HEIC decoded successfully', {
    originalSize: blob.size,
    decodedSize: result.size,
  });

  return result;
}

// =============================================================================
// AVIF Fallback Decoding (for display in legacy browsers)
// =============================================================================

// Cache for AVIF decoding support detection
let avifDecodeSupport: boolean | null = null;

/**
 * Check if the browser can decode AVIF images natively
 * Uses image element test rather than canvas test
 */
export async function canDecodeAvif(): Promise<boolean> {
  if (avifDecodeSupport !== null) {
    return avifDecodeSupport;
  }

  try {
    // Small valid AVIF image (1x1 pixel)
    const avifData =
      'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKBzgABpAQ0AIADEAABBQZAf/WFhAA';
    const blob = new Blob(
      [Uint8Array.from(atob(avifData), (c) => c.charCodeAt(0))],
      { type: 'image/avif' },
    );
    const url = URL.createObjectURL(blob);

    const result = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    });

    avifDecodeSupport = result;
    log.info(`AVIF decode support: ${result}`);
    return result;
  } catch {
    avifDecodeSupport = false;
    return false;
  }
}

// AVIF fallback is currently disabled - 95%+ of modern browsers support AVIF natively.
// If needed in the future, implement a WASM-based decoder here.
// For now, browsers that don't support AVIF will show the image as-is or fail gracefully.

/**
 * Decode AVIF to a displayable format using fallback library
 * Only used when browser doesn't support AVIF natively
 *
 * NOTE: Currently returns an error as no fallback library is configured.
 * This is acceptable as 95%+ of browsers support AVIF natively.
 *
 * @param data - AVIF image data
 * @returns Decoded image as a Blob
 */
export async function decodeAvifFallback(_data: Uint8Array): Promise<Blob> {
  // AVIF fallback decoding is not currently implemented.
  // 95%+ of modern browsers support AVIF natively, so this fallback
  // is rarely needed. If you need to support older browsers, consider
  // implementing a WASM-based decoder here.
  log.warn(
    'AVIF fallback decoder not available - browser does not support AVIF',
  );
  throw new Error(
    'AVIF fallback decoder not available. Please use a modern browser that supports AVIF.',
  );
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Prepare a file for processing with createImageBitmap
 *
 * If the file is in a format that browsers can't decode (like HEIC),
 * converts it to JPEG first. Otherwise returns the file as-is.
 *
 * @param file - Original image file
 * @param mimeType - Detected MIME type from magic bytes
 * @returns A blob/file that can be used with createImageBitmap
 */
export async function prepareForBitmap(
  file: File,
  mimeType: string,
): Promise<Blob> {
  if (checkNeedsDecoding(mimeType)) {
    log.info('Converting HEIC/HEIF to JPEG for bitmap creation', {
      filename: file.name,
    });
    return decodeHeicToJpeg(file);
  }
  return file;
}

/**
 * Create a displayable blob URL for an image
 *
 * Handles AVIF fallback decoding for legacy browsers.
 *
 * @param data - Image data
 * @param mimeType - Image MIME type
 * @returns Object URL (must be revoked when done) and actual MIME type
 */
export async function createDisplayableUrl(
  data: Uint8Array,
  mimeType: string,
): Promise<{ url: string; mimeType: string }> {
  // Check if we need AVIF fallback
  if (mimeType === 'image/avif') {
    const canDecode = await canDecodeAvif();
    if (!canDecode) {
      log.debug('Using AVIF fallback decoder');
      try {
        const decoded = await decodeAvifFallback(data);
        const url = URL.createObjectURL(decoded);
        return { url, mimeType: 'image/png' };
      } catch (err) {
        log.error('AVIF fallback decoding failed', { error: err });
        // Fall through to try native display anyway
      }
    }
  }

  // Create blob URL directly - copy to new ArrayBuffer for Blob compatibility
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  return { url, mimeType };
}

/**
 * Check if a MIME type needs decoding before bitmap creation
 * Re-exported for convenience
 */
export { checkNeedsDecoding as needsDecoding };
