/**
 * MIME Type Detection Utility
 *
 * Detects image and video MIME types from file magic bytes, which is more reliable
 * than relying on browser-provided file.type (especially for HEIC/HEIF files).
 *
 * Supports:
 *   Images: JPEG, PNG, GIF, WebP, AVIF, HEIC/HEIF, BMP, TIFF, SVG
 *   Videos: MP4, WebM, QuickTime (MOV), Matroska (MKV)
 */

/**
 * Supported image MIME types that can be detected
 */
export type SupportedImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/heic'
  | 'image/heif'
  | 'image/bmp'
  | 'image/tiff'
  | 'image/svg+xml';

/**
 * Supported video MIME types that can be detected
 */
export type SupportedVideoMimeType =
  | 'video/mp4'
  | 'video/webm'
  | 'video/quicktime'
  | 'video/x-matroska';

/**
 * All supported MIME types (images + videos)
 */
export type SupportedMimeType = SupportedImageMimeType | SupportedVideoMimeType;

/**
 * Supported video MIME types
 */
export const SUPPORTED_VIDEO_TYPES: SupportedVideoMimeType[] = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
];

/**
 * Supported image MIME types
 */
export const SUPPORTED_IMAGE_TYPES: SupportedImageMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
];

/**
 * All supported media types (images + videos)
 */
export const SUPPORTED_MEDIA_TYPES: SupportedMimeType[] = [
  ...SUPPORTED_IMAGE_TYPES,
  ...SUPPORTED_VIDEO_TYPES,
];

/**
 * Magic byte signatures for image format detection
 */
interface MagicSignature {
  /** Byte sequence to match */
  bytes: number[];
  /** Offset from file start */
  offset: number;
  /** MIME type if matched */
  mime: SupportedMimeType;
}

// Simple magic byte patterns (matched at start of file)
const SIMPLE_SIGNATURES: MagicSignature[] = [
  // JPEG: FFD8FF
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mime: 'image/jpeg' },
  // PNG: 89504E47 0D0A1A0A
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
    mime: 'image/png',
  },
  // GIF87a or GIF89a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], offset: 0, mime: 'image/gif' },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], offset: 0, mime: 'image/gif' },
  // BMP: BM
  { bytes: [0x42, 0x4d], offset: 0, mime: 'image/bmp' },
  // TIFF: II or MM (little or big endian)
  { bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0, mime: 'image/tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0, mime: 'image/tiff' },
  // WebP: RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: 'image/webp' }, // RIFF header, further check below
];

/**
 * Detect MIME type from file magic bytes
 *
 * Reads the first 32 bytes of a file to detect its actual format.
 * This is more reliable than file.type which browsers often get wrong,
 * especially for HEIC/HEIF files.
 *
 * @param file - File or Blob to detect MIME type from
 * @returns Detected MIME type, or null if unknown
 */
export async function detectMimeType(
  file: File | Blob,
): Promise<SupportedMimeType | null> {
  // Read first 64 bytes for detection (EBML DocType needs more than 32)
  const slice = file.slice(0, 64);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check simple signatures first
  for (const sig of SIMPLE_SIGNATURES) {
    if (matchBytes(bytes, sig.bytes, sig.offset)) {
      // Special case: WebP needs additional check for "WEBP" at offset 8
      if (sig.mime === 'image/webp') {
        if (matchBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
          return 'image/webp';
        }
        continue; // Not a WebP, might be another RIFF format
      }
      return sig.mime;
    }
  }

  // Check for ISOBMFF-based formats (HEIC, HEIF, AVIF, MP4, MOV)
  // These have "ftyp" at offset 4
  if (matchBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return detectIsobmffFormat(bytes);
  }

  // Check for EBML-based formats (WebM, MKV)
  // EBML header: 1A 45 DF A3
  if (matchBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3], 0)) {
    return detectEbmlFormat(bytes);
  }

  // Check SVG (XML-based, look for <?xml or <svg)
  if (isSvg(bytes)) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * Detect ISOBMFF format from ftyp box
 *
 * HEIC, HEIF, and AVIF are all ISOBMFF (ISO Base Media File Format) containers.
 * The brand code at offset 8 identifies the specific format.
 *
 * Note: Many HEIC files use 'mif1' as the major brand with 'heic' in compatible brands.
 * We must check compatible brands to correctly identify these files.
 */
function detectIsobmffFormat(bytes: Uint8Array): SupportedMimeType | null {
  // Brand starts at offset 8 (4 bytes)
  const brand = String.fromCharCode(
    bytes[8]!,
    bytes[9]!,
    bytes[10]!,
    bytes[11]!,
  );

  // HEIC brands (HEVC-based) - check first since it's most specific
  if (
    brand === 'heic' ||
    brand === 'heix' ||
    brand === 'hevc' ||
    brand === 'hevx'
  ) {
    return 'image/heic';
  }

  // AVIF brands - check before mif1 fallback
  if (brand === 'avif' || brand === 'avis') {
    return 'image/avif';
  }

  // QuickTime brand
  if (brand === 'qt  ') {
    return 'video/quicktime';
  }

  // MP4 video brands
  if (
    brand === 'isom' ||
    brand === 'iso2' ||
    brand === 'mp41' ||
    brand === 'mp42' ||
    brand === 'avc1' ||
    brand === 'dash'
  ) {
    return 'video/mp4';
  }

  // mif1/msf1/miaf are generic ISOBMFF brands - need to check compatible brands
  // Many Apple HEIC files use mif1 as major brand with heic in compatible brands
  if (brand === 'mif1' || brand === 'msf1' || brand === 'miaf') {
    const compatBrands = getCompatibleBrands(bytes);

    // Check for HEIC in compatible brands (common for Apple HEIC files)
    if (
      compatBrands.includes('heic') ||
      compatBrands.includes('heix') ||
      compatBrands.includes('hevc') ||
      compatBrands.includes('hevx')
    ) {
      return 'image/heic';
    }

    // Check for AVIF in compatible brands
    if (compatBrands.includes('avif') || compatBrands.includes('avis')) {
      return 'image/avif';
    }

    // Default to HEIF for generic mif1 containers
    return 'image/heif';
  }

  return null;
}

