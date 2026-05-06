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
interface DirectoryPickerOptions {
  readonly mode?: 'read' | 'readwrite';
  readonly startIn?: 'downloads';
}

type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';

interface FsAccessFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

interface FsAccessDirectoryHandle {
  queryPermission(desc: { readonly mode: 'readwrite' }): Promise<FileSystemPermissionState>;
  requestPermission(desc: { readonly mode: 'readwrite' }): Promise<FileSystemPermissionState>;
  getFileHandle(name: string, opts?: { readonly create?: boolean }): Promise<FsAccessFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries?: () => AsyncIterableIterator<readonly [string, unknown]>;
}

interface DirectoryPickerWindow {
  showDirectoryPicker(opts: DirectoryPickerOptions): Promise<FsAccessDirectoryHandle>;
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
  if (isFsAccessDirectoryAvailable()) return 'fsAccessDirectory';
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
    case 'fsAccessDirectory':
      return await createFsAccessDirectoryTarget(photos);
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
  if (isStrategyViable('fsAccessDirectory', photos)) return 'fsAccessDirectory';
  if (isStrategyViable('fsAccessPerFile', photos)) return 'fsAccessPerFile';
  if (isStrategyViable('blobAnchor', photos)) return 'blobAnchor';
  throw new Error('Per-file save is not available for this album in this browser. Try Save as ZIP.');
}

function isStrategyViable(strategy: PerFileStrategy, photos: ReadonlyArray<PerFilePhotoMeta>): boolean {
  switch (strategy) {
    case 'webShare':
      return isWebShareAvailable() && totalBytes(photos) <= WEB_SHARE_FILE_BUDGET_BYTES;
    case 'fsAccessDirectory':
      return isFsAccessDirectoryAvailable();
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

function isFsAccessDirectoryAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const fsAware = window as unknown as Partial<DirectoryPickerWindow>;
  // Runtime detection only: Edge passed the spike; Chrome desktop/Android still need manual UX verification.
  return typeof fsAware.showDirectoryPicker === 'function';
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


async function createFsAccessDirectoryTarget(_photos: ReadonlyArray<PerFilePhotoMeta>): Promise<PerFileSaveTarget> {
  const fsAware = window as unknown as Partial<DirectoryPickerWindow>;
  if (typeof fsAware.showDirectoryPicker !== 'function') {
    throw new Error('Directory File System Access picker is no longer available.');
  }
  const dirHandle = await fsAware.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
  await ensureDirectoryWritePermission(dirHandle);
  await confirmNonEmptyDirectory(dirHandle);
  const writtenNames = new Set<string>();
  const partialNames = new Set<string>();

  return {
    async openOne(filename: string): Promise<WritableStream<Uint8Array>> {
      await ensureDirectoryWritePermission(dirHandle);
      const safeName = await resolveDirectoryCollision(dirHandle, filename, writtenNames);
      const fileHandle = await dirHandle.getFileHandle(safeName, { create: true });
      const writable = await fileHandle.createWritable();
      partialNames.add(safeName);
      const writer = writable.getWriter();
      let committed = false;
      return new WritableStream<Uint8Array>({
        async write(chunk: Uint8Array): Promise<void> {
          await writer.ready;
          await writer.write(chunk);
        },
        async close(): Promise<void> {
          await writer.close();
          committed = true;
          partialNames.delete(safeName);
          writtenNames.add(safeName);
        },
        async abort(reason?: unknown): Promise<void> {
          try {
            await writer.abort(reason);
          } catch {
            // The underlying browser stream may already be closed after pipe abort propagation.
          }
          if (!committed) {
            partialNames.delete(safeName);
            await dirHandle.removeEntry(safeName).catch(() => undefined);
          }
        },
      });
    },
    async finalize(): Promise<void> {
      if (!isFsAccessDirectoryAvailable()) {
        throw new Error('Directory File System Access picker is no longer available.');
      }
      await ensureDirectoryWritePermission(dirHandle);
    },
    async abort(): Promise<void> {
      await Promise.all(Array.from(partialNames, async (name) => {
        await dirHandle.removeEntry(name).catch(() => undefined);
      }));
      partialNames.clear();
    },
  };
}

async function ensureDirectoryWritePermission(dirHandle: FsAccessDirectoryHandle): Promise<void> {
  const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return;
  const requested = await dirHandle.requestPermission({ mode: 'readwrite' });
  if (requested !== 'granted') {
    throw new Error('User declined directory write permission');
  }
}

async function confirmNonEmptyDirectory(dirHandle: FsAccessDirectoryHandle): Promise<void> {
  if (typeof dirHandle.entries !== 'function' || typeof window.confirm !== 'function') return;
  let count = 0;
  for await (const _entry of dirHandle.entries()) {
    count += 1;
    if (count > 100) break;
  }
  if (count === 0) return;
  const suffix = count > 100 ? '100+' : String(count);
  const accepted = window.confirm('This folder contains ' + suffix + ' other files. They won\'t be overwritten. Continue?');
  if (!accepted) {
    throw new DOMException('Directory selection cancelled', 'AbortError');
  }
}

async function resolveDirectoryCollision(dirHandle: FsAccessDirectoryHandle, filename: string, writtenNames: Set<string>): Promise<string> {
  let candidate = filename;
  let suffix = 2;
  while (writtenNames.has(candidate) || await directoryFileExists(dirHandle, candidate)) {
    candidate = appendFilenameSuffix(filename, suffix);
    suffix += 1;
  }
  return candidate;
}

async function directoryFileExists(dirHandle: FsAccessDirectoryHandle, filename: string): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(filename, { create: false });
    return true;
  } catch {
    return false;
  }
}

function appendFilenameSuffix(filename: string, suffix: number): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return filename + ' (' + String(suffix) + ')';
  return filename.slice(0, dot) + ' (' + String(suffix) + ')' + filename.slice(dot);
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
