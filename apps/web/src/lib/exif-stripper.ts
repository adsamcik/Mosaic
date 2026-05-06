/**
 * Dependency-free image metadata stripper backed by Rust `mosaic-media` through
 * the generated WASM facade. The function never throws: unsupported media and
 * malformed supported containers return the original bytes with `skippedReason`.
 * Sanitized image bytes are client-local media plaintext and must not be logged.
 */

import initRustWasm, {
  canonicalTierLayout,
  stripAvifMetadata,
  stripHeicMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripVideoMetadata,
  stripWebpMetadata,
  type MediaTierDimensions,
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


export interface CanonicalTierDimensions {
  width: number;
  height: number;
  tier: number;
}

export interface CanonicalTierLayout {
  thumbnail: CanonicalTierDimensions;
  preview: CanonicalTierDimensions;
  original: CanonicalTierDimensions;
}

let canonicalTierLayoutPromise: Promise<CanonicalTierLayout> | null = null;

function copyMediaTierDimensions(dimensions: MediaTierDimensions): CanonicalTierDimensions {
  try {
    return {
      width: dimensions.width,
      height: dimensions.height,
      tier: dimensions.tier,
    };
  } finally {
    dimensions.free();
  }
}

export async function getCanonicalTierLayout(): Promise<CanonicalTierLayout> {
  canonicalTierLayoutPromise ??= ensureRustReady().then(() => {
    const result = canonicalTierLayout();
    try {
      if (result.code !== RUST_OK) {
        throw new Error(`Failed to read canonical tier layout (rust code ${String(result.code)})`);
      }
      return {
        thumbnail: copyMediaTierDimensions(result.thumbnail),
        preview: copyMediaTierDimensions(result.preview),
        original: copyMediaTierDimensions(result.original),
      };
    } finally {
      result.free();
    }
  });
  return canonicalTierLayoutPromise;
}

export async function getCanonicalTierMaxSizes(): Promise<{ thumbnail: number; preview: number; original: number }> {
  const layout = await getCanonicalTierLayout();
  return {
    thumbnail: Math.max(layout.thumbnail.width, layout.thumbnail.height),
    preview: Math.max(layout.preview.width, layout.preview.height),
    original: Math.max(layout.original.width, layout.original.height),
  };
}

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