/**
 * Get compatible brands from ISOBMFF ftyp box
 */
function getCompatibleBrands(bytes: Uint8Array): string[] {
  // Box size is at offset 0 (4 bytes, big-endian)
  const boxSize =
    (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  const brands: string[] = [];

  // Compatible brands start at offset 16, each is 4 bytes
  // Box structure: size(4) + type(4) + major_brand(4) + minor_version(4) + compatible_brands[]
  for (let i = 16; i + 4 <= boxSize && i + 4 <= bytes.length; i += 4) {
    const brand = String.fromCharCode(
      bytes[i]!,
      bytes[i + 1]!,
      bytes[i + 2]!,
      bytes[i + 3]!,
    );
    brands.push(brand);
  }

  return brands;
}

/**
 * Detect EBML-based format (WebM or Matroska) from header
 *
 * EBML files start with 0x1A45DFA3. The DocType element inside the header
 * identifies the specific format: "webm" or "matroska".
 */
function detectEbmlFormat(bytes: Uint8Array): SupportedMimeType {
  // Search for DocType string within the EBML header bytes
  // DocType is encoded as an EBML string element; look for the ASCII text
  const str = new TextDecoder('ascii').decode(bytes);

  if (str.includes('matroska')) {
    return 'video/x-matroska';
  }

  if (str.includes('webm')) {
    return 'video/webm';
  }

  // Default to WebM if DocType can't be determined (more common)
  return 'video/webm';
}

/**
 * Check if bytes match a signature at given offset
 */
function matchBytes(
  data: Uint8Array,
  signature: number[],
  offset: number,
): boolean {
  if (data.length < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (data[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Check if file appears to be SVG
 */
function isSvg(bytes: Uint8Array): boolean {
  // Convert to string and check for XML declaration or SVG element
  const str = new TextDecoder().decode(bytes).toLowerCase().trim();
  return (
    str.startsWith('<?xml') || str.startsWith('<svg') || str.includes('<svg')
  );
}

/**
 * Get the best MIME type for a file
 *
 * First tries to detect from magic bytes, falls back to file.type,
 * and finally falls back to extension-based detection.
 *
 * @param file - File to detect MIME type from
 * @returns MIME type string
 */
export async function getMimeType(file: File): Promise<string> {
  // Try magic byte detection first
  const detected = await detectMimeType(file);
  if (detected) {
    return detected;
  }

  // Fall back to browser-provided type if non-empty
  if (file.type && file.type !== 'application/octet-stream') {
    return file.type;
  }

  // Fall back to extension-based detection
  return getMimeTypeFromExtension(file.name);
}

/**
 * Get MIME type from file extension
 */
export function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';

  const extensionMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
  };

  return extensionMap[ext] || 'application/octet-stream';
}

/**
 * Check if a MIME type represents an image that needs decoding
 * before it can be displayed in a browser
 *
 * HEIC/HEIF are not natively supported by most browsers and need
 * to be decoded to a displayable format.
 *
 * @param mimeType - MIME type to check
 * @returns true if the format needs decoding
 */
export function needsDecoding(mimeType: string): boolean {
  const lowerMime = mimeType.toLowerCase();
  return lowerMime === 'image/heic' || lowerMime === 'image/heif';
}

/**
 * Check if a MIME type represents a video format
 */
export function isVideoType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('video/');
}

/**
 * Check if a MIME type is a supported video type
 */
export function isSupportedVideoType(mimeType: string): boolean {
  return (SUPPORTED_VIDEO_TYPES as readonly string[]).includes(
    mimeType.toLowerCase(),
  );
}

/**
 * Check if a MIME type is a supported image type
 */
export function isSupportedImageType(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(
    mimeType.toLowerCase(),
  );
}

/**
 * Check if a MIME type represents an image format
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

/**
 * Get a display-friendly format name
 */
export function getFormatName(mimeType: string): string {
  const formatNames: Record<string, string> = {
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
    'image/avif': 'AVIF',
    'image/heic': 'HEIC',
    'image/heif': 'HEIF',
    'image/bmp': 'BMP',
    'image/tiff': 'TIFF',
    'image/svg+xml': 'SVG',
    'video/mp4': 'MP4',
    'video/webm': 'WebM',
    'video/quicktime': 'MOV',
    'video/x-matroska': 'MKV',
  };

  return formatNames[mimeType.toLowerCase()] || mimeType;
}
