/**
 * Thumbnail Generator Service
 *
 * Generates three-tier images from photos using the Canvas API:
 * - Thumbnail: 450px max dimension, ~80% quality WebP/JPEG (for shard)
 * - Preview: 1200px max dimension, ~85% quality WebP/JPEG
 * - Original: unchanged source file
 *
 * Additionally generates a smaller embedded thumbnail (150px) for manifest
 * to reduce manifest size while maintaining HiDPI quality in gallery view.
 *
 * Each tier is encrypted with its corresponding key (thumbKey, previewKey, fullKey).
 * Handles EXIF orientation, maintains aspect ratio, and outputs
 * compressed WebP (with JPEG fallback) for efficient storage.
 * 
 * WebP provides 30-40% smaller files at equivalent quality.
 */

import { encode as encodeBlurhash } from 'blurhash';
import { encryptShard, ShardTier, type EncryptedShard, type EpochKey } from '@mosaic/crypto';

/** Max dimension for embedded thumbnails in manifest (150px) - small for bandwidth */
const EMBEDDED_MAX_SIZE = 150;

/** Default max dimension for thumbnail shards (450px) - HiDPI quality */
const THUMB_MAX_SIZE = 450;

/** Default max dimension for previews (1200px) */
const PREVIEW_MAX_SIZE = 1200;

/** Default JPEG quality for thumbnails (0-1) */
const THUMB_QUALITY = 0.8;

/** Default JPEG quality for previews (0-1) */
const PREVIEW_QUALITY = 0.85;

/** Maximum embedded thumbnail size in bytes (10KB) - for manifest */
const MAX_EMBEDDED_BYTES = 10 * 1024;

/** Maximum thumbnail shard size in bytes (80KB) - for HiDPI shards */
const MAX_THUMBNAIL_BYTES = 80 * 1024;

/** Maximum preview size in bytes (500KB) */
const MAX_PREVIEW_BYTES = 500 * 1024;

/** Supported image MIME types */
const SUPPORTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

// =============================================================================
// WebP Support Detection
// =============================================================================

/** Cached result of WebP support detection */
let webpSupportCache: boolean | null = null;

/**
 * Reset WebP support cache (for testing only)
 * @internal
 */
export function _resetWebPCache(): void {
  webpSupportCache = null;
}

/**
 * Detect if the browser supports WebP encoding via Canvas.toBlob()
 * Result is cached for performance.
 */
export function detectWebPSupport(): boolean {
  if (webpSupportCache !== null) {
    return webpSupportCache;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    // Check if toDataURL returns a WebP data URL
    const dataUrl = canvas.toDataURL('image/webp');
    webpSupportCache = dataUrl.startsWith('data:image/webp');
  } catch {
    webpSupportCache = false;
  }

  return webpSupportCache;
}

// =============================================================================
// AVIF Support Detection
// =============================================================================

/** Cached result of AVIF support detection */
let avifSupportCache: boolean | null = null;

/**
 * Reset AVIF support cache (for testing only)
 * @internal
 */
export function _resetAVIFCache(): void {
  avifSupportCache = null;
}

/**
 * Detect if the browser supports AVIF encoding via Canvas.toDataURL()
 * Result is cached for performance.
 */
export function detectAVIFSupport(): boolean {
  if (avifSupportCache !== null) {
    return avifSupportCache;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    // Check if toDataURL returns an AVIF data URL
    const dataUrl = canvas.toDataURL('image/avif');
    avifSupportCache = dataUrl.startsWith('data:image/avif');
  } catch {
    avifSupportCache = false;
  }

  return avifSupportCache;
}

/**
 * Get the preferred output format for thumbnails/previews
 * Priority: AVIF (best compression) > WebP > JPEG (fallback)
 */
