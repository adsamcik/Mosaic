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
// Decompression-bomb / Resource-exhaustion Guards (M5)
// =============================================================================

/**
 * Maximum accepted size for a single input image blob (100 MB).
 *
 * Sized as a sane upper bound for any legitimate single photo: even RAW DSLR
 * files and uncompressed bitmaps fit comfortably below this. Prevents a
 * hostile client from feeding gigabyte-scale blobs into the decode pipeline.
 */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

/**
 * Maximum accepted decoded image surface in pixels (200 megapixels).
 *
 * Bounds in-memory bitmap allocation to ~800 MB at 4 bytes/pixel, which is
 * still large enough for any legitimate camera output but small enough to
 * prevent a decompression bomb (e.g. a 100 KB compressed image expanding to
 * a 100 000 x 100 000 surface) from OOMing the tab.
 */
export const MAX_DECODED_PIXELS = 200_000_000;

/**
 * Maximum wall-clock time allowed for a single decode step (30 seconds).
 *
 * Both `heic-to` and `createImageBitmap` are wrapped in a timeout race so a
 * malformed image cannot stall the worker indefinitely.
 */
export const DECODE_TIMEOUT_MS = 30_000;

/** Thrown when an input blob exceeds {@link MAX_INPUT_BYTES}. */
export class ImageTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly limit: number = MAX_INPUT_BYTES,
  ) {
    super(`Image input is ${size} bytes, exceeds the ${limit}-byte cap`);
    this.name = 'ImageTooLargeError';
  }
}

/** Thrown when a decoded bitmap's pixel count exceeds {@link MAX_DECODED_PIXELS}. */
export class ImageDimensionsExceededError extends Error {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly limit: number = MAX_DECODED_PIXELS,
  ) {
    super(
      `Decoded image is ${width}x${height} (${width * height} pixels), ` +
        `exceeds the ${limit}-pixel cap`,
    );
    this.name = 'ImageDimensionsExceededError';
  }
}

/** Thrown when a decode step exceeds {@link DECODE_TIMEOUT_MS}. */
export class ImageDecodeTimeoutError extends Error {
  constructor(
    public readonly stage: string,
    public readonly timeoutMs: number = DECODE_TIMEOUT_MS,
  ) {
    super(`Image decode stage "${stage}" timed out after ${timeoutMs} ms`);
    this.name = 'ImageDecodeTimeoutError';
  }
}

/**
 * Reject a blob whose size already exceeds the input cap.
 * Throws synchronously so callers can fail before allocating anything.
 */
function assertInputSize(blob: Blob): void {
  if (blob.size > MAX_INPUT_BYTES) {
    log.warn('Rejecting oversized image input', {
      size: blob.size,
      limit: MAX_INPUT_BYTES,
    });
    throw new ImageTooLargeError(blob.size);
  }
}

/**
 * Race a promise against a timeout. If the timeout wins, an
 * {@link ImageDecodeTimeoutError} is thrown. The original promise is left to
 * settle in the background; if it eventually yields a closeable resource
 * (e.g. an {@link ImageBitmap}) we close it to release memory.
 */
function withDecodeTimeout<T>(
  promise: Promise<T>,
  stage: string,
  timeoutMs: number = DECODE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // If the late result is closeable, free it once it eventually resolves.
  promise
    .then((value) => {
      if (
        timedOut &&
        value !== null &&
        typeof value === 'object' &&
        'close' in (value as object) &&
        typeof (value as { close?: unknown }).close === 'function'
      ) {
        try {
          (value as unknown as { close: () => void }).close();
        } catch {
          /* ignore cleanup failure */
        }
      }
    })
    .catch(() => {
      /* swallow late rejection */
    });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ImageDecodeTimeoutError(stage, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Wrap {@link createImageBitmap} with all three decompression-bomb guards:
 *
 *   1. Input size cap — rejects with {@link ImageTooLargeError}.
 *   2. Decode timeout — rejects with {@link ImageDecodeTimeoutError}.
 *   3. Decoded dimension cap — rejects with
 *      {@link ImageDimensionsExceededError} (closing the bitmap first).
 *
 * Use this in place of `createImageBitmap` at every decode entry point.
 */
export async function safeCreateImageBitmap(blob: Blob): Promise<ImageBitmap> {
  assertInputSize(blob);

  const bitmap = await withDecodeTimeout(
    createImageBitmap(blob),
    'createImageBitmap',
  );

  if (bitmap.width * bitmap.height > MAX_DECODED_PIXELS) {
    const { width, height } = bitmap;
    log.warn('Rejecting oversized decoded bitmap', {
      width,
      height,
      pixels: width * height,
      limit: MAX_DECODED_PIXELS,
    });
    bitmap.close();
    throw new ImageDimensionsExceededError(width, height);
  }

  return bitmap;
}

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
  assertInputSize(blob);

  const heicTo = await getHeicTo();

  log.debug('Decoding HEIC image', { size: blob.size });

  const result = await withDecodeTimeout(
    heicTo.heicTo({
      blob,
      type: 'image/jpeg',
      quality: 0.95, // High quality since we'll re-encode to AVIF
    }),
    'heic-to',
  );

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
  // Reject oversized inputs before doing any work — covers both HEIC and
  // pass-through paths so downstream `safeCreateImageBitmap` is not the only
  // gatekeeper.
  assertInputSize(file);

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
  // Videos don't need format conversion — pass through directly
  if (isVideoMimeType(mimeType)) {
    const blob = new Blob([new Uint8Array(data)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    return { url, mimeType };
  }

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
 * Check if a MIME type is a video type
 */
export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

/**
 * Check if a MIME type needs decoding before bitmap creation
 * Re-exported for convenience
 */
export { checkNeedsDecoding as needsDecoding };
