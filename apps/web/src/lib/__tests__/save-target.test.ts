import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('openZipSaveTarget', () => {
  let originalFn: unknown;
  beforeEach(() => {
    originalFn = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  afterEach(() => {
    if (originalFn === undefined) {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    } else {
      (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = originalFn;
    }
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('uses the File System Access path when available', async () => {
    const writable = new WritableStream<Uint8Array>();
    const fakeHandle = {
      createWritable: vi.fn(async () => writable),
    };
    const showSpy = vi.fn(async () => fakeHandle);
    (window as unknown as { showSaveFilePicker: typeof showSpy }).showSaveFilePicker = showSpy;
    const { openZipSaveTarget } = await import('../save-target');
    const result = await openZipSaveTarget('album.zip');
    expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'album.zip' }));
    expect(fakeHandle.createWritable).toHaveBeenCalled();
    expect(result).toBe(writable);
  });

  it('falls back to blob anchor when File System Access is unavailable', async () => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: clickSpy, configurable: true });
      }
      return el as HTMLElement;
    });
    const { openZipSaveTarget } = await import('../save-target');
    const stream = await openZipSaveTarget('album.zip');
    const writer = stream.getWriter();
    await writer.write(new Uint8Array([1, 2, 3, 4]));
    await writer.close();
    expect(clickSpy).toHaveBeenCalled();
  });

  it('rethrows AbortError when the user cancels showSaveFilePicker', async () => {
    const showSpy = vi.fn(async () => {
      throw new DOMException('User cancelled', 'AbortError');
    });
    (window as unknown as { showSaveFilePicker: typeof showSpy }).showSaveFilePicker = showSpy;
    const { openZipSaveTarget } = await import('../save-target');
    await expect(openZipSaveTarget('a.zip')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
