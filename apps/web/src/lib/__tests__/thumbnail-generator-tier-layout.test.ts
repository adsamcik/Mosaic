import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initRustWasm, { initSync } from '../../generated/mosaic-wasm/mosaic_wasm.js';
import { generateTieredImages, getCanonicalTierLayout } from '../thumbnail-generator';

vi.mock('../settings-service', () => ({
  shouldStoreOriginalsAsAvif: vi.fn(() => false),
}));

const WASM_BYTES_PATH = resolve(
  process.cwd(),
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);

function createJpegFile(): File {
  return new File([
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  ], 'canonical.jpg', { type: 'image/jpeg' });
}

describe('thumbnail generator canonical tier layout', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalCreateElement = document.createElement.bind(document);
  let mockCanvas: HTMLCanvasElement;

  beforeAll(async () => {
    initSync({ module: readFileSync(WASM_BYTES_PATH) });
    await initRustWasm();
  });

  beforeEach(() => {
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({
      width: 2000,
      height: 1500,
      close: vi.fn(),
    } as unknown as ImageBitmap);

    const mockContext = {
      drawImage: vi.fn(),
      transform: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(32 * 32 * 4).fill(128),
        width: 32,
        height: 32,
      }),
      createImageData: vi.fn().mockImplementation((width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockContext),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['mock-image'], { type: 'image/jpeg' }))),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas;
      return originalCreateElement(tagName);
    });
  });

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  it('emits thumbnail and preview dimensions from the WASM canonical layout', async () => {
    const layout = await getCanonicalTierLayout();

    expect(layout.thumbnail.width).toBe(256);
    expect(layout.thumbnail.height).toBe(256);
    expect(layout.preview.width).toBe(1024);
    expect(layout.preview.height).toBe(1024);

    const result = await generateTieredImages(createJpegFile());

    expect(result.thumbnail.width).toBe(layout.thumbnail.width);
    expect(result.thumbnail.height).toBe(192);
    expect(result.preview.width).toBe(layout.preview.width);
    expect(result.preview.height).toBe(768);
    expect(result.thumbnail.width).not.toBe(600);
    expect(result.preview.width).not.toBe(1200);
  });
});
