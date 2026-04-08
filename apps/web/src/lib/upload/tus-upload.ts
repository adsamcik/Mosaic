import * as tus from 'tus-js-client';
import { TUS_ENDPOINT } from '../api';
import { createLogger } from '../logger';

const log = createLogger('TusUpload');

/**
 * Upload data via Tus resumable protocol
 * @param albumId - Album to upload to
 * @param data - Encrypted shard data
 * @param sha256 - SHA256 hash of the encrypted data for verification
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
        sha256,
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
      onError: (error) => {
        log.error(
          `TUS upload failed: albumId=${albumId}, shardIndex=${shardIndex}, error=${error.message}`,
        );
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