export function getPreferredImageFormat(): 'image/avif' | 'image/webp' | 'image/jpeg' {
  if (detectAVIFSupport()) {
    return 'image/avif';
  }
  if (detectWebPSupport()) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/**
 * Options for thumbnail generation
 * Default settings are optimized for embedded manifest thumbnails (150px, 10KB max).
 * For larger thumbnail shards, use maxSize: 450 and maxBytes: 80*1024.
 */
export interface ThumbnailOptions {
  /** Maximum dimension (width or height) in pixels. Default: 150 (for manifest) */
  maxSize?: number;
  /** JPEG quality (0-1), default 0.8 */
  quality?: number;
  /** Maximum output size in bytes. Default: 10KB (for manifest) */
  maxBytes?: number;
}

/**
 * Result of thumbnail generation (single tier)
 */
export interface ThumbnailResult {
  /** Thumbnail image data as JPEG */
  data: Uint8Array;
  /** Thumbnail width in pixels */
  width: number;
  /** Thumbnail height in pixels */
  height: number;
  /** Original image width */
  originalWidth: number;
  /** Original image height */
  originalHeight: number;
  /** BlurHash string for instant placeholder (4x3 components, ~30 chars) */
  blurhash: string;
}

/**
 * Single tier image with dimensions
 */
export interface TierImageData {
  /** Image data (JPEG for resized, original format for full) */
  data: Uint8Array;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Shard tier (THUMB, PREVIEW, ORIGINAL) */
  tier: ShardTier;
}

/**
 * Encrypted shard with metadata for a single tier
 */
export interface TierShard {
  /** Encrypted shard data (envelope format) */
  encrypted: EncryptedShard;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Shard tier (THUMB, PREVIEW, ORIGINAL) */
  tier: ShardTier;
}

/**
 * Result of three-tier image generation
 */
export interface TieredImageResult {
  /** Thumbnail: 300px max dimension, ~80% quality JPEG */
  thumbnail: TierImageData;
  /** Preview: 1200px max dimension, ~85% quality JPEG */
  preview: TierImageData;
  /** Original: unchanged source file */
  original: TierImageData;
  /** Original image width (before any resizing) */
  originalWidth: number;
  /** Original image height (before any resizing) */
  originalHeight: number;
}

/**
 * Result of three-tier encrypted shard generation
 */
export interface TieredShardResult {
  /** Encrypted thumbnail shard */
  thumbnail: TierShard;
  /** Encrypted preview shard */
  preview: TierShard;
  /** Encrypted original shard */
  original: TierShard;
  /** Original image width (before any resizing) */
  originalWidth: number;
  /** Original image height (before any resizing) */
  originalHeight: number;
}

/**
 * Error thrown when thumbnail generation fails
 */
export class ThumbnailError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ThumbnailError';
  }
}

/**
 * Check if a file type is supported for thumbnail generation
 */
export function isSupportedImageType(mimeType: string): boolean {
  return SUPPORTED_TYPES.includes(mimeType.toLowerCase());
}

/**
 * Calculate thumbnail dimensions maintaining aspect ratio
 *
 * @param width - Original width
 * @param height - Original height
 * @param maxSize - Maximum dimension
 * @returns Scaled dimensions
 */
export function calculateDimensions(
  width: number,
  height: number,
  maxSize: number
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height };
  }

  if (width > height) {
    return {
      width: maxSize,
      height: Math.round((height * maxSize) / width),
    };
  } else {
    return {
      width: Math.round((width * maxSize) / height),
      height: maxSize,
    };
  }
}

/**
 * Extract EXIF orientation from JPEG data
 * Returns orientation value 1-8, or 1 (normal) if not found
 *
 * @param file - Image file to read
 * @returns EXIF orientation value
 */
async function getExifOrientation(file: File): Promise<number> {
  // Only JPEG has EXIF orientation in the header
  if (!file.type.includes('jpeg') && !file.type.includes('jpg')) {
    return 1;
  }

  try {
    // Read first 64KB which should contain EXIF data
    const slice = file.slice(0, 65536);
    const buffer = await slice.arrayBuffer();
    const view = new DataView(buffer);

    // Check for JPEG SOI marker
    if (view.getUint16(0) !== 0xffd8) {
      return 1;
    }

    // Scan for APP1 marker (EXIF)
    let offset = 2;
    while (offset < view.byteLength - 2) {
      const marker = view.getUint16(offset);

      // APP1 marker
      if (marker === 0xffe1) {
        const exifOffset = offset + 4;

        // Check for "Exif\0\0" identifier
        if (
          view.getUint32(exifOffset) === 0x45786966 &&
          view.getUint16(exifOffset + 4) === 0x0000
        ) {
          const tiffOffset = exifOffset + 6;

          // Check byte order (II = little endian, MM = big endian)
          const littleEndian = view.getUint16(tiffOffset) === 0x4949;

          // Get IFD0 offset
          const ifd0Offset =
            tiffOffset + view.getUint32(tiffOffset + 4, littleEndian);

          // Read number of directory entries
          const numEntries = view.getUint16(ifd0Offset, littleEndian);

          // Scan for orientation tag (0x0112)
          for (let i = 0; i < numEntries; i++) {
            const entryOffset = ifd0Offset + 2 + i * 12;
            const tag = view.getUint16(entryOffset, littleEndian);

            if (tag === 0x0112) {
              // Orientation tag found
              return view.getUint16(entryOffset + 8, littleEndian);
            }
          }
        }

        return 1;
      }

      // Skip to next marker
      if ((marker & 0xff00) === 0xff00) {
        offset += 2 + view.getUint16(offset + 2);
      } else {
        offset++;
      }
    }
  } catch {
    // Ignore EXIF parsing errors
  }

  return 1;
}

