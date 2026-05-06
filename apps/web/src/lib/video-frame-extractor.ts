/**
 * Video Frame Extractor
 *
 * Extracts thumbnails and metadata from video files using HTMLVideoElement.
 * Used during upload to generate preview images before encryption.
 *
 * This runs on the main thread (not in a Worker) because HTMLVideoElement
 * requires DOM access.
 *
 * Flow: File → blob URL → HTMLVideoElement → seek → Canvas → thumbnails + ThumbHash
 */

import { rgbaToThumbHash } from 'thumbhash';
import { getPreferredImageFormat } from './thumbnail-generator';
import { getCanonicalTierMaxSizes } from './exif-stripper';
import { createLogger } from './logger';

const log = createLogger('VideoFrameExtractor');

/** Max dimension for embedded thumbnails in manifest (300px) */
const EMBEDDED_MAX_SIZE = 300;

/** Default quality for thumbnail output (0-1) */
const THUMB_QUALITY = 0.8;

/** Maximum embedded thumbnail size in bytes (25KB) */
const MAX_EMBEDDED_BYTES = 25 * 1024;

/** Timeout for the entire extraction operation (30 seconds) */
const EXTRACTION_TIMEOUT_MS = 30_000;

/** Max ThumbHash source dimension */
const THUMBHASH_MAX_SIZE = 100;

// =============================================================================
// Public Types
// =============================================================================

export interface VideoMetadata {
  /** Video duration in seconds */
  duration: number;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Detected codec string from the browser (if available) */
  codec?: string;
}

export interface VideoFrameResult {
  /** Extracted metadata */
  metadata: VideoMetadata;
  /** Thumbnail blob (WASM canonical max dimension, JPEG/WebP) */
  thumbnailBlob: Blob;
  /** Thumbnail dimensions */
  thumbnailWidth: number;
  thumbnailHeight: number;
  /** Base64-encoded embedded thumbnail (300px max, for manifest) */
  embeddedThumbnail: string;
  /** Embedded thumbnail dimensions */
  embeddedWidth: number;
  embeddedHeight: number;
  /** ThumbHash string (base64, ~25 bytes) for instant blur placeholder */
  thumbhash: string;
}

// =============================================================================
// Error Class
// =============================================================================

export class VideoFrameError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VideoFrameError';
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Calculate scaled dimensions maintaining aspect ratio.
 * Fits within maxSize on the largest dimension.
 */
function calculateDimensions(
  width: number,
  height: number,
  maxSize: number,
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

/** Convert Uint8Array to base64 string */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Convert a Blob to a base64 data URL */
async function blobToBase64DataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Draw the current video frame onto a canvas at the specified dimensions.
 * Returns the canvas for further processing.
 */
function drawVideoFrame(
  video: HTMLVideoElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new VideoFrameError('Failed to get canvas 2D context');
  }

  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

/**
 * Export a canvas as a Blob, reducing quality if needed to stay under maxBytes.
 */
async function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: string,
  quality: number,
  maxBytes: number,
): Promise<Blob> {
  let blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, format, quality),
  );

  if (!blob) {
    throw new VideoFrameError(`Failed to encode frame as ${format}`);
  }

  let currentQuality = quality;
  while (blob.size > maxBytes && currentQuality > 0.3) {
    currentQuality -= 0.1;
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, format, currentQuality),
    );
    if (!blob) {
      throw new VideoFrameError(`Failed to encode frame as ${format}`);
    }
  }

  return blob;
}

/**
 * Generate a ThumbHash from a canvas.
 * Scales down to ~100px max and encodes RGBA pixel data.
 */
