import * as tus from 'tus-js-client';
import { TUS_ENDPOINT } from '../api';
import { createLogger } from '../logger';

const log = createLogger('TusUpload');
const SHA256_HEX_BYTES = 32;
const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

export class UploadAuthRequiredError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication required to continue upload') {
    super(message);
    this.name = 'UploadAuthRequiredError';
  }
}

export function isUploadAuthRequiredError(error: unknown): error is UploadAuthRequiredError {
  return error instanceof UploadAuthRequiredError;
}

function getTusResponseStatus(error: Error | tus.DetailedError): number | undefined {
  return 'originalResponse' in error
    ? error.originalResponse?.getStatus()
    : undefined;
}

function isTusUnauthorizedError(error: Error | tus.DetailedError): boolean {
  const status = getTusResponseStatus(error);
  return status === 401 || /\b401\b|unauthori[sz]ed/i.test(error.message);
}

function isTusRetryableError(error: Error | tus.DetailedError): boolean {
  const status = getTusResponseStatus(error);
  if (status === undefined) return true;
  if (status >= 500) return true;
  return status === 408 || status === 409 || status === 423 || status === 429;
}

/**
 * Upload data via Tus resumable protocol
 * @param albumId - Album to upload to
 * @param data - Encrypted shard data
 * @param sha256 - SHA256 hash of the encrypted data for verification (base64url or hex)
 * @param shardIndex - Index of this shard in the file
 * @returns Shard ID from server
 */
export async function tusUpload(
  albumId: string,
  data: Uint8Array,
  sha256: string,
  shardIndex: number,
): Promise<string> {
  log.info(
    `TUS upload starting: albumId=${albumId}, shardIndex=${shardIndex}, size=${data.byteLength} bytes`,
  );
  return new Promise((resolve, reject) => {
    // Create a new ArrayBuffer to satisfy TypeScript's BlobPart type
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);

    const upload = new tus.Upload(new Blob([buffer]), {
      endpoint: TUS_ENDPOINT,
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: data.length, // Single chunk since shards are max 6MB
      metadata: {
        albumId,
        shardIndex: String(shardIndex),
        'content-sha256': sha256ToTusMetadataHex(sha256),
      },
      // Send credentials (cookies) with requests for authentication
      // In tus-js-client v2+, withCredentials is set via onBeforeRequest
      onBeforeRequest: (req) => {
        const xhr = req.getUnderlyingObject() as XMLHttpRequest;
        xhr.withCredentials = true;
        log.info(`TUS onBeforeRequest: setting withCredentials=true`);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
        log.info(
          `TUS progress: ${bytesUploaded}/${bytesTotal} (${percentage}%)`,
        );
      },
      onShouldRetry: (error) => isTusRetryableError(error),
      onError: (error) => {
        log.error(
          `TUS upload failed: albumId=${albumId}, shardIndex=${shardIndex}, error=${error.message}`,
        );
        if (isTusUnauthorizedError(error)) {
          reject(new UploadAuthRequiredError());
          return;
        }
        reject(new Error(`Upload failed: ${error.message}`));
      },
      onSuccess: () => {
        // Extract shard ID from the upload URL
        const url = upload.url;
        if (!url) {
          reject(new Error('No upload URL returned'));
          return;
        }
        // URL format: /api/files/{shardId}
        const shardId = url.substring(url.lastIndexOf('/') + 1);
        log.info(
          `TUS upload success: albumId=${albumId}, shardIndex=${shardIndex}, shardId=${shardId}`,
        );
        resolve(shardId);
      },
    });

    // Start the upload
    log.info(`TUS upload.start() called`);
    upload.start();
  });
}

function sha256ToTusMetadataHex(sha256: string): string {
  const trimmed = sha256.trim();
  if (LOWERCASE_SHA256_HEX.test(trimmed)) {
    return trimmed;
  }
  if (SHA256_HEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const bytes = base64UrlToBytes(trimmed);
  if (bytes.byteLength !== SHA256_HEX_BYTES) {
    throw new Error('Invalid SHA-256 hash for Tus metadata');
  }
  return bytesToHex(bytes);
}

function base64UrlToBytes(value: string): Uint8Array {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw new Error('Invalid SHA-256 hash for Tus metadata');
  }
  if (remainder !== 0) {
    normalized = normalized.padEnd(normalized.length + 4 - remainder, '=');
  }

  const binary = globalThis.atob(normalized);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