/**
 * Apply canvas transformations for EXIF orientation
 *
 * @param ctx - Canvas 2D context
 * @param width - Canvas width
 * @param height - Canvas height
 * @param orientation - EXIF orientation value (1-8)
 */
function applyOrientationTransform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  orientation: number
): void {
  switch (orientation) {
    case 2: // Flip horizontal
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3: // Rotate 180
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4: // Flip vertical
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5: // Transpose (rotate 90 CW + flip horizontal)
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6: // Rotate 90 CW
      ctx.transform(0, 1, -1, 0, height, 0);
      break;
    case 7: // Transverse (rotate 90 CCW + flip horizontal)
      ctx.transform(0, -1, -1, 0, height, width);
      break;
    case 8: // Rotate 90 CCW
      ctx.transform(0, -1, 1, 0, 0, width);
      break;
    default: // 1 or unknown = normal
      break;
  }
}

/**
 * Check if orientation requires swapping width/height
 */
function orientationSwapsDimensions(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Generate a thumbnail from an image file
 *
 * Uses createImageBitmap for efficient image decoding and Canvas API
 * for resizing. Handles EXIF orientation for rotated photos.
 * 
 * Default settings are optimized for embedded manifest thumbnails (150px, 10KB).
 * For larger thumbnail shards, the tiered generation uses THUMB_MAX_SIZE (450px).
 *
 * @param file - Image file to generate thumbnail from
 * @param options - Thumbnail options
 * @returns Thumbnail result with image data and dimensions
 * @throws ThumbnailError if generation fails
 */
export async function generateThumbnail(
  file: File,
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  const { maxSize = EMBEDDED_MAX_SIZE, quality = THUMB_QUALITY, maxBytes = MAX_EMBEDDED_BYTES } = options;

  // Validate file type
  if (!isSupportedImageType(file.type)) {
    throw new ThumbnailError(`Unsupported image type: ${file.type}`);
  }

  // Validate maxSize
  if (maxSize <= 0 || maxSize > 10000) {
    throw new ThumbnailError(`Invalid maxSize: ${maxSize}`);
  }

  // Validate quality
  if (quality <= 0 || quality > 1) {
    throw new ThumbnailError(`Invalid quality: ${quality}`);
  }

  try {
    // Get EXIF orientation before creating bitmap
    const orientation = await getExifOrientation(file);

    // Create bitmap for efficient decoding
    // Note: createImageBitmap automatically handles most image formats
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (error) {
      throw new ThumbnailError('Failed to decode image', error);
    }

    // Get original dimensions (before orientation)
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;

    // Swap dimensions if orientation requires it
    const swapDims = orientationSwapsDimensions(orientation);
    const logicalWidth = swapDims ? originalHeight : originalWidth;
    const logicalHeight = swapDims ? originalWidth : originalHeight;

    // Calculate thumbnail dimensions
    const dims = calculateDimensions(logicalWidth, logicalHeight, maxSize);

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new ThumbnailError('Failed to get canvas 2D context');
    }

    // Apply orientation transform
    applyOrientationTransform(ctx, dims.width, dims.height, orientation);

    // Draw and resize image
    // When orientation swaps dimensions, we need to draw with swapped dimensions
    if (swapDims) {
      ctx.drawImage(bitmap, 0, 0, dims.height, dims.width);
    } else {
      ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
    }

    // Clean up bitmap
    bitmap.close();

    // Generate blurhash from canvas image data (before JPEG encoding)
    // Use smaller dimensions for faster encoding while maintaining quality
    const blurhashWidth = Math.min(dims.width, 32);
    const blurhashHeight = Math.min(dims.height, 32);
    
    // Create a small canvas for blurhash to speed up encoding
    const blurhashCanvas = document.createElement('canvas');
    blurhashCanvas.width = blurhashWidth;
    blurhashCanvas.height = blurhashHeight;
    const blurhashCtx = blurhashCanvas.getContext('2d');
    if (!blurhashCtx) {
      throw new ThumbnailError('Failed to get blurhash canvas 2D context');
    }
    blurhashCtx.drawImage(canvas, 0, 0, blurhashWidth, blurhashHeight);
    const blurhashImageData = blurhashCtx.getImageData(0, 0, blurhashWidth, blurhashHeight);
    
    // Encode blurhash with 4x3 components for good quality/size balance (~30 chars)
    const blurhash = encodeBlurhash(
      blurhashImageData.data,
      blurhashWidth,
      blurhashHeight,
      4,  // componentX
      3   // componentY
    );

    // Use WebP if supported (30-40% smaller), fallback to JPEG
    const outputFormat = getPreferredImageFormat();
    
    // Convert to WebP/JPEG blob
    let blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputFormat, quality)
    );

    if (!blob) {
      throw new ThumbnailError(`Failed to encode thumbnail as ${outputFormat}`);
    }

    // If thumbnail is too large, reduce quality
    let currentQuality = quality;
    while (blob.size > maxBytes && currentQuality > 0.3) {
      currentQuality -= 0.1;
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, outputFormat, currentQuality)
      );
      if (!blob) {
        throw new ThumbnailError(`Failed to encode thumbnail as ${outputFormat}`);
      }
    }

    // Convert blob to Uint8Array
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    return {
      data,
      width: dims.width,
      height: dims.height,
      originalWidth: logicalWidth,
      originalHeight: logicalHeight,
      blurhash,
    };
  } catch (error) {
    if (error instanceof ThumbnailError) {
      throw error;
    }
    throw new ThumbnailError('Thumbnail generation failed', error);
  }
}

