/**
 * Image Decoder Decompression-Bomb Guards (M5)
 *
 * Verifies that the entry point `safeCreateImageBitmap` enforces:
 *   - an input-size cap (rejects with `ImageTooLargeError`)
 *   - a decoded-dimension cap (rejects with `ImageDimensionsExceededError`)
 *   - a wall-clock timeout (rejects with `ImageDecodeTimeoutError`)
 *
 * Also covers a happy-path regression on a small valid PNG.
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

import {
  safeCreateImageBitmap,
  MAX_INPUT_BYTES,
  MAX_DECODED_PIXELS,
  DECODE_TIMEOUT_MS,
  ImageTooLargeError,
  ImageDimensionsExceededError,
  ImageDecodeTimeoutError,
} from '../image-decoder';

type CreateImageBitmapFn = typeof globalThis.createImageBitmap;

describe('image-decoder constants', () => {
  it('caps input at 100 MB', () => {
    expect(MAX_INPUT_BYTES).toBe(100 * 1024 * 1024);
  });

  it('caps decoded pixels at 200 megapixels', () => {
    expect(MAX_DECODED_PIXELS).toBe(200_000_000);
  });

  it('times out decode at 30 seconds', () => {
    expect(DECODE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('safeCreateImageBitmap', () => {
  let originalCreateImageBitmap: CreateImageBitmapFn | undefined;

  beforeEach(() => {
    originalCreateImageBitmap = globalThis.createImageBitmap;
  });

  afterEach(() => {
    if (originalCreateImageBitmap) {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    } else {
      // happy-dom may not provide createImageBitmap natively; clean up our stub
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects a blob larger than MAX_INPUT_BYTES with ImageTooLargeError', async () => {
    // Faux blob that reports 200 MB without allocating real memory.
    const oversized = {
      size: 200 * 1024 * 1024,
      type: 'image/jpeg',
    } as Blob;

    await expect(safeCreateImageBitmap(oversized)).rejects.toBeInstanceOf(
      ImageTooLargeError,
    );
  });

  it('rejects decoded dimensions over MAX_DECODED_PIXELS and closes the bitmap', async () => {
    const close = vi.fn();
    const fakeBitmap = { width: 50_000, height: 50_000, close };

    globalThis.createImageBitmap = vi
      .fn()
      .mockResolvedValue(fakeBitmap) as unknown as CreateImageBitmapFn;

    const blob = new Blob([new Uint8Array([0, 0, 0, 0])], {
      type: 'image/png',
    });

    await expect(safeCreateImageBitmap(blob)).rejects.toBeInstanceOf(
      ImageDimensionsExceededError,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects with ImageDecodeTimeoutError when decode never resolves', async () => {
    vi.useFakeTimers();

    globalThis.createImageBitmap = vi
      .fn()
      .mockReturnValue(new Promise<never>(() => {})) as unknown as CreateImageBitmapFn;

    const blob = new Blob([new Uint8Array([0, 0, 0, 0])], {
      type: 'image/png',
    });

    let caught: unknown;
    const pending = safeCreateImageBitmap(blob).catch((err) => {
      caught = err;
    });

    await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 100);
    await pending;

    expect(caught).toBeInstanceOf(ImageDecodeTimeoutError);
  });

  it('decodes a small valid PNG without errors (happy path)', async () => {
    const close = vi.fn();
    globalThis.createImageBitmap = vi
      .fn()
      .mockResolvedValue({ width: 1, height: 1, close }) as unknown as CreateImageBitmapFn;

    // Minimal valid 1x1 PNG (transparent pixel)
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const blob = new Blob([pngBytes], { type: 'image/png' });

    const result = await safeCreateImageBitmap(blob);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(blob, {
      imageOrientation: 'none',
    });
    expect(close).not.toHaveBeenCalled();
  });

  describe('AVIF <img>-element fallback', () => {
    type ImageCtor = typeof globalThis.Image;
    let originalImage: ImageCtor | undefined;
    let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
    let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;

    beforeEach(() => {
      originalImage = globalThis.Image;
      originalCreateObjectURL = URL.createObjectURL;
      originalRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
      if (originalImage) {
        globalThis.Image = originalImage;
      }
      if (originalCreateObjectURL) {
        URL.createObjectURL = originalCreateObjectURL;
      }
      if (originalRevokeObjectURL) {
        URL.revokeObjectURL = originalRevokeObjectURL;
      }
    });

    it('falls back to <img>-element decode when createImageBitmap rejects an AVIF blob', async () => {
      // First call (the AVIF blob) fails like real Chromium does on some
      // valid AVIF fixtures; second call (the canvas-based path) succeeds.
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

      // happy-dom's canvas getContext('2d') returns null; stub a minimal ctx.
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = vi
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

      // Stub HTMLImageElement so onload fires synchronously with a valid size.
      globalThis.Image = vi.fn().mockImplementation(function (
        this: HTMLImageElement,
      ) {
        const self = this as unknown as {
          naturalWidth: number;
          naturalHeight: number;
          onload: (() => void) | null;
          onerror: (() => void) | null;
          src: string;
        };
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

      const blob = new Blob([new Uint8Array([0, 0, 0, 32])], {
        type: 'image/avif',
      });

      const result = await safeCreateImageBitmap(blob);
      expect(result).toBe(successBitmap);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
      // First call was on the blob; second call was on the canvas element.
      expect(createImageBitmapMock.mock.calls[0]?.[0]).toBe(blob);
      expect(createImageBitmapMock.mock.calls[1]?.[0]).not.toBe(blob);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');

      createElementSpy.mockRestore();
    });

    it('does not invoke the <img> fallback for non-AVIF blobs', async () => {
      const createImageBitmapMock = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('boom'), { name: 'InvalidStateError' }),
        );
      globalThis.createImageBitmap =
        createImageBitmapMock as unknown as CreateImageBitmapFn;

      const blob = new Blob([new Uint8Array([0, 0, 0, 1])], {
        type: 'image/png',
      });

      await expect(safeCreateImageBitmap(blob)).rejects.toThrow('boom');
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it('propagates ImageDecodeTimeoutError without attempting fallback', async () => {
      vi.useFakeTimers();
      globalThis.createImageBitmap = vi
        .fn()
        .mockReturnValue(new Promise<never>(() => {})) as unknown as CreateImageBitmapFn;
      // Spy on Image to prove it's never constructed.
      const ImageSpy = vi.fn();
      globalThis.Image = ImageSpy as unknown as ImageCtor;

      const blob = new Blob([new Uint8Array([0, 0, 0, 1])], {
        type: 'image/avif',
      });

      let caught: unknown;
      const pending = safeCreateImageBitmap(blob).catch((err) => {
        caught = err;
      });
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 100);
      await pending;

      expect(caught).toBeInstanceOf(ImageDecodeTimeoutError);
      expect(ImageSpy).not.toHaveBeenCalled();
    });
  });
});
