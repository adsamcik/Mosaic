/**
 * Dependency-free image metadata stripper backed by Rust `mosaic-media` through
 * the generated WASM facade. The function never throws: unsupported media and
 * malformed supported containers return the original bytes with `skippedReason`.
 * Sanitized image bytes are client-local media plaintext and must not be logged.
 */

import initRustWasm, {
  canonicalTierLayout,
  inspectImage,
  inspectVideoContainer,
  stripAvifMetadata,
  stripHeicMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripVideoMetadata,
  stripWebpMetadata,
  type ImageInspectResult as WasmImageInspectResult,
  type MediaTierDimensions,
  type StripResult,
  type VideoInspectResult as WasmVideoInspectResult,
} from '../generated/mosaic-wasm/mosaic_wasm.js';

export interface StripExifResult {
  /** The (possibly stripped) bytes. Same reference as input if no work done. */
  bytes: Uint8Array;
  /** True if at least one metadata carrier or metadata flag was removed. */
  stripped: boolean;
  /** Set when the input was passed through unchanged. */
  skippedReason?: string;
}

export type CanonicalSidecarTag =
  | 'orientation'
  | 'original_dimensions'
  | 'device_timestamp_ms'
  | 'mime_override'
  | 'camera_make'
  | 'camera_model'
  | 'subseconds_ms'
  | 'gps'
  | 'codec_fourcc'
  | 'duration_ms'
  | 'frame_rate_x100'
  | 'video_orientation'
  | 'video_dimensions'
  | 'video_container_format';

export interface InspectImageResult {
  format: Exclude<SupportedFormat, 'video'>;
  mimeType: string;
  width: number;
  height: number;
  orientation: number;
  encodedSidecarFields: Uint8Array;
  sidecarTags: CanonicalSidecarTag[];
  cameraMake?: string;
  cameraModel?: string;
  deviceTimestampMs?: bigint;
  subsecondsMs?: number;
  gps?: {
    latitudeMicrodegrees: number;
    longitudeMicrodegrees: number;
    altitudeMeters: number;
    accuracyMeters: number;
  };
}

export class ImageInspectionError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageInspectionError';
  }
}

export interface InspectVideoContainerResult {
  duration: number;
  durationMs: bigint;
  width: number;
  height: number;
  container: string;
  sidecarTags: CanonicalSidecarTag[];
  codec?: string;
  frameRateFps?: number;
  orientation?: string;
}

export class VideoContainerInspectionError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VideoContainerInspectionError';
  }
}

