/**
 * Thumbnail Generator Service
 *
 * Generates thumbnail images from photos using the Canvas API.
 * Handles EXIF orientation, maintains aspect ratio, and outputs
 * compressed JPEG for efficient storage.
 */

/** Default max dimension for thumbnails */
const DEFAULT_MAX_SIZE = 300;

/** Default JPEG quality (0-1) */
const DEFAULT_QUALITY = 0.8;

/** Maximum thumbnail size in bytes (50KB) */
const MAX_THUMBNAIL_BYTES = 50 * 1024;

/** Supported image MIME types */
const SUPPORTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/**
 * Options for thumbnail generation
 */
export interface ThumbnailOptions {
  /** Maximum dimension (width or height) in pixels */
  maxSize?: number;
  /** JPEG quality (0-1), default 0.8 */
  quality?: number;
}

/**
 * Result of thumbnail generation
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
 * @param file - Image file to generate thumbnail from
 * @param options - Thumbnail options
 * @returns Thumbnail result with image data and dimensions
 * @throws ThumbnailError if generation fails
 */
export async function generateThumbnail(
  file: File,
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  const { maxSize = DEFAULT_MAX_SIZE, quality = DEFAULT_QUALITY } = options;

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

    // Convert to JPEG blob
    let blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    );

    if (!blob) {
      throw new ThumbnailError('Failed to encode thumbnail as JPEG');
    }

    // If thumbnail is too large, reduce quality
    let currentQuality = quality;
    while (blob.size > MAX_THUMBNAIL_BYTES && currentQuality > 0.3) {
      currentQuality -= 0.1;
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', currentQuality)
      );
      if (!blob) {
        throw new ThumbnailError('Failed to encode thumbnail as JPEG');
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