/**
 * Generate a base64-encoded thumbnail for embedding in manifest
 *
 * @param file - Image file to generate thumbnail from
 * @param options - Thumbnail options
 * @returns Base64-encoded JPEG string
 */
export async function generateThumbnailBase64(
  file: File,
  options: ThumbnailOptions = {}
): Promise<string> {
  const result = await generateThumbnail(file, options);
  return uint8ArrayToBase64(result.data);
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use btoa with binary string for browser compatibility
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)!;
  }
  return bytes;
}

/**
 * Resize an image to a maximum dimension using Canvas API.
 *
 * @param bitmap - Source image bitmap
 * @param maxSize - Maximum dimension (width or height)
 * @param quality - JPEG quality (0-1)
 * @param maxBytes - Maximum output size in bytes
 * @param orientation - EXIF orientation value (1-8)
 * @returns Resized image data and dimensions
 */
async function resizeImage(
  bitmap: ImageBitmap,
  maxSize: number,
  quality: number,
  maxBytes: number,
  orientation: number
): Promise<{ data: Uint8Array; width: number; height: number }> {
  // Swap dimensions if orientation requires it
  const swapDims = orientationSwapsDimensions(orientation);
  const logicalWidth = swapDims ? bitmap.height : bitmap.width;
  const logicalHeight = swapDims ? bitmap.width : bitmap.height;

  // Calculate target dimensions
  const dims = calculateDimensions(logicalWidth, logicalHeight, maxSize);

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = dims.width;
  canvas.height = dims.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new ThumbnailError('Failed to get canvas 2D context');
  }

  // Apply orientation transform
  applyOrientationTransform(ctx, dims.width, dims.height, orientation);

  // Draw and resize image
  if (swapDims) {
    ctx.drawImage(bitmap, 0, 0, dims.height, dims.width);
  } else {
    ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
  }

  // Use WebP if supported (30-40% smaller), fallback to JPEG
  const outputFormat = getPreferredImageFormat();

  // Convert to WebP/JPEG blob
  let blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputFormat, quality)
  );

  if (!blob) {
    throw new ThumbnailError(`Failed to encode image as ${outputFormat}`);
  }

  // If image is too large, reduce quality
  let currentQuality = quality;
  while (blob.size > maxBytes && currentQuality > 0.3) {
    currentQuality -= 0.1;
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputFormat, currentQuality)
    );
    if (!blob) {
      throw new ThumbnailError(`Failed to encode image as ${outputFormat}`);
    }
  }

  // Convert blob to Uint8Array
  const arrayBuffer = await blob.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  return {
    data,
    width: dims.width,
    height: dims.height,
  };
}

/**
 * Generate three-tier images from a photo file.
 *
 * Creates thumbnail (300px), preview (1200px), and keeps original.
 * Each tier is prepared for encryption with its corresponding key.
 *
 * @param file - Image file to process
 * @returns Three-tier image data with dimensions
 * @throws ThumbnailError if generation fails
 */
