import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerFilePhotoMeta } from '../../workers/types';

type ShowSaveFilePicker = (opts: { readonly suggestedName?: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';
type ShowDirectoryPicker = (opts: { readonly mode?: 'read' | 'readwrite'; readonly startIn?: 'downloads' }) => Promise<FakeDirectoryHandle>;

interface FakeFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

interface FakeDirectoryHandle {
  queryPermission(desc: { readonly mode: 'readwrite' }): Promise<FileSystemPermissionState>;
  requestPermission(desc: { readonly mode: 'readwrite' }): Promise<FileSystemPermissionState>;
  getFileHandle(name: string, opts?: { readonly create?: boolean }): Promise<FakeFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries?: () => AsyncIterableIterator<readonly [string, unknown]>;
}


describe('save-target', () => {
  let originalShowSaveFilePicker: unknown;
  let originalShowDirectoryPicker: unknown;
  let originalCanShare: unknown;
  let originalShare: unknown;
  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    originalShowSaveFilePicker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    originalShowDirectoryPicker = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    originalCanShare = (navigator as unknown as { canShare?: unknown }).canShare;
    originalShare = (navigator as unknown as { share?: unknown }).share;
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    setBlobAnchorSupport(true);
  });

  afterEach(() => {
    restoreProperty(window as unknown as Record<string, unknown>, 'showSaveFilePicker', originalShowSaveFilePicker);
    restoreProperty(window as unknown as Record<string, unknown>, 'showDirectoryPicker', originalShowDirectoryPicker);
    restoreProperty(navigator as unknown as Record<string, unknown>, 'canShare', originalCanShare);
    restoreProperty(navigator as unknown as Record<string, unknown>, 'share', originalShare);
    restoreProperty(URL as unknown as Record<string, unknown>, 'createObjectURL', originalCreateObjectUrl);
    restoreProperty(URL as unknown as Record<string, unknown>, 'revokeObjectURL', originalRevokeObjectUrl);
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  describe('openZipSaveTarget', () => {
    it('uses the File System Access path when available', async () => {
      const writable = new WritableStream<Uint8Array>();
      const fakeHandle = {
        createWritable: vi.fn(async () => writable),
      };
      const showSpy: ShowSaveFilePicker = vi.fn(async () => fakeHandle);
      (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker = showSpy;
      const { openZipSaveTarget } = await import('../save-target');
      const result = await openZipSaveTarget('album.zip');
      expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'album.zip' }));
      expect(fakeHandle.createWritable).toHaveBeenCalled();
      expect(result).toBe(writable);
    });

    it('falls back to blob anchor when File System Access is unavailable', async () => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      const clickSpy = mockAnchorClicks();
      const { openZipSaveTarget } = await import('../save-target');
      const stream = await openZipSaveTarget('album.zip');
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1, 2, 3, 4]));
      await writer.close();
      expect(clickSpy).toHaveBeenCalled();
    });

    it('rethrows AbortError when the user cancels showSaveFilePicker', async () => {
      const showSpy: ShowSaveFilePicker = vi.fn(async () => {
        throw new DOMException('User cancelled', 'AbortError');
      });
      (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker = showSpy;
      const { openZipSaveTarget } = await import('../save-target');
      await expect(openZipSaveTarget('a.zip')).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('detectPerFileStrategy', () => {
    it('prefers Web Share files when available', async () => {
      setWebShareSupport(true);
      setFsAccessSupport(true);
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBe('webShare');
    });

    it('uses File System Access when Web Share files are unavailable', async () => {
      setWebShareSupport(false);
      setFsAccessSupport(true);
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBe('fsAccessPerFile');
    });

    it('prefers directory File System Access over per-file picker when Web Share files are unavailable', async () => {
      setWebShareSupport(false);
      setFsAccessSupport(true);
      setFsDirectorySupport(makeDirectoryHandle());
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBe('fsAccessDirectory');
    });

    it('keeps Web Share first when directory File System Access is also available', async () => {
      setWebShareSupport(true);
      setFsAccessSupport(true);
      setFsDirectorySupport(makeDirectoryHandle());
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBe('webShare');
    });

    it('falls back to blob anchor downloads', async () => {
      setWebShareSupport(false);
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBe('blobAnchor');
    });

    it('returns null when no per-file strategy is viable', async () => {
      setWebShareSupport(false);
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      setBlobAnchorSupport(false);
      const { detectPerFileStrategy } = await import('../save-target');
      expect(detectPerFileStrategy()).toBeNull();
    });
  });

  describe('openPerFileSaveTarget', () => {
    const photos: PerFilePhotoMeta[] = [
      { photoId: 'p1', filename: 'one.jpg', sizeBytes: 3 },
      { photoId: 'p2', filename: 'two.jpg', sizeBytes: 2 },
    ];

    it('buffers Web Share files and shares once on finalize', async () => {
      const shareSpy = setWebShareSupport(true);
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('webShare', photos);
      await writeAll(await target.openOne('one.jpg', 3), [1, 2, 3]);
      await writeAll(await target.openOne('two.jpg', 2), [4, 5]);
      await target.finalize();
      expect(shareSpy).toHaveBeenCalledTimes(1);
      const data = shareSpy.mock.calls[0]?.[0];
      expect(data?.files).toHaveLength(2);
    });

    it('opens showSaveFilePicker once per photo for fsAccessPerFile', async () => {
      setWebShareSupport(false);
      const showSpy = setFsAccessSupport(true);
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('fsAccessPerFile', photos);
      await writeAll(await target.openOne('one.jpg', 3), [1]);
      await writeAll(await target.openOne('two.jpg', 2), [2]);
      expect(showSpy).toHaveBeenCalledTimes(2);
      expect(showSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ suggestedName: 'one.jpg' }));
    });

    it('writes all photos into one picked directory for fsAccessDirectory', async () => {
      setWebShareSupport(false);
      const dirHandle = makeDirectoryHandle();
      const showDirectorySpy = setFsDirectorySupport(dirHandle);
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('fsAccessDirectory', photos);
      await writeAll(await target.openOne('one.jpg', 3), [1, 2, 3]);
      await writeAll(await target.openOne('two.jpg', 2), [4, 5]);
      await target.finalize();
      expect(showDirectorySpy).toHaveBeenCalledWith({ mode: 'readwrite', startIn: 'downloads' });
      expect(dirHandle.queryPermission).toHaveBeenCalled();
      expect(dirHandle.getFileHandle).toHaveBeenCalledWith('one.jpg', { create: true });
      expect(dirHandle.getFileHandle).toHaveBeenCalledWith('two.jpg', { create: true });
    });

    it('throws when directory write permission is denied', async () => {
      setWebShareSupport(false);
      const dirHandle = makeDirectoryHandle({ queryPermission: 'prompt', requestPermission: 'denied' });
      setFsDirectorySupport(dirHandle);
      const { openPerFileSaveTarget } = await import('../save-target');
      await expect(openPerFileSaveTarget('fsAccessDirectory', photos)).rejects.toThrow('User declined directory write permission');
    });

    it('suffixes duplicate directory filenames instead of overwriting', async () => {
      setWebShareSupport(false);
      const dirHandle = makeDirectoryHandle();
      setFsDirectorySupport(dirHandle);
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('fsAccessDirectory', photos);
      await writeAll(await target.openOne('IMG_0001.jpg', 1), [1]);
      await writeAll(await target.openOne('IMG_0001.jpg', 1), [2]);
      expect(dirHandle.getFileHandle).toHaveBeenCalledWith('IMG_0001.jpg', { create: true });
      expect(dirHandle.getFileHandle).toHaveBeenCalledWith('IMG_0001 (2).jpg', { create: true });
    });

    it('removes a partial directory file after abort', async () => {
      setWebShareSupport(false);
      const dirHandle = makeDirectoryHandle();
      setFsDirectorySupport(dirHandle);
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('fsAccessDirectory', photos);
      const stream = await target.openOne('partial.jpg', 1);
      const writer = stream.getWriter();
      await writer.write(new Uint8Array([1]));
      await writer.abort('cancelled');
      expect(dirHandle.removeEntry).toHaveBeenCalledWith('partial.jpg');
    });

    it('creates blob URLs and clicks anchors for blobAnchor', async () => {
      setWebShareSupport(false);
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      const clickSpy = mockAnchorClicks();
      const { openPerFileSaveTarget } = await import('../save-target');
      const target = await openPerFileSaveTarget('blobAnchor', photos);
      await writeAll(await target.openOne('one.jpg', 3), [1, 2, 3]);
      await writeAll(await target.openOne('two.jpg', 2), [4, 5]);
      expect(clickSpy).toHaveBeenCalledTimes(2);
    });
  });
});

function restoreProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
  } else {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
}

function setWebShareSupport(enabled: boolean): ReturnType<typeof vi.fn<(data: { readonly files?: readonly File[] }) => Promise<void>>> {
  const shareSpy = vi.fn(async (_data: { readonly files?: readonly File[] }) => undefined);
  Object.defineProperty(navigator, 'canShare', {
    value: enabled ? vi.fn(() => true) : undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, 'share', {
    value: enabled ? shareSpy : undefined,
    configurable: true,
    writable: true,
  });
  return shareSpy;
}

function setFsAccessSupport(enabled: boolean): ReturnType<typeof vi.fn<ShowSaveFilePicker>> {
  const showSpy: ReturnType<typeof vi.fn<ShowSaveFilePicker>> = vi.fn(async () => ({
    createWritable: vi.fn(async () => new WritableStream<Uint8Array>()),
  }));
  if (enabled) {
    (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker = showSpy;
  } else {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  }
  return showSpy;
}

function setBlobAnchorSupport(enabled: boolean): void {
  Object.defineProperty(URL, 'createObjectURL', { value: enabled ? vi.fn(() => 'blob:test') : undefined, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: enabled ? vi.fn() : undefined, configurable: true, writable: true });
}

function mockAnchorClicks(): ReturnType<typeof vi.fn> {
  const clickSpy = vi.fn();
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      Object.defineProperty(el, 'click', { value: clickSpy, configurable: true });
    }
    return el as HTMLElement;
  });
  return clickSpy;
}

