/**
 * Regression: WebP + BMP `<img>`-element fallback (v1.0.x isolated-v2-02)
 *
 * Chromium's `createImageBitmap` rejects some otherwise-valid tiny WebP
 * (VP8L lossless) and 24-bpp BMP fixtures with `InvalidStateError`. The same
 * blobs decode correctly via an `HTMLImageElement`. `safeCreateImageBitmap`
 * therefore transparently retries via `<img>` for the MIME types in the
 * allow-list. This file exercises the dispatch logic for the two new
 * entries (WebP, BMP) and proves that previously-supported formats are not
 * regressed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { safeCreateImageBitmap } from '../image-decoder';

type CreateImageBitmapFn = typeof globalThis.createImageBitmap;
type ImageCtor = typeof globalThis.Image;

interface MockImage {
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
}

function installImageStub(): ImageCtor | undefined {
  const original = globalThis.Image;
  globalThis.Image = vi.fn().mockImplementation(function (this: MockImage) {
    const self = this;
    self.naturalWidth = 2;
    self.naturalHeight = 2;
    self.onload = null;
    self.onerror = null;
    Object.defineProperty(self, 'src', {
      set(_value: string) {
        queueMicrotask(() => self.onload?.());
      },
      get() {
        return '';
      },
    });
    return self as unknown as HTMLImageElement;
  }) as unknown as ImageCtor;
  return original;
}

function installCanvasStub(): () => void {
  const originalCreateElement = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'canvas') {
        (el as HTMLCanvasElement).getContext = vi
          .fn()
          .mockReturnValue({ drawImage: vi.fn() }) as unknown as HTMLCanvasElement['getContext'];
      }
      return el;
    });
  return () => spy.mockRestore();
}

describe('safeCreateImageBitmap <img>-element fallback (WebP/BMP)', () => {
  let originalCreateImageBitmap: CreateImageBitmapFn | undefined;
  let originalImage: ImageCtor | undefined;
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
  let restoreCanvas: (() => void) | undefined;

  beforeEach(() => {
    originalCreateImageBitmap = globalThis.createImageBitmap;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    originalImage = installImageStub();
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    if (originalCreateImageBitmap) {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
    if (originalImage) {
      globalThis.Image = originalImage;
    }
    if (originalCreateObjectURL) {
      URL.createObjectURL = originalCreateObjectURL;
    }
    if (originalRevokeObjectURL) {
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
    restoreCanvas?.();
  });

  it.each([
    ['image/webp'],
    ['image/bmp'],
    ['image/x-ms-bmp'],
  ])(
    'falls back to <img>-element decode when createImageBitmap rejects a %s blob',
    async (mime) => {
      const close = vi.fn();
      const successBitmap = { width: 2, height: 2, close };
      const createImageBitmapMock = vi
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject(
            Object.assign(new Error('The source image could not be decoded.'), {
              name: 'InvalidStateError',
            }),
          ),
        )
        .mockResolvedValueOnce(successBitmap);
      globalThis.createImageBitmap =
        createImageBitmapMock as unknown as CreateImageBitmapFn;

      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime });
      const result = await safeCreateImageBitmap(blob);

      expect(result).toBe(successBitmap);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
      // First call was on the blob; second call was on the canvas element.
      expect(createImageBitmapMock.mock.calls[0]?.[0]).toBe(blob);
      expect(createImageBitmapMock.mock.calls[1]?.[0]).not.toBe(blob);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    },
  );

  it.each([
    ['image/png'],
    ['image/jpeg'],
    ['image/gif'],
  ])(
    'does not invoke the <img> fallback for an unsupported MIME (%s)',
    async (mime) => {
      const createImageBitmapMock = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('boom'), { name: 'InvalidStateError' }),
        );
      globalThis.createImageBitmap =
        createImageBitmapMock as unknown as CreateImageBitmapFn;

      const blob = new Blob([new Uint8Array([0, 0, 0, 1])], { type: mime });

      await expect(safeCreateImageBitmap(blob)).rejects.toThrow('boom');
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    },
  );
});