function generateThumbHash(canvas: HTMLCanvasElement): string {
  const w = Math.min(canvas.width, THUMBHASH_MAX_SIZE);
  const h = Math.min(canvas.height, THUMBHASH_MAX_SIZE);

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = w;
  thumbCanvas.height = h;

  const ctx = thumbCanvas.getContext('2d');
  if (!ctx) {
    throw new VideoFrameError('Failed to get thumbhash canvas 2D context');
  }

  ctx.drawImage(canvas, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  const hashBytes = rgbaToThumbHash(w, h, imageData.data);
  return uint8ArrayToBase64(hashBytes);
}

/**
 * Detect the video codec from a loaded HTMLVideoElement (best-effort).
 * Uses the browser's MediaCapabilities API hint from the video element.
 */
function detectCodec(video: HTMLVideoElement): string | undefined {
  // Some browsers expose videoTracks with codec info
  try {
    const tracks = (video as unknown as { videoTracks?: { length: number; getTrackById: (id: string) => unknown; 0?: { id?: string; label?: string } } }).videoTracks;
    if (tracks && tracks.length > 0 && tracks[0]) {
      const track = tracks[0] as { id?: string; label?: string };
      if (track.label) {
        return track.label;
      }
    }
  } catch {
    // Not available in all browsers
  }
  return undefined;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract a frame and metadata from a video file.
 *
 * Uses HTMLVideoElement to load the video, seek to a representative frame,
 * and capture it via Canvas. Generates both a WASM-canonical thumbnail
 * for shard storage and a 300px embedded thumbnail for the manifest.
 *
 * @param file - Video file to extract frame from
 * @returns Frame extraction result with metadata, thumbnails, and ThumbHash
 * @throws VideoFrameError if extraction fails or times out
 */
export async function extractVideoFrame(file: File): Promise<VideoFrameResult> {
  let blobUrl: string | null = null;
  let video: HTMLVideoElement | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await new Promise<VideoFrameResult>((resolve, reject) => {
      // Timeout guard
      timeoutId = setTimeout(() => {
        reject(new VideoFrameError(`Video frame extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`));
      }, EXTRACTION_TIMEOUT_MS);

      blobUrl = URL.createObjectURL(file);
      video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      // Prevent browser from showing video in picture-in-picture or similar
      video.playsInline = true;

      const currentVideo = video;
      const currentBlobUrl = blobUrl;

      const handleError = () => {
        const mediaError = currentVideo.error;
        const code = mediaError?.code ?? 'unknown';
        const message = mediaError?.message ?? 'Unknown video error';
        reject(new VideoFrameError(`Failed to load video: code=${code}, ${message}`));
      };

      currentVideo.addEventListener('error', handleError, { once: true });

      currentVideo.addEventListener(
        'loadedmetadata',
        () => {
          const duration = currentVideo.duration;
          const width = currentVideo.videoWidth;
          const height = currentVideo.videoHeight;

          // Validate metadata
          if (!width || !height) {
            reject(new VideoFrameError('Video has no valid dimensions (width=0 or height=0)'));
            return;
          }

          if (!isFinite(duration) || duration <= 0) {
            reject(new VideoFrameError(`Video has invalid duration: ${duration}`));
            return;
          }

          const codec = detectCodec(currentVideo);

          // Seek to representative frame: 1s or 10% of duration, whichever is less
          currentVideo.currentTime = Math.min(1, duration * 0.1);

          currentVideo.addEventListener(
            'seeked',
            async () => {
              try {
                const metadata: VideoMetadata = {
                  duration,
                  width,
                  height,
                  ...(codec ? { codec } : {}),
                };

                const outputFormat = getPreferredImageFormat();
                const tierMaxSizes = await getCanonicalTierMaxSizes();

                // Draw WASM-canonical thumbnail
                const thumbDims = calculateDimensions(width, height, tierMaxSizes.thumbnail);
                const thumbCanvas = drawVideoFrame(currentVideo, thumbDims.width, thumbDims.height);
                const thumbnailBlob = await canvasToBlob(
                  thumbCanvas,
                  outputFormat,
                  THUMB_QUALITY,
                  120 * 1024, // 120KB max for thumbnail shard
                );

                // Draw 300px embedded thumbnail
                const embDims = calculateDimensions(width, height, EMBEDDED_MAX_SIZE);
                const embCanvas = drawVideoFrame(currentVideo, embDims.width, embDims.height);
                const embBlob = await canvasToBlob(
                  embCanvas,
                  'image/jpeg',
                  THUMB_QUALITY,
                  MAX_EMBEDDED_BYTES,
                );
                const embeddedThumbnail = await blobToBase64DataUrl(embBlob);

                // Generate ThumbHash from the thumbnail canvas
                const thumbhash = generateThumbHash(thumbCanvas);

                log.debug('Video frame extracted', {
                  filename: file.name,
                  duration: metadata.duration,
                  dimensions: `${width}x${height}`,
                  thumbSize: `${thumbDims.width}x${thumbDims.height}`,
                  embSize: `${embDims.width}x${embDims.height}`,
                  thumbnailBytes: thumbnailBlob.size,
                  embeddedBytes: embBlob.size,
                });

                resolve({
                  metadata,
                  thumbnailBlob,
                  thumbnailWidth: thumbDims.width,
                  thumbnailHeight: thumbDims.height,
                  embeddedThumbnail,
                  embeddedWidth: embDims.width,
                  embeddedHeight: embDims.height,
                  thumbhash,
                });
              } catch (err) {
                reject(
                  err instanceof VideoFrameError
                    ? err
                    : new VideoFrameError('Failed to capture video frame', err),
                );
              }
            },
            { once: true },
          );
        },
        { once: true },
      );

      // Set source to trigger loading
      currentVideo.src = currentBlobUrl;
    });

    return result;
  } catch (error) {
    if (error instanceof VideoFrameError) {
      throw error;
    }
    throw new VideoFrameError('Video frame extraction failed', error);
  } finally {
    // Cleanup
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    // video is assigned inside the Promise callback, which CFA doesn't track
    const videoEl = video as HTMLVideoElement | null;
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load(); // Reset the element
      video = null;
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }
}

/**
 * Format a duration in seconds to a human-readable string.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string (e.g., "1:02", "1:01:01", "0:05")
 *
 * @example
 * formatDuration(5)    // "0:05"
 * formatDuration(62)   // "1:02"
 * formatDuration(3661) // "1:01:01"
 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const paddedSecs = secs.toString().padStart(2, '0');

  if (hrs > 0) {
    const paddedMins = mins.toString().padStart(2, '0');
    return `${hrs}:${paddedMins}:${paddedSecs}`;
  }

  return `${mins}:${paddedSecs}`;
}
