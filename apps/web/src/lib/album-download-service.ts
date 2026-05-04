import { downloadZip } from 'client-zip';

import { getCryptoClient } from './crypto-client';
import { getOrFetchEpochKey } from './epoch-key-service';
import { createLogger } from './logger';
import { downloadShards } from './shard-service';
import type { EpochHandleId, PhotoMeta } from '../workers/types';

const log = createLogger('AlbumDownloadService');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AlbumDownloadProgress {
  phase: 'preparing' | 'downloading' | 'complete' | 'cancelled' | 'error';
  currentFileName: string;
  completedFiles: number;
  totalFiles: number;
}

/**
 * Strategy for fetching + decrypting the original bytes of a single photo.
 *
 * Defaults to the authenticated user flow (epoch-key + `/api/shards/{id}`).
 * Share link viewers inject an alternate implementation that uses the public
 * share endpoint and tier-specific keys.
 */
export type AlbumDownloadResolver = (photo: PhotoMeta) => Promise<Uint8Array>;

export interface AlbumDownloadOptions {
  albumName: string;
  photos: PhotoMeta[];
  albumId: string;
  onProgress?: (progress: AlbumDownloadProgress) => void;
  signal?: AbortSignal;
  /**
   * Optional override for fetching + decrypting the original bytes of a
   * photo. When omitted, the authenticated user flow is used. Provide a
   * custom resolver for share-link viewers, who do not have access to
   * `getOrFetchEpochKey` or the authenticated `/api/shards/{id}` endpoint.
   */
  resolveOriginal?: AlbumDownloadResolver;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'album';
}

function deduplicateFilenames(photos: PhotoMeta[]): Map<string, string> {
  const nameMap = new Map<string, string>();
  const usedNames = new Map<string, number>();

  for (const photo of photos) {
    const name = photo.filename || `photo-${photo.id.slice(0, 8)}.jpg`;
    const count = usedNames.get(name) ?? 0;
    usedNames.set(name, count + 1);

    if (count === 0) {
      nameMap.set(photo.id, name);
    } else {
      const dotIdx = name.lastIndexOf('.');
      const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';
      nameMap.set(photo.id, `${base} (${count + 1})${ext}`);
    }
  }
  return nameMap;
}

function getOriginalShardIds(photo: PhotoMeta): string[] {
  if (photo.originalShardIds && photo.originalShardIds.length > 0) {
    return photo.originalShardIds;
  }
  // Legacy: [thumbnail, preview, ...originals]
  if (photo.shardIds.length > 2) {
    return photo.shardIds.slice(2);
  }
  return photo.shardIds;
}

function getOriginalShardHashes(photo: PhotoMeta): string[] | undefined {
  if (photo.originalShardHashes && photo.originalShardHashes.length > 0) {
    return photo.originalShardHashes;
  }
  if (photo.shardHashes && photo.shardHashes.length > 2) {
    return photo.shardHashes.slice(2);
  }
  return undefined;
}

export function supportsFileSystemAccess(): boolean {
  return 'showSaveFilePicker' in window;
}

// ---------------------------------------------------------------------------
// Write strategies
// ---------------------------------------------------------------------------

async function streamToFile(
  response: Response,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: 'ZIP Archive',
        accept: { 'application/zip': ['.zip'] },
      }],
    });

  const writable = await handle.createWritable();

  try {
    if (signal) {
      signal.addEventListener('abort', () => {
        writable.abort().catch(() => {});
      }, { once: true });
    }

    const pipeOptions: StreamPipeOptions = {};
    if (signal) pipeOptions.signal = signal;
    await response.body!.pipeTo(writable, pipeOptions);
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  }
}

async function blobDownload(
  response: Response,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const blob = await response.blob();

  if (signal?.aborted) return;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function downloadAlbumAsZip(options: AlbumDownloadOptions): Promise<void> {
  const { albumName, photos, albumId, onProgress, signal, resolveOriginal } = options;

  if (photos.length === 0) return;

  log.info('Starting album download', { albumName, count: photos.length });

  // Phase 1: Prepare filenames
  onProgress?.({
    phase: 'preparing',
    currentFileName: '',
    completedFiles: 0,
    totalFiles: photos.length,
  });
  const filenames = deduplicateFilenames(photos);

  // Default resolver: authenticated user flow (epoch handle + private shard
  // endpoint). The crypto client is resolved lazily but cached so we only
  // pay the worker handshake cost once per download even with many photos.
  let cryptoClientPromise: ReturnType<typeof getCryptoClient> | null = null;
  const getCryptoClientCached = () => {
    if (!cryptoClientPromise) cryptoClientPromise = getCryptoClient();
    return cryptoClientPromise;
  };

  const defaultResolver: AlbumDownloadResolver = async (photo) => {
    const crypto = await getCryptoClientCached();
    const bundle = await getOrFetchEpochKey(albumId, photo.epochId);

    const shardIds = getOriginalShardIds(photo);
    const shardHashes = getOriginalShardHashes(photo);

    const encryptedShards = await downloadShards(shardIds);

    const decryptedChunks: Uint8Array[] = [];
    for (let i = 0; i < encryptedShards.length; i++) {
      const shard = encryptedShards[i]!;

      if (shardHashes?.[i]) {
        const isValid = await crypto.verifyShard(shard, shardHashes[i]!);
        if (!isValid) {
          log.warn(`Shard integrity check failed for photo ${photo.id}, shard ${i}`);
        }
      }

      const plaintext = await crypto.decryptShardWithEpoch(
        bundle.epochHandleId as EpochHandleId,
        shard,
      );
      decryptedChunks.push(plaintext);
    }

    if (decryptedChunks.length === 1) return decryptedChunks[0]!;
    const totalSize = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of decryptedChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  };

  const resolve = resolveOriginal ?? defaultResolver;

  // Phase 2: Async generator that yields one decrypted file at a time
  async function* generateFiles() {
    let completed = 0;

    for (const photo of photos) {
      if (signal?.aborted) {
        onProgress?.({
          phase: 'cancelled',
          currentFileName: '',
          completedFiles: completed,
          totalFiles: photos.length,
        });
        return;
      }

      const filename = filenames.get(photo.id) || photo.filename;
      onProgress?.({
        phase: 'downloading',
        currentFileName: filename,
        completedFiles: completed,
        totalFiles: photos.length,
      });

      try {
        const photoData = await resolve(photo);

        yield {
          name: filename,
          lastModified: new Date(photo.takenAt || photo.createdAt),
          input: photoData,
        };

        completed++;
      } catch (err) {
        log.error(`Failed to process photo ${photo.id} (${filename})`, err);
        completed++;
      }
    }

    onProgress?.({
      phase: 'complete',
      currentFileName: '',
      completedFiles: completed,
      totalFiles: photos.length,
    });
  }

  // Phase 3: Create ZIP stream (STORE — no compression, photos are already compressed)
  const zipResponse = downloadZip(generateFiles());

  // Phase 4: Write to disk
  const zipFilename = `${sanitizeFilename(albumName)}.zip`;

  try {
    if (supportsFileSystemAccess()) {
      await streamToFile(zipResponse, zipFilename, signal);
    } else {
      await blobDownload(zipResponse, zipFilename, signal);
    }
  } catch (err) {
    // User cancelled the save dialog
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    throw err;
  }
}
