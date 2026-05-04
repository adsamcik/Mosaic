import { createLogger } from './logger';

const log = createLogger('SaveTarget');

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

/**
 * Open a user-side save target for a ZIP archive with the given suggested
 * filename.
 *
 * - Chrome/Edge: uses the File System Access API. Streams directly to disk
 *   with no intermediate buffering.
 * - Firefox/Safari fallback: returns a `WritableStream` that buffers the full
 *   archive in RAM until close, then triggers a blob anchor click. This is
 *   the same trade-off the legacy `downloadAlbumAsZip` flow already accepts;
 *   for very large archives the user should be on a Chromium browser.
 *
 * The returned stream is a normal `WritableStream<Uint8Array>` and is
 * structurally compatible with `Response.body.pipeTo`.
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
  return createBlobAnchorSink(fileName);
}

/**
 * Browser feature detect: true when File System Access API is available.
 * Exposed for UI hints (e.g. "best for desktop").
 */
export function supportsStreamingSave(): boolean {
  if (typeof window === 'undefined') return false;
  return 'showSaveFilePicker' in window;
}

function createBlobAnchorSink(fileName: string): WritableStream<Uint8Array> {
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
      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
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
