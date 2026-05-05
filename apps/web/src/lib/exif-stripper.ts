/**
 * Dependency-free image metadata stripper backed by Rust `mosaic-media` through
 * the generated WASM facade. The function never throws: unsupported media and
 * malformed supported containers return the original bytes with `skippedReason`.
 * Sanitized image bytes are client-local media plaintext and must not be logged.
 */

import initRustWasm, {
  stripAvifMetadata,
  stripHeicMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripVideoMetadata,
  stripWebpMetadata,
  type StripResult,
} from '../generated/mosaic-wasm/mosaic_wasm.js';

export interface StripExifResult {
  /** The (possibly stripped) bytes. Same reference as input if no work done. */
  bytes: Uint8Array;
  /** True if at least one metadata carrier or metadata flag was removed. */
  stripped: boolean;
  /** Set when the input was passed through unchanged. */
  skippedReason?: string;
}

const RUST_OK = 0;
const JPEG_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);
const PNG_MIME_TYPES = new Set(['image/png']);
const WEBP_MIME_TYPES = new Set(['image/webp']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const AVIF_MIME_TYPES = new Set(['image/avif']);

type SupportedFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | 'video';
type StripFunction = (inputBytes: Uint8Array) => StripResult;

let rustReadyPromise: Promise<void> | null = null;

function ensureRustReady(): Promise<void> {
  rustReadyPromise ??= initRustWasm().then(() => undefined);
  return rustReadyPromise;
}

function formatForMimeType(mimeType: string): SupportedFormat | null {
  if (JPEG_MIME_TYPES.has(mimeType)) return 'jpeg';
  if (PNG_MIME_TYPES.has(mimeType)) return 'png';
  if (WEBP_MIME_TYPES.has(mimeType)) return 'webp';
  if (AVIF_MIME_TYPES.has(mimeType)) return 'avif';
  if (HEIC_MIME_TYPES.has(mimeType)) return 'heic';
  if (mimeType.startsWith('video/')) return 'video';
  return null;
}

function unsupportedReasonForMimeType(): string {
  return 'unsupported-mime';
}

function stripFunctionForFormat(format: SupportedFormat): StripFunction {
  switch (format) {
    case 'jpeg':
      return stripJpegMetadata;
    case 'png':
      return stripPngMetadata;
    case 'webp':
      return stripWebpMetadata;
    case 'avif':
      return stripAvifMetadata;
    case 'heic':
      return stripHeicMetadata;
    case 'video':
      return stripVideoMetadata;
  }
}

function consumeStripResult(input: Uint8Array, format: SupportedFormat, result: StripResult): StripExifResult {
  try {
    if (result.code !== RUST_OK) {
      return { bytes: input, stripped: false, skippedReason: `malformed-${format}` };
    }
    const strippedBytes = result.strippedBytes;
    return result.removedMetadataCount > 0
      ? { bytes: strippedBytes, stripped: true }
      : { bytes: input, stripped: false };
  } finally {
    result.free();
  }
}

export async function stripExifFromBlob(blob: Blob, mimeType: string): Promise<StripExifResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const format = formatForMimeType(normalizedMimeType);
  if (format === null) {
    return { bytes, stripped: false, skippedReason: unsupportedReasonForMimeType() };
  }
  try {
    await ensureRustReady();
    return consumeStripResult(bytes, format, stripFunctionForFormat(format)(bytes));
  } catch {
    return { bytes, stripped: false, skippedReason: 'wasm-strip-failed' };
  }
}
