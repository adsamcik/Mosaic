import { createLogger } from './logger';
import type { PerFilePhotoMeta, PerFileStrategy } from '../workers/types';

const log = createLogger('SaveTarget');

export const WEB_SHARE_FILE_BUDGET_BYTES = 100 * 1024 * 1024;
export const BLOB_ANCHOR_PHOTO_LIMIT = 50;

interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: ReadonlyArray<{
    readonly description?: string;
    readonly accept: Record<string, ReadonlyArray<string>>;
  }>;
}

interface SaveFilePickerWindow {
  showSaveFilePicker(opts: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}

interface ShareNavigator {
  canShare?(data: { readonly files?: readonly File[] }): boolean;
  share?(data: { readonly files?: readonly File[] }): Promise<void>;
}

export interface PerFileSaveTarget {
  openOne(filename: string, sizeBytes: number): Promise<WritableStream<Uint8Array>>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Open a user-side save target for a ZIP archive with the given suggested
 * filename.
 */
export async function openZipSaveTarget(fileName: string): Promise<WritableStream<Uint8Array>> {
  if (typeof window === 'undefined') {
    throw new Error('openZipSaveTarget requires a browser window');
  }
  const fsAware = window as unknown as Partial<SaveFilePickerWindow>;
  if (typeof fsAware.showSaveFilePicker === 'function') {
    try {
      const handle = await fsAware.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      return writable as unknown as WritableStream<Uint8Array>;
    } catch (err) {
      // User cancelled the picker - propagate as AbortError so callers can ignore it.
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      log.warn('showSaveFilePicker failed; falling back to blob anchor', {
        errorName: err instanceof Error ? err.name : 'Unknown',
      });
    }
  }
  return createBlobAnchorSink(fileName, 'application/zip');
}

/** Detect which per-file strategy is available on the current browser+device. */
export function detectPerFileStrategy(): PerFileStrategy | null {
  if (isWebShareAvailable()) return 'webShare';
  if (isFsAccessAvailable()) return 'fsAccessPerFile';
  if (isBlobAnchorAvailable()) return 'blobAnchor';
  return null;
}

/** Open a capability-checked per-file save target on the main thread. */
export async function openPerFileSaveTarget(
  strategy: PerFileStrategy,
  photos: ReadonlyArray<PerFilePhotoMeta>,
): Promise<PerFileSaveTarget> {
  if (typeof window === 'undefined') {
    throw new Error('openPerFileSaveTarget requires a browser window');
  }
  const resolved = resolvePerFileStrategy(strategy, photos);
  switch (resolved) {
    case 'webShare':
      return createWebShareTarget(photos);
    case 'fsAccessPerFile':
      return createFsAccessPerFileTarget();
    case 'blobAnchor':
      return createBlobAnchorPerFileTarget(photos.length);
    default: {
      const _exhaustive: never = resolved;
      throw new Error(`Unknown per-file strategy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Browser feature detect: true when File System Access API is available.
 * Exposed for UI hints (e.g. "best for desktop").
 */
export function supportsStreamingSave(): boolean {
  if (typeof window === 'undefined') return false;
  return 'showSaveFilePicker' in window;
}

function resolvePerFileStrategy(requested: PerFileStrategy, photos: ReadonlyArray<PerFilePhotoMeta>): PerFileStrategy {
  if (isStrategyViable(requested, photos)) return requested;
  if (isStrategyViable('webShare', photos)) return 'webShare';
  if (isStrategyViable('fsAccessPerFile', photos)) return 'fsAccessPerFile';
  if (isStrategyViable('blobAnchor', photos)) return 'blobAnchor';
  throw new Error('Per-file save is not available for this album in this browser. Try Save as ZIP.');
}

function isStrategyViable(strategy: PerFileStrategy, photos: ReadonlyArray<PerFilePhotoMeta>): boolean {
  switch (strategy) {
    case 'webShare':
      return isWebShareAvailable() && totalBytes(photos) <= WEB_SHARE_FILE_BUDGET_BYTES;
    case 'fsAccessPerFile':
      return isFsAccessAvailable();
    case 'blobAnchor':
      return isBlobAnchorAvailable() && photos.length <= BLOB_ANCHOR_PHOTO_LIMIT;
    default: {
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }
}

function isWebShareAvailable(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') return false;
  const shareNavigator = navigator as ShareNavigator;
  if (typeof shareNavigator.canShare !== 'function' || typeof shareNavigator.share !== 'function') return false;
  try {
    return shareNavigator.canShare({ files: [new File([], 'probe')] });
  } catch {
    return false;
  }
}

function isFsAccessAvailable(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

function isBlobAnchorAvailable(): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const anchor = document.createElement('a');
  return anchor.download !== undefined;
}

function createWebShareTarget(photos: ReadonlyArray<PerFilePhotoMeta>): PerFileSaveTarget {
  const budgetBytes = totalBytes(photos);
  if (budgetBytes > WEB_SHARE_FILE_BUDGET_BYTES) {
    throw new Error('Album is too large for Web Share file export. Try Save as ZIP.');
  }
  const files: File[] = [];
  let aborted = false;
  return {
    async openOne(filename: string): Promise<WritableStream<Uint8Array>> {
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk: Uint8Array): void {
          if (!aborted) chunks.push(chunk);
        },
        close(): void {
          if (aborted) return;
          files.push(new File(chunks as BlobPart[], filename));
        },
        abort(): void {
          chunks.length = 0;
        },
      });
    },
    async finalize(): Promise<void> {
      if (aborted) return;
      const shareNavigator = navigator as ShareNavigator;
      if (typeof shareNavigator.canShare !== 'function' || typeof shareNavigator.share !== 'function' || !shareNavigator.canShare({ files })) {
        throw new Error('Web Share file export is no longer available. Try Save as ZIP.');
      }
      await shareNavigator.share({ files });
    },
    async abort(): Promise<void> {
      aborted = true;
      files.length = 0;
    },
  };
}

function createFsAccessPerFileTarget(): PerFileSaveTarget {
  return {
    async openOne(filename: string): Promise<WritableStream<Uint8Array>> {
      const fsAware = window as unknown as Partial<SaveFilePickerWindow>;
      if (typeof fsAware.showSaveFilePicker !== 'function') {
        throw new Error('File System Access save picker is no longer available.');
      }
      const handle = await fsAware.showSaveFilePicker({ suggestedName: filename });
      return await handle.createWritable() as unknown as WritableStream<Uint8Array>;
    },
    async finalize(): Promise<void> {
      return undefined;
    },
    async abort(): Promise<void> {
      return undefined;
    },
  };
}

function createBlobAnchorPerFileTarget(photoCount: number): PerFileSaveTarget {
  if (photoCount > BLOB_ANCHOR_PHOTO_LIMIT) {
    throw new Error('Too many photos for individual browser downloads. Try Save as ZIP.');
  }
  return {
    async openOne(filename: string): Promise<WritableStream<Uint8Array>> {
      return createBlobAnchorSink(filename, 'application/octet-stream');
    },
    async finalize(): Promise<void> {
      return undefined;
    },
    async abort(): Promise<void> {
      return undefined;
    },
  };
}

function createBlobAnchorSink(fileName: string, type: string): WritableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let aborted = false;
  return new WritableStream<Uint8Array>({
    write(chunk: Uint8Array): void {
      if (!aborted) {
        chunks.push(chunk);
      }
    },
    close(): void {
      if (aborted) return;
      const blob = new Blob(chunks as BlobPart[], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1_000);
    },
    abort(): void {
      aborted = true;
      chunks.length = 0;
    },
  });
}

function totalBytes(photos: ReadonlyArray<PerFilePhotoMeta>): number {
  return photos.reduce((sum, photo) => sum + photo.sizeBytes, 0);
}