const RUST_OK = 0;
const JPEG_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);
const PNG_MIME_TYPES = new Set(['image/png']);
const WEBP_MIME_TYPES = new Set(['image/webp']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const AVIF_MIME_TYPES = new Set(['image/avif']);

// Canonical active sidecar tag registry per ADR-017 / SPEC-CanonicalSidecarTags.
export const CANONICAL_SIDECAR_TAGS: ReadonlyMap<number, CanonicalSidecarTag> = new Map([
  [1, 'orientation'],
  [2, 'original_dimensions'],
  [3, 'device_timestamp_ms'],
  [4, 'mime_override'],
  [5, 'camera_make'],
  [7, 'camera_model'],
  [8, 'subseconds_ms'],
  [9, 'gps'],
  [10, 'codec_fourcc'],
  [11, 'duration_ms'],
  [12, 'frame_rate_x100'],
  [13, 'video_orientation'],
  [14, 'video_dimensions'],
  [15, 'video_container_format'],
]);


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

function imageFormatForCode(format: number): InspectImageResult['format'] {
  switch (format) {
    case 1:
      return 'jpeg';
    case 2:
      return 'png';
    case 3:
      return 'webp';
    case 4:
      return 'avif';
    case 5:
      return 'heic';
    default:
      throw new ImageInspectionError(`Unsupported Rust image format code: ${String(format)}`, 'unsupported-format-code');
  }
}

function decodeSidecarTags(encodedSidecarFields: Uint8Array): CanonicalSidecarTag[] {
  const tags: CanonicalSidecarTag[] = [];
  let offset = 0;
  while (offset + 6 <= encodedSidecarFields.byteLength) {
    const tag = encodedSidecarFields[offset]! | (encodedSidecarFields[offset + 1]! << 8);
    const length =
      encodedSidecarFields[offset + 2]!
      | (encodedSidecarFields[offset + 3]! << 8)
      | (encodedSidecarFields[offset + 4]! << 16)
      | (encodedSidecarFields[offset + 5]! << 24);
    const unsignedLength = length >>> 0;
    const name = CANONICAL_SIDECAR_TAGS.get(tag);
    if (name && !tags.includes(name)) {
      tags.push(name);
    }
    const nextOffset = offset + 6 + unsignedLength;
    if (nextOffset <= offset || nextOffset > encodedSidecarFields.byteLength) {
      break;
    }
    offset = nextOffset;
  }
  return tags;
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

function consumeImageInspectResult(formatHint: SupportedFormat, result: WasmImageInspectResult): InspectImageResult {
  try {
    if (formatHint === 'video') {
      throw new ImageInspectionError('Video inputs are not valid image inspection inputs', 'unsupported-mime');
    }
    if (result.code !== RUST_OK) {
      throw new ImageInspectionError(`Malformed ${formatHint} image cannot be inspected`, `malformed-${formatHint}`);
    }
    const encodedSidecarFields = new Uint8Array(result.encodedSidecarFields);
    const inspected: InspectImageResult = {
      format: imageFormatForCode(result.format),
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      orientation: result.orientation,
      encodedSidecarFields,
      sidecarTags: decodeSidecarTags(encodedSidecarFields),
    };
    if (result.cameraMake !== '') {
      inspected.cameraMake = result.cameraMake;
    }
    if (result.cameraModel !== '') {
      inspected.cameraModel = result.cameraModel;
    }
    if (result.hasDeviceTimestampMs) {
      inspected.deviceTimestampMs = result.deviceTimestampMs;
    }
    if (result.hasSubsecondsMs) {
      inspected.subsecondsMs = result.subsecondsMs;
    }
    if (result.hasGps) {
      inspected.gps = {
        latitudeMicrodegrees: result.gpsLatMicrodegrees,
        longitudeMicrodegrees: result.gpsLonMicrodegrees,
        altitudeMeters: result.gpsAltitudeMeters,
        accuracyMeters: result.gpsAccuracyMeters,
      };
    }
    return inspected;
  } finally {
    result.free();
  }
}

function sidecarTagsForVideoInspection(result: WasmVideoInspectResult): CanonicalSidecarTag[] {
  const tags: CanonicalSidecarTag[] = [];
  const addTag = (tagNumber: number): void => {
    const tag = CANONICAL_SIDECAR_TAGS.get(tagNumber);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  };
  if (result.videoCodec !== '') addTag(10);
  if (result.durationMs > 0n) addTag(11);
  if (Number.isFinite(result.frameRateFps)) addTag(12);
  if (result.orientation !== '') addTag(13);
  if (result.widthPx > 0 && result.heightPx > 0) addTag(14);
  if (result.container !== '') addTag(15);
  return tags;
}

function consumeVideoInspectResult(result: WasmVideoInspectResult): InspectVideoContainerResult {
  try {
    if (result.code !== RUST_OK) {
      throw new VideoContainerInspectionError('Malformed video container cannot be inspected', 'malformed-video');
    }
    if (result.widthPx <= 0 || result.heightPx <= 0) {
      throw new VideoContainerInspectionError(
        'Video container has no valid dimensions (width=0 or height=0)',
        'invalid-video-dimensions',
      );
    }
    if (result.durationMs <= 0n) {
      throw new VideoContainerInspectionError(
        `Video container has invalid duration: ${String(result.durationMs)}ms`,
        'invalid-video-duration',
      );
    }
    const inspected: InspectVideoContainerResult = {
      duration: Number(result.durationMs) / 1000,
      durationMs: result.durationMs,
      width: result.widthPx,
      height: result.heightPx,
      container: result.container,
      sidecarTags: sidecarTagsForVideoInspection(result),
    };
    if (result.videoCodec !== '') {
      inspected.codec = result.videoCodec;
    }
    if (Number.isFinite(result.frameRateFps)) {
      inspected.frameRateFps = result.frameRateFps;
    }
    if (result.orientation !== '') {
      inspected.orientation = result.orientation;
    }
    return inspected;
  } finally {
    result.free();
  }
}

export async function inspectImageBlob(blob: Blob, mimeType: string): Promise<InspectImageResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const format = formatForMimeType(normalizedMimeType);
  if (format === null || format === 'video') {
    throw new ImageInspectionError(`Unsupported image MIME type for inspection: ${normalizedMimeType}`, 'unsupported-mime');
  }
  try {
    await ensureRustReady();
    return consumeImageInspectResult(format, inspectImage(bytes));
  } catch (error) {
    if (error instanceof ImageInspectionError) {
      throw error;
    }
    throw new ImageInspectionError('Rust image inspection failed before metadata extraction', 'wasm-inspect-failed', error);
  }
}

export async function inspectVideoContainerBytes(bytes: Uint8Array): Promise<InspectVideoContainerResult> {
  try {
    await ensureRustReady();
    return consumeVideoInspectResult(inspectVideoContainer(bytes));
  } catch (error) {
    if (error instanceof VideoContainerInspectionError) {
      throw error;
    }
    throw new VideoContainerInspectionError(
      'Rust video container inspection failed before metadata extraction',
      'wasm-inspect-failed',
      error,
    );
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
