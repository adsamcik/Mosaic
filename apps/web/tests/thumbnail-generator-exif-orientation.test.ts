import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateThumbnail } from '../src/lib/thumbnail-generator';

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type CornerLabels = readonly [string, string, string, string];

interface SourceImageInfo {
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly orientation: number;
  readonly corners: CornerLabels;
}

interface MockBitmap {
  readonly width: number;
  readonly height: number;
  readonly sourceCorners: CornerLabels;
  close: () => void;
}

interface EncodedCanvasPayload {
  readonly width: number;
  readonly height: number;
  readonly corners: CornerLabels;
}

const sourceImages = new WeakMap<Blob, SourceImageInfo>();

const rawCorners: CornerLabels = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

function orientationSwapsDimensions(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

function orientedCorners(corners: CornerLabels, orientation: number): CornerLabels {
  const [topLeft, topRight, bottomLeft, bottomRight] = corners;

  switch (orientation) {
    case 3:
      return [bottomRight, bottomLeft, topRight, topLeft];
    case 6:
      return [bottomLeft, topLeft, bottomRight, topRight];
    case 8:
      return [topRight, bottomRight, topLeft, bottomLeft];
    default:
      return [topLeft, topRight, bottomLeft, bottomRight];
  }
}

function orientationFromTransform(
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  if (a === -1 && b === 0 && c === 0 && d === -1) {
    return 3;
  }
  if (a === 0 && b === 1 && c === -1 && d === 0) {
    return 6;
  }
  if (a === 0 && b === -1 && c === 1 && d === 0) {
    return 8;
  }
  return 1;
}

function isMockBitmap(source: unknown): source is MockBitmap {
  return (
    source !== null &&
    typeof source === 'object' &&
    'sourceCorners' in source &&
    'close' in source
  );
}

class MockCanvas {
  width = 0;
  height = 0;
  corners: CornerLabels = ['blank', 'blank', 'blank', 'blank'];

  private readonly context = new MockCanvasContext(this);

  getContext = vi.fn((contextId: string) => {
    if (contextId !== '2d') {
      return null;
    }
    return this.context as unknown as CanvasRenderingContext2D;
  });

  toBlob = vi.fn((callback: BlobCallback, format = 'image/png') => {
    const payload: EncodedCanvasPayload = {
      width: this.width,
      height: this.height,
      corners: this.corners,
    };
    callback(new Blob([JSON.stringify(payload)], { type: format }));
  });

  toDataURL = vi.fn((format = 'image/png') => `data:${format};base64,AAAA`);
}

class MockCanvasContext {
  private orientation = 1;

  constructor(private readonly canvas: MockCanvas) {}

  transform = vi.fn(
    (
      a: number,
      b: number,
      c: number,
      d: number,
      _e: number,
      _f: number,
    ) => {
      this.orientation = orientationFromTransform(a, b, c, d);
    },
  );

  drawImage = vi.fn((source: CanvasImageSource) => {
    if (isMockBitmap(source)) {
      this.canvas.corners = orientedCorners(
        source.sourceCorners,
        this.orientation,
      );
      return;
    }

    if (source instanceof MockCanvas) {
      this.canvas.corners = source.corners;
    }
  });

  getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4).fill(128),
    width,
    height,
  }));

  createImageData = vi.fn((width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  }));

  putImageData = vi.fn();
}

function createExifJpegFile(
  orientation: number,
  rawWidth = 1200,
  rawHeight = 800,
): File {
  const exifBytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01,
    0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xd9,
  ]);
  const file = new File([exifBytes], `orientation-${orientation}.jpg`, {
    type: 'image/jpeg',
  });
  sourceImages.set(file, {
    rawWidth,
    rawHeight,
    orientation,
    corners: rawCorners,
  });
  return file;
}

function decodePayload(data: Uint8Array): EncodedCanvasPayload {
  return JSON.parse(new TextDecoder().decode(data)) as EncodedCanvasPayload;
}

describe('thumbnail generator EXIF orientation', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    vi.clearAllMocks();

    globalThis.createImageBitmap = vi.fn(
      (blob: Blob, options?: ImageBitmapOptions) => {
        const info = sourceImages.get(blob);
        if (!info) {
          throw new Error('Missing source image metadata for bitmap mock');
        }

        const autoOrient =
          options?.imageOrientation === undefined ||
          options.imageOrientation === 'from-image';
        const shouldSwap =
          autoOrient && orientationSwapsDimensions(info.orientation);
        const bitmap: MockBitmap = {
          width: shouldSwap ? info.rawHeight : info.rawWidth,
          height: shouldSwap ? info.rawWidth : info.rawHeight,
          sourceCorners: info.corners,
          close: vi.fn(),
        };
        return Promise.resolve(bitmap as unknown as ImageBitmap);
      },
    ) as unknown as typeof globalThis.createImageBitmap;

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return new MockCanvas() as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });
  });

  afterEach(() => {
    if (originalCreateImageBitmap) {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    } else {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
    vi.restoreAllMocks();
  });

  it('test double simulates browser default EXIF auto-orientation', async () => {
    const file = createExifJpegFile(6);

    const autoOriented = await createImageBitmap(file);
    const explicitAutoOriented = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    });
    const rawRaster = await createImageBitmap(file, { imageOrientation: 'none' });

    expect(autoOriented.width).toBe(800);
    expect(autoOriented.height).toBe(1200);
    expect(explicitAutoOriented.width).toBe(800);
    expect(explicitAutoOriented.height).toBe(1200);
    expect(rawRaster.width).toBe(1200);
    expect(rawRaster.height).toBe(800);

    autoOriented.close();
    explicitAutoOriented.close();
    rawRaster.close();
  });

  it.each([
    {
      orientation: 1,
      expectedWidth: 300,
      expectedHeight: 200,
      expectedCorners: rawCorners,
      expectedOriginalWidth: 1200,
      expectedOriginalHeight: 800,
    },
    {
      orientation: 3,
      expectedWidth: 300,
      expectedHeight: 200,
      expectedCorners: orientedCorners(rawCorners, 3),
      expectedOriginalWidth: 1200,
      expectedOriginalHeight: 800,
    },
    {
      orientation: 6,
      expectedWidth: 200,
      expectedHeight: 300,
      expectedCorners: orientedCorners(rawCorners, 6),
      expectedOriginalWidth: 800,
      expectedOriginalHeight: 1200,
    },
    {
      orientation: 8,
      expectedWidth: 200,
      expectedHeight: 300,
      expectedCorners: orientedCorners(rawCorners, 8),
      expectedOriginalWidth: 800,
      expectedOriginalHeight: 1200,
    },
  ])(
    'keeps raw raster bitmap dimensions for EXIF orientation $orientation',
    async ({
      orientation,
      expectedWidth,
      expectedHeight,
      expectedCorners,
      expectedOriginalWidth,
      expectedOriginalHeight,
    }) => {
      const file = createExifJpegFile(orientation);

      const result = await generateThumbnail(file, { maxSize: 300 });
      const payload = decodePayload(result.data);

      expect(globalThis.createImageBitmap).toHaveBeenCalledWith(file, {
        imageOrientation: 'none',
      });
      expect(result.width).toBe(expectedWidth);
      expect(result.height).toBe(expectedHeight);
      expect(result.originalWidth).toBe(expectedOriginalWidth);
      expect(result.originalHeight).toBe(expectedOriginalHeight);
      expect(payload.width).toBe(expectedWidth);
      expect(payload.height).toBe(expectedHeight);
      expect(payload.corners).toEqual(expectedCorners);
    },
  );
});