export async function generateTieredImages(file: File): Promise<TieredImageResult> {
  // Validate file type
  if (!isSupportedImageType(file.type)) {
    throw new ThumbnailError(`Unsupported image type: ${file.type}`);
  }

  try {
    // Get EXIF orientation before creating bitmap
    const orientation = await getExifOrientation(file);

    // Create bitmap for efficient decoding
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (error) {
      throw new ThumbnailError('Failed to decode image', error);
    }

    // Calculate logical dimensions (after EXIF rotation)
    const swapDims = orientationSwapsDimensions(orientation);
    const logicalWidth = swapDims ? bitmap.height : bitmap.width;
    const logicalHeight = swapDims ? bitmap.width : bitmap.height;

    // Generate thumbnail (300px max)
    const thumbData = await resizeImage(
      bitmap,
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
      MAX_THUMBNAIL_BYTES,
      orientation
    );

    // Generate preview (1200px max)
    const previewData = await resizeImage(
      bitmap,
      PREVIEW_MAX_SIZE,
      PREVIEW_QUALITY,
      MAX_PREVIEW_BYTES,
      orientation
    );

    // Clean up bitmap
    bitmap.close();

    // Get original file data
    const originalArrayBuffer = await file.arrayBuffer();
    const originalData = new Uint8Array(originalArrayBuffer);

    return {
      thumbnail: {
        data: thumbData.data,
        width: thumbData.width,
        height: thumbData.height,
        tier: ShardTier.THUMB,
      },
      preview: {
        data: previewData.data,
        width: previewData.width,
        height: previewData.height,
        tier: ShardTier.PREVIEW,
      },
      original: {
        data: originalData,
        width: logicalWidth,
        height: logicalHeight,
        tier: ShardTier.ORIGINAL,
      },
      originalWidth: logicalWidth,
      originalHeight: logicalHeight,
    };
  } catch (error) {
    if (error instanceof ThumbnailError) {
      throw error;
    }
    throw new ThumbnailError('Tiered image generation failed', error);
  }
}

/**
 * Generate three-tier encrypted shards from a photo file.
 *
 * Creates and encrypts thumbnail (300px), preview (1200px), and original.
 * Each tier is encrypted with its corresponding key from the EpochKey.
 *
 * @param file - Image file to process
 * @param epochKey - Epoch key with thumbKey, previewKey, fullKey
 * @param shardIndex - Shard index within photo (typically 0 for single-shard photos)
 * @returns Three-tier encrypted shards with metadata
 * @throws ThumbnailError if generation or encryption fails
 */
export async function generateTieredShards(
  file: File,
  epochKey: EpochKey,
  shardIndex: number = 0
): Promise<TieredShardResult> {
  // Generate the three tiers
  const tieredImages = await generateTieredImages(file);

  try {
    // Encrypt each tier with its corresponding key
    const [thumbEncrypted, previewEncrypted, originalEncrypted] = await Promise.all([
      encryptShard(
        tieredImages.thumbnail.data,
        epochKey.thumbKey,
        epochKey.epochId,
        shardIndex,
        ShardTier.THUMB
      ),
      encryptShard(
        tieredImages.preview.data,
        epochKey.previewKey,
        epochKey.epochId,
        shardIndex,
        ShardTier.PREVIEW
      ),
      encryptShard(
        tieredImages.original.data,
        epochKey.fullKey,
        epochKey.epochId,
        shardIndex,
        ShardTier.ORIGINAL
      ),
    ]);

    return {
      thumbnail: {
        encrypted: thumbEncrypted,
        width: tieredImages.thumbnail.width,
        height: tieredImages.thumbnail.height,
        tier: ShardTier.THUMB,
      },
      preview: {
        encrypted: previewEncrypted,
        width: tieredImages.preview.width,
        height: tieredImages.preview.height,
        tier: ShardTier.PREVIEW,
      },
      original: {
        encrypted: originalEncrypted,
        width: tieredImages.original.width,
        height: tieredImages.original.height,
        tier: ShardTier.ORIGINAL,
      },
      originalWidth: tieredImages.originalWidth,
      originalHeight: tieredImages.originalHeight,
    };
  } catch (error) {
    if (error instanceof ThumbnailError) {
      throw error;
    }
    throw new ThumbnailError('Failed to encrypt tiered shards', error);
  }
}
