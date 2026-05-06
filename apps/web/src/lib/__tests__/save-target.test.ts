import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerFilePhotoMeta } from '../../workers/types';

type ShowSaveFilePicker = (opts: { readonly suggestedName?: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;

describe('save-target', () => {
  let originalShowSaveFilePicker: unknown;
  let originalCanShare: unknown;
  let originalShare: unknown;
  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    originalShowSaveFilePicker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    originalCanShare = (navigator as unknown as { canShare?: unknown }).canShare;
    originalShare = (navigator as unknown as { share?: unknown }).share;
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    setBlobAnchorSupport(true);
  });

  afterEach(() => {
    restoreProperty(window as unknown as Record<string, unknown>, 'showSaveFilePicker', originalShowSaveFilePicker);
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
