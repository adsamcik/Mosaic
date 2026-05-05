/**
 * Shard Download Service
 *
 * Downloads encrypted photo shards from the server.
 * Handles network errors and supports progress callbacks.
 */

import { ApiError, getApi } from './api';
import { evictCachedShard, lookupCachedShardBytes } from './shard-cache';

/**
 * Progress callback for shard downloads
 * @param loaded - Bytes loaded so far
 * @param total - Total bytes (0 if unknown)
 */
export type ProgressCallback = (loaded: number, total: number) => void;

/**
 * Error thrown when shard download fails
 */
export class ShardDownloadError extends Error {
  constructor(
    public readonly shardId: string,
    public readonly cause: Error,
  ) {
    super(`Failed to download shard ${shardId}: ${cause.message}`);
    this.name = 'ShardDownloadError';
  }
}

/**
 * Download a single encrypted shard by ID
 *
 * @param shardId - The shard ID to download
 * @param onProgress - Optional progress callback
 * @returns The encrypted shard data as Uint8Array
 * @throws ShardDownloadError if download fails
 */
/** Build the shard-fetch URL for the authenticated endpoint. Exposed so the
 *  Background Fetch launcher can pre-warm the same URLs the SW will receive. */
export function buildAuthShardUrl(shardId: string): string {
  return `/api/shards/${shardId}`;
}

/** Build the share-link shard-fetch URL. */
export function buildShareLinkShardUrl(linkId: string, shardId: string): string {
  return `/api/s/${linkId}/shards/${shardId}`;
}

export async function downloadShard(
  shardId: string,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    // Background-Fetch cache peek: if the SW already pulled this shard
    // (e.g. while the tab was closed on Android), reuse the encrypted bytes.
    const cached = await lookupCachedShardBytes(buildAuthShardUrl(shardId));
    if (cached !== null) {
      onProgress?.(cached.length, cached.length);
      // Single-use eviction to bound storage; the SW will refetch if needed.
      void evictCachedShard(buildAuthShardUrl(shardId));
      return cached;
    }
    // Use the API client for simple downloads
    if (!onProgress) {
      const api = getApi();
      return await api.downloadShard(shardId);
    }

    // For progress tracking, use fetch directly with ReadableStream
    const response = await fetch(`/api/shards/${shardId}`, {
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText);
    }

    // Get content length for progress
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    // If no body or streaming not supported, fall back to simple read
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      onProgress(buffer.byteLength, buffer.byteLength);
      return new Uint8Array(buffer);
    }

    // Stream the response with progress updates
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }

    // Combine chunks into single array
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } catch (error) {
    if (error instanceof ShardDownloadError) {
      throw error;
    }
    throw new ShardDownloadError(
      shardId,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Download multiple shards in parallel with combined progress
 *
 * @param shardIds - Array of shard IDs to download
 * @param onProgress - Optional progress callback for total progress
 * @param maxConcurrent - Maximum concurrent downloads (default: 4)
 * @returns Array of encrypted shard data in the same order as shardIds
 * @throws ShardDownloadError if any download fails
 */
export async function downloadShards(
  shardIds: string[],
  onProgress?: ProgressCallback,
  maxConcurrent = 4,
): Promise<Uint8Array[]> {
  if (shardIds.length === 0) {
    return [];
  }

  // Track progress for each shard
  const shardProgress = new Map<string, { loaded: number; total: number }>();

  const updateProgress = () => {
    if (!onProgress) return;
    let loaded = 0;
    let total = 0;
    for (const p of shardProgress.values()) {
      loaded += p.loaded;
      total += p.total || p.loaded; // Use loaded as estimate if total unknown
    }
    onProgress(loaded, total);
  };

  // Download a single shard with progress tracking
  const downloadWithProgress = async (shardId: string): Promise<Uint8Array> => {
    shardProgress.set(shardId, { loaded: 0, total: 0 });
    return downloadShard(shardId, (loaded, total) => {
      shardProgress.set(shardId, { loaded, total });
      updateProgress();
    });
  };

  // Process shards in batches with concurrency limit
  const results: Uint8Array[] = [];

  for (let i = 0; i < shardIds.length; i += maxConcurrent) {
    const batch = shardIds.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map((shardId) => downloadWithProgress(shardId)),
    );
    results.push(...batchResults);
  }

  return results;
}
/**
 * Download a single encrypted shard via share link (anonymous access)
 *
 * @param linkId - The share link ID
 * @param shardId - The shard ID to download
 * @param grantToken - Optional grant token for limited-use share links
 * @param onProgress - Optional progress callback
 * @returns The encrypted shard data as Uint8Array
 * @throws ShardDownloadError if download fails
 */
export async function downloadShardViaShareLink(
  linkId: string,
  shardId: string,
  grantToken?: string,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    // Background-Fetch cache peek for the share-link URL.
    const url = buildShareLinkShardUrl(linkId, shardId);
    const cached = await lookupCachedShardBytes(url);
    if (cached !== null) {
      onProgress?.(cached.length, cached.length);
      void evictCachedShard(url);
      return cached;
    }
    const requestInit: RequestInit = {
      credentials: 'same-origin',
    };
    if (grantToken) {
      requestInit.headers = {
        'X-Share-Grant': grantToken,
      };
    }

    const response = await fetch(
      `/api/s/${linkId}/shards/${shardId}`,
      requestInit,
    );

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText);
    }

    // Get content length for progress
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    // If no body or streaming not supported, fall back to simple read
    if (!response.body || !onProgress) {
      const buffer = await response.arrayBuffer();
      onProgress?.(buffer.byteLength, buffer.byteLength);
      return new Uint8Array(buffer);
    }

    // Stream the response with progress updates
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }

    // Combine chunks into single array
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } catch (error) {
    if (error instanceof ShardDownloadError) {
      throw error;
    }
    throw new ShardDownloadError(
      shardId,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