async function writeAll(stream: WritableStream<Uint8Array>, bytes: readonly number[]): Promise<void> {
  const writer = stream.getWriter();
  await writer.write(new Uint8Array(bytes));
  await writer.close();
}

function setFsDirectorySupport(dirHandle: FakeDirectoryHandle): ReturnType<typeof vi.fn<ShowDirectoryPicker>> {
  const showSpy: ReturnType<typeof vi.fn<ShowDirectoryPicker>> = vi.fn(async () => dirHandle);
  (window as unknown as { showDirectoryPicker: ShowDirectoryPicker }).showDirectoryPicker = showSpy;
  return showSpy;
}

function makeDirectoryHandle(opts: { readonly queryPermission?: FileSystemPermissionState; readonly requestPermission?: FileSystemPermissionState; readonly existingNames?: ReadonlySet<string> } = {}): FakeDirectoryHandle {
  const queryPermission = vi.fn(async () => opts.queryPermission ?? 'granted');
  const requestPermission = vi.fn(async () => opts.requestPermission ?? 'granted');
  const getFileHandle = vi.fn(async (name: string, handleOpts?: { readonly create?: boolean }) => {
    if (handleOpts?.create !== true && opts.existingNames?.has(name) !== true) {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return { createWritable: vi.fn(async () => new WritableStream<Uint8Array>()) };
  });
  return {
    queryPermission,
    requestPermission,
    getFileHandle,
    removeEntry: vi.fn(async () => undefined),
    entries: async function* entries(): AsyncIterableIterator<readonly [string, unknown]> {
      for (const name of opts.existingNames ?? []) {
        yield [name, {}] as const;
      }
    },
  };
}
